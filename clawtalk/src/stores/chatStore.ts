import { create } from "zustand";
import type {
  ChatEvent,
  ChatHistoryResult,
  Message,
} from "../gateway/types.ts";
import { ResponseClient, type InputContentPart } from "../gateway/responses.ts";
import { useConnectionStore } from "./connectionStore.ts";

// Singleton ResponseClient — configured when the connection is established
export const responseClient = new ResponseClient("", undefined);

type ChatState = {
  sessionKey: string;
  messages: Message[];
  streamingText: string | null;
  error: string | null;
  loading: boolean;
  sending: boolean;
  abortController: AbortController | null;

  // Actions
  setSessionKey: (key: string) => void;
  loadHistory: () => Promise<void>;
  sendMessage: (text: string, attachments?: File[]) => Promise<void>;
  abort: () => Promise<void>;
  handleChatEvent: (payload: ChatEvent) => void;
  clearError: () => void;
};

export const useChatStore = create<ChatState>((set, get) => ({
  sessionKey: "main",
  messages: [],
  streamingText: null,
  error: null,
  loading: false,
  sending: false,
  abortController: null,

  setSessionKey: (key: string) => {
    set({ sessionKey: key, messages: [], streamingText: null, error: null, abortController: null });
  },

  loadHistory: async () => {
    const client = useConnectionStore.getState().client;
    if (!client?.connected) return;

    set({ loading: true, error: null });
    try {
      const result = await client.request<ChatHistoryResult>("chat.history", {
        sessionKey: get().sessionKey,
        limit: 200,
      });
      set({
        messages: Array.isArray(result.messages) ? result.messages : [],
        loading: false,
      });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  sendMessage: async (text: string, attachments?: File[]) => {
    const trimmed = text.trim();
    const hasAttachments = attachments && attachments.length > 0;
    if (!trimmed && !hasAttachments) return;

    const { sessionKey } = get();
    const abortController = new AbortController();

    // Optimistically add user message
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: trimmed }],
      timestamp: Date.now(),
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      sending: true,
      error: null,
      streamingText: "",
      abortController,
    }));

    // Build OpenResponses input with attachments
    const contentParts: InputContentPart[] = [];
    if (trimmed) {
      contentParts.push({ type: "input_text", text: trimmed });
    }

    if (hasAttachments) {
      for (const file of attachments) {
        const part = await fileToInputPart(file);
        if (part) contentParts.push(part);
      }
    }

    const input = contentParts.length === 1 && contentParts[0].type === "input_text"
      ? trimmed // Simple string for text-only sends
      : [{ role: "user" as const, content: contentParts }];

    await responseClient.send({
      input,
      sessionKey,
      signal: abortController.signal,
      onDelta: (accumulated) => {
        set({ streamingText: accumulated });
      },
      onComplete: () => {
        set({ streamingText: null, sending: false, abortController: null });
        get().loadHistory();
      },
      onError: (error) => {
        set({
          streamingText: null,
          sending: false,
          abortController: null,
          error,
        });
      },
    });
  },

  abort: async () => {
    // Abort the HTTP SSE stream
    const { abortController, sessionKey } = get();
    if (abortController) {
      abortController.abort();
      set({ streamingText: null, sending: false, abortController: null });
    }

    // Also send abort via WebSocket for server-side cleanup
    const client = useConnectionStore.getState().client;
    if (client?.connected) {
      try {
        await client.request("chat.abort", { sessionKey });
      } catch {
        // Best-effort
      }
    }

    get().loadHistory();
  },

  handleChatEvent: (payload: ChatEvent) => {
    const { sessionKey } = get();

    // Ignore events for other sessions
    if (payload.sessionKey !== sessionKey) return;

    // Handle final/aborted events from server (e.g. sub-agent, server-side abort)
    if (payload.state === "final" || payload.state === "aborted") {
      get().loadHistory();
    }
    if (payload.state === "error") {
      set({ error: payload.errorMessage ?? "Chat error" });
    }
  },

  clearError: () => set({ error: null }),
}));

// ── Helpers ──

async function fileToInputPart(file: File): Promise<InputContentPart | null> {
  const buffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), "")
  );
  const mime = file.type;

  // Images → input_image
  if (mime.startsWith("image/")) {
    return {
      type: "input_image",
      source: { type: "base64", media_type: mime, data: base64 },
    };
  }

  // Documents → input_file (PDFs, text, markdown, HTML, CSV, JSON)
  const allowedMimes = [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/html",
    "text/csv",
    "application/json",
  ];
  if (allowedMimes.includes(mime)) {
    return {
      type: "input_file",
      source: { type: "base64", media_type: mime, data: base64 },
      filename: file.name,
    };
  }

  // Unsupported type
  return null;
}

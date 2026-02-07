import { create } from "zustand";
import type {
  ChatEvent,
  ChatHistoryResult,
  Message,
} from "../gateway/types.ts";
import { useConnectionStore } from "./connectionStore.ts";

type ChatState = {
  sessionKey: string;
  messages: Message[];
  streamingText: string | null;
  streamingRunId: string | null;
  error: string | null;
  loading: boolean;
  sending: boolean;

  // Actions
  setSessionKey: (key: string) => void;
  loadHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  handleChatEvent: (payload: ChatEvent) => void;
  clearError: () => void;
};

export const useChatStore = create<ChatState>((set, get) => ({
  sessionKey: "main",
  messages: [],
  streamingText: null,
  streamingRunId: null,
  error: null,
  loading: false,
  sending: false,

  setSessionKey: (key: string) => {
    set({ sessionKey: key, messages: [], streamingText: null, streamingRunId: null, error: null });
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

  sendMessage: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const client = useConnectionStore.getState().client;
    if (!client?.connected) return;

    const { sessionKey } = get();
    const idempotencyKey = crypto.randomUUID();

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
      streamingRunId: idempotencyKey,
    }));

    try {
      await client.request("chat.send", {
        sessionKey,
        message: trimmed,
        deliver: false,
        idempotencyKey,
      });
    } catch (err) {
      set({
        sending: false,
        streamingText: null,
        streamingRunId: null,
        error: String(err),
      });
    } finally {
      set({ sending: false });
    }
  },

  abort: async () => {
    const client = useConnectionStore.getState().client;
    if (!client?.connected) return;

    const { sessionKey, streamingRunId } = get();
    try {
      await client.request("chat.abort", {
        sessionKey,
        ...(streamingRunId ? { runId: streamingRunId } : {}),
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  handleChatEvent: (payload: ChatEvent) => {
    const { sessionKey, streamingRunId } = get();

    // Ignore events for other sessions
    if (payload.sessionKey !== sessionKey) return;

    // Handle final events from other runs (e.g. sub-agent) by refreshing history
    if (payload.runId && streamingRunId && payload.runId !== streamingRunId) {
      if (payload.state === "final") {
        get().loadHistory();
      }
      return;
    }

    switch (payload.state) {
      case "delta": {
        // Server sends full accumulated text, not incremental
        const text = extractText(payload.message);
        if (typeof text === "string") {
          const current = get().streamingText ?? "";
          // Only update if new text is longer (monotonic)
          if (!current || text.length >= current.length) {
            set({ streamingText: text });
          }
        }
        break;
      }
      case "final":
        set({ streamingText: null, streamingRunId: null });
        // Reload history to get the persisted version
        get().loadHistory();
        break;
      case "aborted":
        set({ streamingText: null, streamingRunId: null });
        get().loadHistory();
        break;
      case "error":
        set({
          streamingText: null,
          streamingRunId: null,
          error: payload.errorMessage ?? "Chat error",
        });
        break;
    }
  },

  clearError: () => set({ error: null }),
}));

// ── Helpers ──

function extractText(message?: Message): string | null {
  if (!message?.content) return null;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

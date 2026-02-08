/**
 * ResponseClient — HTTP + SSE client for OpenResponses API.
 *
 * Sends chat messages via POST /v1/responses with SSE streaming.
 * Supports full media input (images, PDFs, text files, etc.).
 * Bridges to WebSocket sessions via x-openclaw-session-key header.
 */

// ── SSE event types ──

export type ResponseSSEEvent =
  | { type: "response.created"; response: ResponseObject }
  | { type: "response.in_progress"; response: ResponseObject }
  | { type: "response.output_item.added"; item: OutputItem }
  | { type: "response.content_part.added"; part: ContentPart }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.output_text.done"; text: string }
  | { type: "response.content_part.done"; part: ContentPart }
  | { type: "response.output_item.done"; item: OutputItem }
  | { type: "response.completed"; response: ResponseObject }
  | { type: "response.failed"; response: ResponseObject };

export type ResponseObject = {
  id: string;
  object: "response";
  status: "in_progress" | "completed" | "failed" | "incomplete";
  output: OutputItem[];
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  error?: { code: string; message: string };
};

export type OutputItem = {
  type: "message" | "function_call";
  id: string;
  role?: string;
  content?: ContentPart[];
};

export type ContentPart = {
  type: "output_text";
  text: string;
};

// ── Input types for building requests ──

export type InputItem =
  | string
  | InputMessage[];

export type InputMessage = {
  role: "user" | "system" | "developer" | "assistant";
  content: string | InputContentPart[];
};

export type InputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url?: string; source?: { type: "base64"; media_type: string; data: string } }
  | { type: "input_file"; source: { type: "base64"; media_type: string; data: string }; filename?: string };

// ── Send options ──

export type SendOptions = {
  input: InputItem;
  sessionKey: string;
  model?: string;
  onDelta: (text: string) => void;
  onComplete: (response: ResponseObject) => void;
  onError: (error: string) => void;
  signal?: AbortSignal;
};

// ── Client ──

export class ResponseClient {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  updateConfig(baseUrl: string, token?: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async send(opts: SendOptions): Promise<void> {
    const url = `${this.baseUrl}/v1/responses`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-openclaw-session-key": opts.sessionKey,
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const body = JSON.stringify({
      model: opts.model ?? "openclaw",
      input: opts.input,
      stream: true,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) return;
      opts.onError(`Network error: ${err}`);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      opts.onError(`HTTP ${response.status}: ${text}`);
      return;
    }

    if (!response.body) {
      opts.onError("No response body");
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const event = { type: eventType, ...parsed } as ResponseSSEEvent;

              switch (event.type) {
                case "response.output_text.delta":
                  accumulated += event.delta;
                  opts.onDelta(accumulated);
                  break;
                case "response.completed":
                  opts.onComplete(event.response);
                  return;
                case "response.failed":
                  opts.onError(
                    event.response.error?.message ?? "Response failed"
                  );
                  return;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      opts.onError(`Stream error: ${err}`);
    }
  }
}

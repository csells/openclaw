import type { EventFrame, HelloOk, ResponseFrame } from "./types.ts";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientId?: string;
  clientVersion?: string;
  onHello: (hello: HelloOk) => void;
  onEvent: (event: string, payload: unknown, seq?: number) => void;
  onDisconnect: (reason: string) => void;
  onReconnecting: (attemptMs: number) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 15_000;
const BACKOFF_FACTOR = 1.7;
const CHALLENGE_WAIT_MS = 750;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private backoffMs = INITIAL_BACKOFF_MS;
  private lastSeq: number | null = null;
  private closed = false;
  private connectNonce: string | null = null;
  private connectSent = false;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: GatewayClientOptions) {}

  // ── Lifecycle ──

  start(): void {
    this.closed = false;
    this.openSocket();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.challengeTimer !== null) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client stopped"));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Request/Response ──

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = crypto.randomUUID();
    const frame = { type: "req" as const, id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  // ── Internal: socket management ──

  private openSocket(): void {
    if (this.closed) return;

    this.connectNonce = null;
    this.connectSent = false;

    this.ws = new WebSocket(this.opts.url);

    this.ws.addEventListener("open", () => {
      // Wait for challenge event, but if none arrives send connect anyway
      this.challengeTimer = setTimeout(() => {
        this.sendConnect();
      }, CHALLENGE_WAIT_MS);
    });

    this.ws.addEventListener("message", (ev) => {
      this.handleMessage(String(ev.data ?? ""));
    });

    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason || `code ${ev.code}`);
      this.ws = null;
      if (this.challengeTimer !== null) {
        clearTimeout(this.challengeTimer);
        this.challengeTimer = null;
      }
      this.flushPending(new Error(`disconnected: ${reason}`));
      this.opts.onDisconnect(reason);
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // close handler will fire
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    this.opts.onReconnecting(delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private sendConnect(): void {
    if (this.connectSent) return;
    this.connectSent = true;

    if (this.challengeTimer !== null) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }

    const auth =
      this.opts.token || this.opts.password
        ? { token: this.opts.token, password: this.opts.password }
        : undefined;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientId ?? "openclaw-webchat",
        version: this.opts.clientVersion ?? "0.1.0",
        platform: "web",
        mode: "webchat",
        instanceId: crypto.randomUUID(),
      },
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      caps: [],
      auth,
      nonce: this.connectNonce ?? undefined,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    this.request<HelloOk>("connect", params)
      .then((hello) => {
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.opts.onHello(hello);
      })
      .catch(() => {
        this.ws?.close(4008, "connect failed");
      });
  }

  // ── Internal: message handling ──

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: string };

    if (frame.type === "event") {
      const evt = parsed as EventFrame;

      // Handle challenge
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        if (payload?.nonce) {
          this.connectNonce = payload.nonce;
          this.sendConnect();
        }
        return;
      }

      // Track sequence numbers for gap detection
      if (typeof evt.seq === "number") {
        if (
          this.lastSeq !== null &&
          evt.seq > this.lastSeq + 1
        ) {
          this.opts.onEvent("_gap", {
            expected: this.lastSeq + 1,
            received: evt.seq,
          });
        }
        this.lastSeq = evt.seq;
      }

      this.opts.onEvent(evt.event, evt.payload, evt.seq);
      return;
    }

    if (frame.type === "res") {
      const res = parsed as ResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;

      this.pending.delete(res.id);
      clearTimeout(pending.timer);

      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new Error(res.error?.message ?? "request failed")
        );
      }
    }
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

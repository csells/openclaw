import { create } from "zustand";
import { GatewayClient } from "../gateway/client.ts";
import type { HelloOk } from "../gateway/types.ts";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

type ConnectionState = {
  status: ConnectionStatus;
  hello: HelloOk | null;
  error: string | null;
  reconnectMs: number | null;
  client: GatewayClient | null;

  // Derived from hello
  mainSessionKey: string;
  defaultAgentId: string;

  // Actions
  connect: (url: string, token?: string, password?: string) => void;
  disconnect: () => void;
};

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: "disconnected",
  hello: null,
  error: null,
  reconnectMs: null,
  client: null,
  mainSessionKey: "main",
  defaultAgentId: "default",

  connect: (url: string, token?: string, password?: string) => {
    const existing = get().client;
    if (existing) {
      existing.stop();
    }

    set({ status: "connecting", error: null });

    const client = new GatewayClient({
      url,
      token,
      password,
      onHello: (hello: HelloOk) => {
        set({
          status: "connected",
          hello,
          error: null,
          reconnectMs: null,
          mainSessionKey:
            hello.sessionDefaults?.mainSessionKey ??
            hello.sessionDefaults?.mainKey ??
            "main",
          defaultAgentId:
            hello.sessionDefaults?.defaultAgentId ?? "default",
        });
      },
      onEvent: (event: string, payload: unknown, seq?: number) => {
        // Broadcast events to subscribers
        const listeners = eventListeners.get(event);
        if (listeners) {
          for (const fn of listeners) {
            fn(payload, seq);
          }
        }

        // Also broadcast to wildcard listeners
        const wildcardListeners = eventListeners.get("*");
        if (wildcardListeners) {
          for (const fn of wildcardListeners) {
            fn(payload, seq, event);
          }
        }
      },
      onDisconnect: (reason: string) => {
        set({ status: "reconnecting", error: reason });
      },
      onReconnecting: (attemptMs: number) => {
        set({ reconnectMs: attemptMs });
      },
    });

    set({ client });
    client.start();
  },

  disconnect: () => {
    const { client } = get();
    if (client) {
      client.stop();
    }
    set({
      status: "disconnected",
      client: null,
      hello: null,
      error: null,
      reconnectMs: null,
    });
  },
}));

// ── Event bus for protocol events ──

type EventListener = (payload: unknown, seq?: number, event?: string) => void;
const eventListeners = new Map<string, Set<EventListener>>();

export function onGatewayEvent(
  event: string,
  fn: EventListener
): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
  }
  listeners.add(fn);
  return () => {
    listeners!.delete(fn);
    if (listeners!.size === 0) {
      eventListeners.delete(event);
    }
  };
}

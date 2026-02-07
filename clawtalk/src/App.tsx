import { useEffect } from "react";
import {
  useConnectionStore,
  onGatewayEvent,
} from "./stores/connectionStore.ts";
import { useChatStore } from "./stores/chatStore.ts";
import { loadAuth, getDefaultGatewayUrl, getDefaultToken } from "./gateway/auth.ts";
import { Layout } from "./components/Layout.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { Composer } from "./components/Composer.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import type { ChatEvent } from "./gateway/types.ts";

export function App() {
  const status = useConnectionStore((s) => s.status);
  const connect = useConnectionStore((s) => s.connect);

  // Auto-connect on mount using saved or env auth
  useEffect(() => {
    const saved = loadAuth();
    const url = saved?.gatewayUrl ?? getDefaultGatewayUrl();
    const token = saved?.token ?? getDefaultToken();

    if (url) {
      connect(url, token);
    }
  }, [connect]);

  // Subscribe to chat events and load history on connect
  useEffect(() => {
    const handleChatEvent = useChatStore.getState().handleChatEvent;

    const unsubChat = onGatewayEvent("chat", (payload) => {
      handleChatEvent(payload as ChatEvent);
    });

    // Load history when connected
    let prevStatus = useConnectionStore.getState().status;
    const unsubConnection = useConnectionStore.subscribe((state) => {
      if (state.status === "connected" && prevStatus !== "connected") {
        const mainKey = state.mainSessionKey;
        const chatState = useChatStore.getState();
        if (chatState.sessionKey !== mainKey) {
          chatState.setSessionKey(mainKey);
        }
        chatState.loadHistory();
      }
      prevStatus = state.status;
    });

    return () => {
      unsubChat();
      unsubConnection();
    };
  }, []);

  // Show auth gate if disconnected and no saved credentials
  if (status === "disconnected") {
    return <AuthGate />;
  }

  return (
    <Layout>
      <ChatView />
      <Composer />
    </Layout>
  );
}

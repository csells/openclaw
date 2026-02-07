import { useChatStore } from "../stores/chatStore.ts";
import { useAutoScroll } from "../hooks/useAutoScroll.ts";
import { MessageBubble } from "./MessageBubble.tsx";
import { StreamingIndicator } from "./StreamingIndicator.tsx";
import type { Message } from "../gateway/types.ts";

export function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const loading = useChatStore((s) => s.loading);
  const error = useChatStore((s) => s.error);
  const clearError = useChatStore((s) => s.clearError);

  const { containerRef, handleScroll } = useAutoScroll([
    messages,
    streamingText,
  ]);

  // Build a temporary streaming message for display
  const streamingMessage: Message | null =
    streamingText !== null
      ? {
          role: "assistant",
          content: [{ type: "text", text: streamingText }],
        }
      : null;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-6"
    >
      {loading && (
        <div className="flex justify-center py-8">
          <div className="text-gray-500 flex items-center gap-2">
            <StreamingIndicator /> Loading history...
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/50 border border-red-700 px-4 py-3 text-red-200 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={clearError}
            className="text-red-400 hover:text-red-200 ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {!loading && messages.length === 0 && !streamingMessage && (
        <div className="flex flex-col items-center justify-center h-full text-gray-500">
          <p className="text-lg">Start a conversation</p>
          <p className="text-sm mt-1">Type a message below to begin</p>
        </div>
      )}

      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}

      {streamingMessage && (
        <MessageBubble message={streamingMessage} isStreaming />
      )}
    </div>
  );
}

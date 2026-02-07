import { useCallback, useRef, type KeyboardEvent, type FormEvent } from "react";
import { useChatStore } from "../stores/chatStore.ts";

export function Composer() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abort = useChatStore((s) => s.abort);
  const streamingRunId = useChatStore((s) => s.streamingRunId);
  const sending = useChatStore((s) => s.sending);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isStreaming = streamingRunId !== null;

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      if (isStreaming) {
        abort();
        return;
      }
      const text = inputRef.current?.value ?? "";
      if (!text.trim()) return;

      // Handle stop/abort commands
      const lower = text.trim().toLowerCase();
      if (lower === "/stop" || lower === "stop" || lower === "abort" || lower === "/abort") {
        abort();
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      sendMessage(text);
      if (inputRef.current) inputRef.current.value = "";
    },
    [sendMessage, abort, isStreaming]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter inserts newline
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      // Escape aborts
      if (e.key === "Escape" && isStreaming) {
        abort();
      }
    },
    [handleSubmit, abort, isStreaming]
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-gray-800 bg-gray-900 px-4 py-3"
    >
      <div className="flex items-end gap-3 max-w-4xl mx-auto">
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={isStreaming ? "Waiting for response..." : "Type a message..."}
          disabled={sending}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
          style={{ maxHeight: "120px" }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 120) + "px";
          }}
        />
        <button
          type="submit"
          className={`rounded-xl px-5 py-2.5 font-medium transition-colors ${
            isStreaming
              ? "bg-red-600 hover:bg-red-500 text-white"
              : "bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          }`}
          disabled={sending && !isStreaming}
        >
          {isStreaming ? "Stop" : "Send"}
        </button>
      </div>
    </form>
  );
}

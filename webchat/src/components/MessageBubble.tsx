import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../gateway/types.ts";
import { StreamingIndicator } from "./StreamingIndicator.tsx";

type Props = {
  message: Message;
  isStreaming?: boolean;
};

export function MessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === "user";

  const text = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-indigo-600 text-white"
            : "bg-gray-800 text-gray-100"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{text}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none break-words">
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
            {isStreaming && (
              <span className="inline-block ml-1">
                <StreamingIndicator />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

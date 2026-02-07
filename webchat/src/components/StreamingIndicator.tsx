export function StreamingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 text-gray-400">
      <span className="inline-block w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
      <span
        className="inline-block w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="inline-block w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

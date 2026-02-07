import { useConnectionStore } from "../stores/connectionStore.ts";

export function ConnectionStatus() {
  const status = useConnectionStore((s) => s.status);
  const error = useConnectionStore((s) => s.error);
  const reconnectMs = useConnectionStore((s) => s.reconnectMs);

  if (status === "connected") return null;

  const statusText = (() => {
    switch (status) {
      case "connecting":
        return "Connecting...";
      case "reconnecting":
        return reconnectMs
          ? `Reconnecting in ${Math.round(reconnectMs / 1000)}s...`
          : "Reconnecting...";
      case "disconnected":
        return "Disconnected";
    }
  })();

  const bgColor =
    status === "connecting"
      ? "bg-yellow-600"
      : status === "reconnecting"
        ? "bg-orange-600"
        : "bg-red-600";

  return (
    <div className={`${bgColor} text-white text-sm text-center py-1.5 px-4`}>
      <span>{statusText}</span>
      {error && <span className="ml-2 opacity-75">({error})</span>}
    </div>
  );
}

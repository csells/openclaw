import type { ReactNode } from "react";
import { useConnectionStore } from "../stores/connectionStore.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";

type Props = {
  children: ReactNode;
};

export function Layout({ children }: Props) {
  return (
    <div className="flex flex-col h-screen bg-gray-950">
      <ConnectionStatus />
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">ClawTalk</h1>
        <div className="flex items-center gap-2">
          <ConnectedDot />
        </div>
      </header>
      {children}
    </div>
  );
}

function ConnectedDot() {
  const status = useConnectionStore((s) => s.status);

  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting" || status === "reconnecting"
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-400">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {status === "connected" ? "Connected" : status}
    </span>
  );
}

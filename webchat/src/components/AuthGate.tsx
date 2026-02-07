import { useCallback, useRef, type FormEvent } from "react";
import { getDefaultGatewayUrl, saveAuth } from "../gateway/auth.ts";
import { useConnectionStore } from "../stores/connectionStore.ts";

export function AuthGate() {
  const connect = useConnectionStore((s) => s.connect);
  const urlRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const url = urlRef.current?.value?.trim() || getDefaultGatewayUrl();
      const token = tokenRef.current?.value?.trim() || undefined;

      saveAuth({ gatewayUrl: url, token });
      connect(url, token);
    },
    [connect]
  );

  return (
    <div className="flex items-center justify-center h-screen bg-gray-950">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-md shadow-xl"
      >
        <h2 className="text-xl font-semibold text-gray-100 mb-6">
          Connect to Gateway
        </h2>

        <label className="block mb-4">
          <span className="text-sm text-gray-400 mb-1 block">
            Gateway URL
          </span>
          <input
            ref={urlRef}
            type="text"
            placeholder={getDefaultGatewayUrl()}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </label>

        <label className="block mb-6">
          <span className="text-sm text-gray-400 mb-1 block">
            Gateway Token (optional)
          </span>
          <input
            ref={tokenRef}
            type="password"
            placeholder="Enter token..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </label>

        <button
          type="submit"
          className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 transition-colors"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

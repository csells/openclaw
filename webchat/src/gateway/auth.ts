const STORAGE_KEY = "openclaw-webchat-auth";

export type StoredAuth = {
  gatewayUrl: string;
  token?: string;
  password?: string;
};

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getDefaultGatewayUrl(): string {
  // Check Vite env var first, then fall back to current host on port 4080
  const envUrl = import.meta.env.VITE_GATEWAY_URL as string | undefined;
  if (envUrl) return envUrl;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.hostname}:4080`;
}

export function getDefaultToken(): string | undefined {
  return (import.meta.env.VITE_GATEWAY_TOKEN as string | undefined) || undefined;
}

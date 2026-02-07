# OpenClaw Gateway Chat Protocol — Complete Client Integration Guide

> **Purpose**: Comprehensive reference for building a full-featured, modern AI chat web client
> on top of the OpenClaw Gateway WebSocket protocol. Covers every protocol detail needed to
> implement multi-chat, model switching, streaming text/tool results, multimedia I/O,
> responsive UI, and more.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Transport & Framing](#2-transport--framing)
3. [Connection Lifecycle & Handshake](#3-connection-lifecycle--handshake)
4. [Authentication & Device Identity](#4-authentication--device-identity)
5. [Chat Methods (Core RPC)](#5-chat-methods-core-rpc)
6. [Session Management](#6-session-management)
7. [Streaming: Chat Events & Agent Events](#7-streaming-chat-events--agent-events)
8. [Model Switching & Agent Selection](#8-model-switching--agent-selection)
9. [Multimedia Input: Image Attachments](#9-multimedia-input-image-attachments)
10. [OpenResponses HTTP API (Alternative)](#10-openresponses-http-api-alternative)
11. [Error Handling & Error Codes](#11-error-handling--error-codes)
12. [Reconnection & Resilience](#12-reconnection--resilience)
13. [Presence & Server State](#13-presence--server-state)
14. [Message Format & Content Blocks](#14-message-format--content-blocks)
15. [Tool Events & Verbose Levels](#15-tool-events--verbose-levels)
16. [Stop / Abort / Reset Commands](#16-stop--abort--reset-commands)
17. [Client Capabilities & Caps](#17-client-capabilities--caps)
18. [Sequence Numbers & Gap Detection](#18-sequence-numbers--gap-detection)
19. [Tick / Heartbeat Protocol](#19-tick--heartbeat-protocol)
20. [Full Client Implementation Checklist](#20-full-client-implementation-checklist)
21. [Reference: Key Source Files](#21-reference-key-source-files)

---

## 1. Architecture Overview

```
┌──────────────────────────────┐
│   Custom Web Chat Client     │  ← Your application
│  (React / Vue / Svelte etc.) │
└──────────────┬───────────────┘
               │ WebSocket (JSON text frames)
               ▼
┌──────────────────────────────┐
│   OpenClaw Gateway Server    │  ← Central control plane
│  (Node.js, ws library)       │
│                              │
│  ┌─────────┐ ┌────────────┐ │
│  │ Chat RPC│ │ Session DB │ │
│  │ Methods │ │ (JSONL)    │ │
│  └─────────┘ └────────────┘ │
│  ┌─────────┐ ┌────────────┐ │
│  │ Agent   │ │ Model      │ │
│  │ Runtime │ │ Catalog    │ │
│  └─────────┘ └────────────┘ │
└──────────────────────────────┘
```

**All clients** — CLI, web UI, macOS/iOS apps, Android — connect over the **same WebSocket
protocol** (protocol version 3 as of this writing). The protocol is a JSON-over-WebSocket
RPC + event-streaming system. There is no REST API for chat — the WebSocket is the primary
interface.

Additionally, the gateway exposes two HTTP APIs:
- **OpenAI-compatible**: `POST /v1/chat/completions` (SSE streaming)
- **OpenResponses**: `POST /v1/responses` (SSE streaming, tool use, structured I/O)

These HTTP APIs are useful for programmatic/API access but lack the real-time bidirectional
features of the WebSocket protocol (presence, agent events, tool streams, session management).

---

## 2. Transport & Framing

### Transport
- **WebSocket**, text frames with JSON payloads
- No binary frames — all data is JSON-serialized strings
- The first frame after connection **must** be a `connect` request (after receiving the challenge)

### Frame Types

There are exactly **three** frame types, discriminated by the `type` field:

#### Request Frame
```typescript
{
  type: "req";
  id: string;       // Unique UUID for request-response correlation
  method: string;    // RPC method name (e.g., "chat.send", "sessions.list")
  params?: unknown;  // Method-specific parameters
}
```

#### Response Frame
```typescript
{
  type: "res";
  id: string;        // Matches the request id
  ok: boolean;       // true = success, false = error
  payload?: unknown;  // Method-specific response data (when ok=true)
  error?: {           // Error details (when ok=false)
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
}
```

#### Event Frame
```typescript
{
  type: "event";
  event: string;           // Event name (e.g., "chat", "agent", "tick")
  payload?: unknown;       // Event-specific data
  seq?: number;            // Monotonically increasing sequence number
  stateVersion?: {         // Server state version for optimistic updates
    presence: number;
    health: number;
  };
}
```

### Key Design Principles
- **Request-Response**: Every `req` frame gets exactly one `res` frame with a matching `id`
- **Events**: Server pushes events asynchronously (no request needed)
- **Idempotency**: Side-effecting methods require an `idempotencyKey` to prevent duplicates

---

## 3. Connection Lifecycle & Handshake

### Step-by-step Connection Flow

```
Client                              Gateway
  │                                    │
  │──── WebSocket OPEN ────────────────│
  │                                    │
  │◄──── event: connect.challenge ─────│  (1) Server sends challenge nonce
  │                                    │
  │──── req: connect ──────────────────│  (2) Client sends connect with auth
  │                                    │
  │◄──── res: hello-ok ───────────────│  (3) Server confirms, sends snapshot
  │                                    │
  │◄──── event: tick ─────────────────│  (4) Periodic heartbeats begin
  │                                    │
  │──── req: chat.send ───────────────│  (5) Normal RPC begins
  │◄──── res: {runId, status} ────────│
  │◄──── event: chat (delta) ─────────│
  │◄──── event: chat (final) ─────────│
  │                                    │
```

### Step 1: Receive Challenge

After WebSocket `open`, the gateway immediately sends:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "random-server-nonce", "ts": 1737264000000 }
}
```

**Important**: The browser client waits up to 750ms for this challenge. If no challenge
arrives, it sends the connect request anyway (for backwards compatibility).

### Step 2: Send Connect Request

```json
{
  "type": "req",
  "id": "uuid-1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "openclaw-control-ui",
      "version": "1.0.0",
      "platform": "web",
      "mode": "webchat",
      "instanceId": "unique-tab-id"
    },
    "role": "operator",
    "scopes": ["operator.admin", "operator.approvals", "operator.pairing"],
    "caps": [],
    "auth": {
      "token": "your-gateway-token"
    },
    "device": {
      "id": "sha256-fingerprint-of-public-key",
      "publicKey": "base64url-ed25519-public-key",
      "signature": "base64url-ed25519-signature",
      "signedAt": 1737264000000,
      "nonce": "server-challenge-nonce"
    },
    "userAgent": "Mozilla/5.0 ...",
    "locale": "en-US"
  }
}
```

#### Connect Params Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `minProtocol` | integer | Yes | Minimum protocol version (currently `3`) |
| `maxProtocol` | integer | Yes | Maximum protocol version (currently `3`) |
| `client.id` | string enum | Yes | Client identifier (see [Client IDs](#client-identifiers)) |
| `client.version` | string | Yes | Client version string |
| `client.platform` | string | Yes | Platform (e.g., `"web"`, `navigator.platform`) |
| `client.mode` | string enum | Yes | Client mode (see [Client Modes](#client-modes)) |
| `client.displayName` | string | No | Human-readable client name |
| `client.instanceId` | string | No | Unique per-tab/window identifier |
| `role` | string | No | `"operator"` for chat clients, `"node"` for capability hosts |
| `scopes` | string[] | No | Permission scopes (see [Scopes](#scopes)) |
| `caps` | string[] | No | Client capabilities (e.g., `["tool-events"]`) |
| `auth.token` | string | No | Gateway authentication token |
| `auth.password` | string | No | Gateway password (alternative to token) |
| `device` | object | No* | Device identity for secure auth (*required on HTTPS) |
| `locale` | string | No | User locale (e.g., `"en-US"`) |
| `userAgent` | string | No | Browser user agent string |

#### Client Identifiers
```typescript
const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
};
```

For a custom web client, use `"webchat-ui"` or `"openclaw-control-ui"`.

#### Client Modes
```typescript
const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",  // ← Use this for a chat web client
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
};
```

#### Scopes
For operator (chat) clients, request these scopes:
- `operator.read` — Read access to sessions, history, models
- `operator.write` — Write access (send messages, modify sessions)
- `operator.admin` — Full admin access
- `operator.approvals` — Approve exec requests
- `operator.pairing` — Manage device pairing

### Step 3: Receive Hello-Ok

```json
{
  "type": "res",
  "id": "uuid-1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": {
      "version": "1.2.3",
      "commit": "abc123",
      "host": "my-gateway",
      "connId": "unique-connection-id"
    },
    "features": {
      "methods": ["chat.send", "chat.history", "chat.abort", "sessions.list", ...],
      "events": ["chat", "agent", "tick", ...]
    },
    "snapshot": {
      "presence": [...],
      "health": {...},
      "stateVersion": { "presence": 1, "health": 1 },
      "uptimeMs": 123456,
      "sessionDefaults": {
        "defaultAgentId": "main",
        "mainKey": "main",
        "mainSessionKey": "main",
        "scope": "per-sender"
      }
    },
    "policy": {
      "maxPayload": 16777216,
      "maxBufferedBytes": 67108864,
      "tickIntervalMs": 15000
    },
    "auth": {
      "deviceToken": "issued-device-token",
      "role": "operator",
      "scopes": ["operator.admin", "operator.approvals", "operator.pairing"],
      "issuedAtMs": 1737264000000
    }
  }
}
```

#### Hello-Ok Payload

| Field | Type | Description |
|-------|------|-------------|
| `protocol` | number | Negotiated protocol version |
| `server.version` | string | Gateway server version |
| `server.connId` | string | Unique ID for this connection |
| `features.methods` | string[] | Available RPC methods |
| `features.events` | string[] | Available event types |
| `snapshot` | object | Current server state (presence, health, session defaults) |
| `snapshot.sessionDefaults` | object | Default agent ID and main session key |
| `policy.tickIntervalMs` | number | Expected heartbeat interval (ms) |
| `policy.maxPayload` | number | Maximum single-frame payload size (bytes) |
| `auth.deviceToken` | string | Issued device token — **persist this for future connects** |

---

## 4. Authentication & Device Identity

### Authentication Methods

The gateway supports three auth methods:

1. **Token auth**: Set `auth.token` in connect params. The token must match `OPENCLAW_GATEWAY_TOKEN` or the gateway config `gateway.auth.token`.

2. **Password auth**: Set `auth.password` in connect params. Matched against `gateway.auth.password`.

3. **Device token auth**: After initial pairing, the gateway issues a device token (in `hello-ok.auth.deviceToken`). Persist this and send it as `auth.token` on future connects.

### Device Identity (Required for HTTPS)

On secure contexts (HTTPS, localhost), the client must generate and persist an Ed25519 keypair:

```typescript
// Generate a device identity (one-time, persist in localStorage)
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

// 1. Generate keypair
const privateKey = utils.randomSecretKey();
const publicKey = await getPublicKeyAsync(privateKey);

// 2. Derive device ID from public key fingerprint
const hash = await crypto.subtle.digest("SHA-256", publicKey.buffer);
const deviceId = Array.from(new Uint8Array(hash))
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");

// 3. Store in localStorage
localStorage.setItem("openclaw-device-identity-v1", JSON.stringify({
  version: 1,
  deviceId,
  publicKey: base64UrlEncode(publicKey),
  privateKey: base64UrlEncode(privateKey),
  createdAtMs: Date.now()
}));
```

### Device Auth Payload Signing

When connecting, sign a payload that includes the server's challenge nonce:

```typescript
import { buildDeviceAuthPayload } from "openclaw/gateway/device-auth";

// The payload is a deterministic string containing:
// deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce
const payload = buildDeviceAuthPayload({
  deviceId: identity.deviceId,
  clientId: "openclaw-control-ui",
  clientMode: "webchat",
  role: "operator",
  scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
  signedAtMs: Date.now(),
  token: authToken ?? null,
  nonce: challengeNonce,  // from connect.challenge event
});

const signature = await signDevicePayload(identity.privateKey, payload);

// Include in connect params:
device: {
  id: identity.deviceId,
  publicKey: identity.publicKey,
  signature,
  signedAt: Date.now(),
  nonce: challengeNonce,
}
```

### Device Token Persistence

After a successful connect, if `hello-ok.auth.deviceToken` is present, persist it:

```typescript
// Store format in localStorage
const store = {
  version: 1,
  deviceId: identity.deviceId,
  tokens: {
    "operator": {
      token: hello.auth.deviceToken,
      role: hello.auth.role,
      scopes: hello.auth.scopes,
      updatedAtMs: Date.now()
    }
  }
};
localStorage.setItem("openclaw.device.auth.v1", JSON.stringify(store));
```

On subsequent connects, use the stored device token instead of the gateway token.

### Insecure Context Fallback

On plain HTTP (non-localhost), `crypto.subtle` is unavailable. The client falls back to
token-only auth. The gateway must have `gateway.controlUi.allowInsecureAuth` enabled, or
`gateway.controlUi.dangerouslyDisableDeviceAuth` for complete bypass.

---

## 5. Chat Methods (Core RPC)

### 5.1 `chat.send` — Send a Message

Send a user message to a session. The gateway runs the agent and streams results back as events.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.send",
  "params": {
    "sessionKey": "main",
    "message": "Hello, what can you help me with?",
    "thinking": "high",
    "deliver": false,
    "attachments": [
      {
        "type": "image",
        "mimeType": "image/png",
        "content": "base64-encoded-image-data"
      }
    ],
    "timeoutMs": 300000,
    "idempotencyKey": "unique-uuid-for-this-send"
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | string | Yes | Session to send to (e.g., `"main"`, `"agent:my-agent"`) |
| `message` | string | Yes | User message text (can be empty if attachments present) |
| `thinking` | string | No | Thinking/reasoning level: `"low"`, `"medium"`, `"high"` |
| `deliver` | boolean | No | If true, also deliver response to external channels |
| `attachments` | array | No | Image attachments (see [Multimedia Input](#9-multimedia-input-image-attachments)) |
| `timeoutMs` | integer | No | Agent execution timeout in milliseconds |
| `idempotencyKey` | string | Yes | Unique key to prevent duplicate sends. Use a UUID. |

**Response (immediate ack):**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "runId": "the-idempotency-key",
    "status": "started"
  }
}
```

The `runId` returned equals the `idempotencyKey` you sent. Use it to correlate streaming events.

**Possible statuses:**
- `"started"` — New run started
- `"in_flight"` — Duplicate idempotencyKey, run already active (cached response)
- `"ok"` — Run already completed (cached result)
- `"error"` — Run failed

After the ack, the agent runs asynchronously. Results arrive as `chat` and `agent` events.

### 5.2 `chat.history` — Load Conversation History

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.history",
  "params": {
    "sessionKey": "main",
    "limit": 200
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | string | Yes | Session to load history for |
| `limit` | integer | No | Max messages to return (1–1000, default 200, hard max 1000) |

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "sessionKey": "main",
    "sessionId": "uuid-of-session",
    "messages": [
      {
        "role": "user",
        "content": [{ "type": "text", "text": "Hello!" }],
        "timestamp": 1737264000000
      },
      {
        "role": "assistant",
        "content": [{ "type": "text", "text": "Hi! How can I help?" }],
        "timestamp": 1737264001000,
        "usage": { "input": 50, "output": 20, "totalTokens": 70 },
        "stopReason": "end_turn"
      }
    ],
    "thinkingLevel": "medium",
    "verboseLevel": "off"
  }
}
```

Messages are returned most-recent-last. The response also includes the session's current
`thinkingLevel` and `verboseLevel` settings.

**Important**: Messages are capped by JSON byte size (server constant, typically ~2MB).
Very long conversations will be truncated from the oldest messages.

### 5.3 `chat.abort` — Cancel an Active Run

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.abort",
  "params": {
    "sessionKey": "main",
    "runId": "optional-specific-run-id"
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | string | Yes | Session to abort runs for |
| `runId` | string | No | Specific run to abort. If omitted, aborts ALL runs for the session. |

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "ok": true,
    "aborted": true,
    "runIds": ["run-id-1"]
  }
}
```

### 5.4 `chat.inject` — Inject an Assistant Message (No Agent Run)

Directly append an assistant message to the transcript without triggering an agent run.
Useful for system messages, notes, or pre-canned responses.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.inject",
  "params": {
    "sessionKey": "main",
    "message": "This is an injected note.",
    "label": "System Note"
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | string | Yes | Target session |
| `message` | string | Yes | Message text to inject |
| `label` | string | No | Optional label prefix (max 100 chars) |

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": { "ok": true, "messageId": "short-uuid" }
}
```

The injected message is also broadcast as a `chat` event with `state: "final"`.

---

## 6. Session Management

Sessions are the core organizational unit for conversations. Each session has a unique
`sessionKey` (string identifier) and a `sessionId` (UUID for the current transcript).

### 6.1 `sessions.list` — List Sessions

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.list",
  "params": {
    "limit": 50,
    "activeMinutes": 120,
    "includeDerivedTitles": true,
    "includeLastMessage": true,
    "agentId": "main",
    "search": "optional search text"
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | integer | No | Max sessions to return |
| `activeMinutes` | integer | No | Only sessions active within N minutes |
| `includeDerivedTitles` | boolean | No | Derive title from first user message (file read per session) |
| `includeLastMessage` | boolean | No | Include most recent message preview (file read per session) |
| `includeGlobal` | boolean | No | Include global sessions |
| `includeUnknown` | boolean | No | Include sessions with unknown agents |
| `agentId` | string | No | Filter by agent ID |
| `label` | string | No | Filter by session label |
| `search` | string | No | Search text filter |
| `spawnedBy` | string | No | Filter by parent session |

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "ts": 1737264000000,
    "path": "/path/to/sessions.json",
    "count": 5,
    "defaults": {
      "model": "claude-sonnet-4-5-20250929",
      "modelProvider": "anthropic",
      "contextTokens": null
    },
    "sessions": [
      {
        "key": "main",
        "sessionId": "uuid-1",
        "updatedAt": 1737264000000,
        "thinkingLevel": "medium",
        "verboseLevel": "off",
        "model": "claude-sonnet-4-5-20250929",
        "modelProvider": "anthropic",
        "inputTokens": 1500,
        "outputTokens": 800,
        "totalTokens": 2300,
        "label": "My Chat",
        "derivedTitle": "Hello, what can you help me with?",
        "lastMessagePreview": "I can help with many things..."
      }
    ]
  }
}
```

### 6.2 `sessions.patch` — Update Session Settings

Modify session metadata like model, thinking level, label, etc.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.patch",
  "params": {
    "key": "main",
    "model": "claude-opus-4-6",
    "thinkingLevel": "high",
    "label": "My Research Chat",
    "verboseLevel": "compact",
    "reasoningLevel": "high"
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Session key to patch |
| `model` | string\|null | No | Model ID to use (null to reset to default) |
| `thinkingLevel` | string\|null | No | Thinking level: `"low"`, `"medium"`, `"high"` |
| `verboseLevel` | string\|null | No | Tool output verbosity: `"off"`, `"compact"`, `"full"` |
| `reasoningLevel` | string\|null | No | Reasoning level |
| `label` | string\|null | No | Human-readable session label |
| `responseUsage` | string\|null | No | Usage display: `"off"`, `"tokens"`, `"full"` |
| `sendPolicy` | string\|null | No | `"allow"` or `"deny"` |
| `execHost` | string\|null | No | Exec host override |
| `execSecurity` | string\|null | No | Exec security level |

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "ok": true,
    "path": "/path/to/sessions.json",
    "key": "main",
    "entry": { /* updated session entry */ },
    "resolved": {
      "modelProvider": "anthropic",
      "model": "claude-opus-4-6"
    }
  }
}
```

### 6.3 `sessions.reset` — Clear Session History

Creates a new session ID (new transcript) while preserving session settings.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.reset",
  "params": { "key": "main" }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "ok": true,
    "key": "main",
    "entry": { /* new session entry with fresh sessionId */ }
  }
}
```

### 6.4 `sessions.delete` — Delete a Session

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.delete",
  "params": {
    "key": "my-session",
    "deleteTranscript": true
  }
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Session key to delete |
| `deleteTranscript` | boolean | No | Also delete transcript file (default: true) |

**Note**: The main session cannot be deleted.

### 6.5 `sessions.resolve` — Resolve a Session Key

Resolve a session key, label, or ID to its canonical key.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.resolve",
  "params": {
    "key": "my-session",
    "agentId": "main"
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": { "ok": true, "key": "resolved-canonical-key" }
}
```

### 6.6 `sessions.preview` — Get Session Previews

Get preview/summary items for multiple sessions at once.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.preview",
  "params": {
    "keys": ["main", "agent:my-agent"],
    "limit": 12,
    "maxChars": 240
  }
}
```

### 6.7 `sessions.compact` — Compact a Session Transcript

Trim a transcript file to the most recent N lines.

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.compact",
  "params": {
    "key": "main",
    "maxLines": 400
  }
}
```

### 6.8 `sessions.usage` — Get Token Usage Statistics

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "sessions.usage",
  "params": {
    "key": "main",
    "startDate": "2025-01-01",
    "endDate": "2025-12-31",
    "limit": 50,
    "includeContextWeight": true
  }
}
```

### Session Key Format

Session keys follow these patterns:
- `"main"` — The default/main session
- `"agent:agent-id"` — Agent-specific session
- `"agent:agent-id:label"` — Agent session with label
- Custom keys created via `/new` commands

---

## 7. Streaming: Chat Events & Agent Events

After sending a `chat.send`, results stream back as **events**. There are two event types
relevant to chat:

### 7.1 Chat Events (`event: "chat"`)

Chat events provide high-level message streaming — text deltas, final messages, errors.

```typescript
{
  type: "event",
  event: "chat",
  payload: {
    runId: string;           // Matches your idempotencyKey
    sessionKey: string;      // Session this belongs to
    seq: number;             // Sequence number within the run
    state: "delta" | "final" | "aborted" | "error";
    message?: {              // Present for delta and final states
      role: "assistant";
      content: [{ type: "text", text: string }];
      timestamp: number;
    };
    errorMessage?: string;   // Present for error state
    usage?: object;          // Token usage (on final)
    stopReason?: string;     // Why the run stopped (on final)
  }
}
```

#### Chat Event States

| State | Description | UI Action |
|-------|-------------|-----------|
| `delta` | Partial text update — the `message.content[0].text` contains the **full accumulated text so far** (not just the new characters). | Replace the streaming message with the new text. Compare lengths to ensure monotonic growth. |
| `final` | Run completed. Contains the full final message or is empty (if text was already streamed). | Finalize the message display. Refresh history to get the persisted version. |
| `aborted` | Run was cancelled. | Clear streaming state, show "Cancelled" indicator. |
| `error` | Run failed. `errorMessage` contains the error. | Display error to user, clear streaming state. |

#### Delta Handling Pattern

```typescript
function handleChatEvent(payload) {
  if (payload.sessionKey !== currentSessionKey) return;
  if (payload.runId !== currentRunId) {
    // Different run (e.g., sub-agent) — refresh history on final
    if (payload.state === "final") refreshHistory();
    return;
  }

  switch (payload.state) {
    case "delta":
      const newText = extractText(payload.message);
      // Server sends full accumulated text, not incremental deltas
      if (newText.length >= currentStreamText.length) {
        currentStreamText = newText;
      }
      break;
    case "final":
      currentStreamText = null;
      currentRunId = null;
      // Refresh history to get the persisted message
      refreshHistory();
      break;
    case "aborted":
      currentStreamText = null;
      currentRunId = null;
      break;
    case "error":
      currentStreamText = null;
      currentRunId = null;
      showError(payload.errorMessage);
      break;
  }
}
```

**Critical implementation detail**: Chat deltas are **throttled at 150ms** on the server.
The `message.content[0].text` field contains the **full accumulated text** up to that point,
not just the incremental change since the last delta. Your UI should replace (not append)
the streaming content.

### 7.2 Agent Events (`event: "agent"`)

Agent events provide lower-level details about the AI agent's execution: lifecycle phases,
tool calls, thinking, etc.

```typescript
{
  type: "event",
  event: "agent",
  payload: {
    runId: string;       // Agent run ID
    seq: number;         // Sequence within the run
    stream: string;      // Event stream type
    ts: number;          // Timestamp (ms)
    sessionKey?: string; // Session key (added by gateway)
    data: Record<string, unknown>;  // Stream-specific data
  }
}
```

#### Agent Event Streams

| Stream | Data Fields | Description |
|--------|-------------|-------------|
| `lifecycle` | `{ phase: "start"\|"end"\|"error", error?: string }` | Agent run lifecycle |
| `assistant` | `{ text: string, delta?: string }` | Assistant text generation |
| `tool` | `{ name: string, input?: unknown, result?: unknown, partialResult?: unknown, status: string }` | Tool call execution |
| `thinking` | `{ text: string }` | Thinking/reasoning content |
| `error` | `{ reason: string, ... }` | Errors and sequence gaps |

#### Tool Event Filtering

Tool events are filtered by the session's `verboseLevel`:
- `"off"` — No tool events sent to the client
- `"compact"` — Tool events sent but `result` and `partialResult` fields stripped
- `"full"` — Full tool events with results included

Tool events are also only sent to connections that declared the `"tool-events"` capability
in their connect params (`caps: ["tool-events"]`).

---

## 8. Model Switching & Agent Selection

### 8.1 `models.list` — List Available Models

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "models.list",
  "params": {}
}
```

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "models": [
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "provider": "anthropic",
        "contextWindow": 200000,
        "reasoning": true
      },
      {
        "id": "claude-sonnet-4-5-20250929",
        "name": "Claude Sonnet 4.5",
        "provider": "anthropic",
        "contextWindow": 200000,
        "reasoning": false
      },
      {
        "id": "claude-haiku-4-5-20251001",
        "name": "Claude Haiku 4.5",
        "provider": "anthropic",
        "contextWindow": 200000,
        "reasoning": false
      }
    ]
  }
}
```

#### Model Choice Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Model identifier (use this in `sessions.patch`) |
| `name` | string | Human-readable model name |
| `provider` | string | Provider name (e.g., `"anthropic"`, `"openai"`) |
| `contextWindow` | number | Context window size in tokens |
| `reasoning` | boolean | Whether the model supports extended thinking/reasoning |

### 8.2 Switching a Session's Model

To change the model for a session, use `sessions.patch`:

```typescript
await client.request("sessions.patch", {
  key: "main",
  model: "claude-opus-4-6"
});
```

### 8.3 `agents.list` — List Available Agents

**Request:**
```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "agents.list",
  "params": {}
}
```

**Response:**
```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": true,
  "payload": {
    "defaultId": "main",
    "mainKey": "main",
    "scope": "per-sender",
    "agents": [
      {
        "id": "main",
        "name": "Main Agent",
        "identity": {
          "name": "Assistant",
          "theme": "blue",
          "emoji": "🤖",
          "avatar": "base64-data",
          "avatarUrl": "/avatar/main"
        }
      },
      {
        "id": "researcher",
        "name": "Research Agent",
        "identity": {
          "name": "Researcher",
          "emoji": "🔬"
        }
      }
    ]
  }
}
```

### 8.4 Agent-Specific Sessions

Agents have their own sessions, keyed as `"agent:<agentId>"`. To chat with a specific agent:

```typescript
// Send to the researcher agent
await client.request("chat.send", {
  sessionKey: "agent:researcher",
  message: "Research this topic...",
  idempotencyKey: uuid()
});

// Load researcher's history
await client.request("chat.history", {
  sessionKey: "agent:researcher"
});
```

### 8.5 Avatar URLs

Agent avatars are served via HTTP:
```
GET /avatar/<agentId>?meta=1   → { avatarUrl: string | null }
GET /avatar/<agentId>          → Actual avatar image
```

---

## 9. Multimedia Input: Image Attachments

### Attachment Format for `chat.send`

Attachments are sent as an array in the `chat.send` params:

```json
{
  "attachments": [
    {
      "type": "image",
      "mimeType": "image/png",
      "content": "base64-encoded-image-data-without-data-url-prefix"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Attachment type hint (e.g., `"image"`) |
| `mimeType` | string | Yes | MIME type: `"image/jpeg"`, `"image/png"`, `"image/gif"`, `"image/webp"` |
| `fileName` | string | No | Original filename |
| `content` | string | Yes | Base64-encoded image data |

### Supported Image Types
- `image/jpeg`
- `image/png`
- `image/gif`
- `image/webp`

### Size Limits
- **Maximum**: 5 MB per image after base64 decode
- The server validates base64 format (length divisible by 4, valid charset)
- MIME type is sniffed from the actual data and cross-checked against the declared type
- Non-image attachments are silently dropped with a warning

### Client-Side Image Handling

When building the UI, convert file inputs to base64:

```typescript
type ChatAttachment = {
  mimeType: string;
  dataUrl: string;  // data:image/png;base64,...
};

// Convert File to attachment
async function fileToAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      mimeType: file.type,
      dataUrl: reader.result as string
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// When sending, convert dataUrl to API format
function toApiAttachment(att: ChatAttachment) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(att.dataUrl);
  if (!match) return null;
  return {
    type: "image",
    mimeType: match[1],
    content: match[2]  // base64 data only, no prefix
  };
}
```

### Images in Message Content Blocks

When displaying messages from history, images appear as content blocks:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What's in this image?" },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "base64-data"
      }
    }
  ]
}
```

---

## 10. OpenResponses HTTP API (Alternative)

For use cases where WebSocket is impractical, the gateway also exposes an OpenResponses-
compatible HTTP API with SSE streaming.

### Endpoint

```
POST /v1/responses
Authorization: Bearer <gateway-token>
Content-Type: application/json
```

### Request Body

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "input": "What is the capital of France?",
  "instructions": "You are a helpful assistant.",
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          }
        }
      }
    }
  ],
  "tool_choice": "auto",
  "max_output_tokens": 4096,
  "reasoning": { "effort": "medium" }
}
```

### Structured Input (Multi-turn)

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "input": [
    { "type": "message", "role": "system", "content": "You are helpful." },
    { "type": "message", "role": "user", "content": "Hello!" },
    { "type": "message", "role": "assistant", "content": "Hi there!" },
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "What's in this image?" },
        {
          "type": "input_image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "base64-encoded-data"
          }
        }
      ]
    }
  ],
  "stream": true
}
```

### SSE Streaming Events

```
event: response.created
data: {"type":"response.created","response":{...}}

event: response.in_progress
data: {"type":"response.in_progress","response":{...}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{...}}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_xxx","output_index":0,"content_index":0,"delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_xxx","output_index":0,"content_index":0,"delta":" there!"}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_xxx","output_index":0,"content_index":0,"text":"Hello there!"}

event: response.content_part.done
data: {"type":"response.content_part.done",...}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{...}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_xxx","status":"completed","output":[...],"usage":{"input_tokens":50,"output_tokens":20,"total_tokens":70}}}

data: [DONE]
```

**Key difference from WebSocket**: The OpenResponses HTTP API sends **incremental deltas**
(just the new text), not the full accumulated text like WebSocket chat events.

---

## 11. Error Handling & Error Codes

### Error Codes

```typescript
const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",         // Channel/service not linked
  NOT_PAIRED: "NOT_PAIRED",         // Device not yet paired
  AGENT_TIMEOUT: "AGENT_TIMEOUT",   // Agent execution timed out
  INVALID_REQUEST: "INVALID_REQUEST", // Bad parameters
  UNAVAILABLE: "UNAVAILABLE",       // Service temporarily unavailable
};
```

### Error Response Format

```json
{
  "type": "res",
  "id": "req-uuid",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "invalid chat.send params: must have required property 'idempotencyKey'",
    "details": null,
    "retryable": false,
    "retryAfterMs": null
  }
}
```

### Common Error Scenarios

| Scenario | Code | Handling |
|----------|------|----------|
| Invalid parameters | `INVALID_REQUEST` | Fix request and retry |
| Session not found | `INVALID_REQUEST` | Create session or use a valid key |
| Agent timeout | `AGENT_TIMEOUT` | Show timeout message, allow retry |
| Gateway overloaded | `UNAVAILABLE` | Check `retryable` and `retryAfterMs`, backoff |
| Auth failure | Connection closed | Re-authenticate, check token |
| Send policy denied | `INVALID_REQUEST` | Message "send blocked by session policy" |
| Duplicate run | N/A | `status: "in_flight"` returned (not an error) |

---

## 12. Reconnection & Resilience

### Automatic Reconnection

The browser client implements exponential backoff reconnection:

```typescript
class GatewayBrowserClient {
  private backoffMs = 800;

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);  // Cap at 15s
    setTimeout(() => this.connect(), delay);
  }

  // Reset backoff on successful connect
  onHello(hello) {
    this.backoffMs = 800;
  }
}
```

**Backoff sequence**: 800ms → 1360ms → 2312ms → 3930ms → 6681ms → 11358ms → 15000ms (capped)

### Handling Disconnects

When a WebSocket close event fires:
1. All pending requests are rejected with an error
2. The `onClose` callback fires with `{ code, reason }`
3. Reconnection is scheduled with backoff
4. After reconnection + successful hello-ok, reload state:
   - Refresh chat history
   - Refresh session list
   - Resume any UI state

### Pending Request Cleanup

On disconnect, all in-flight requests are flushed:

```typescript
private flushPending(err: Error) {
  for (const [, p] of this.pending) {
    p.reject(err);
  }
  this.pending.clear();
}
```

Your UI should handle rejected promises gracefully — show a "reconnecting" indicator
rather than error messages for each individual failed request.

---

## 13. Presence & Server State

### Snapshot (from hello-ok)

The `snapshot` in the hello-ok payload contains:

```typescript
{
  presence: PresenceEntry[];  // Connected clients
  health: any;                // Server health data
  stateVersion: {
    presence: number;
    health: number;
  };
  uptimeMs: number;
  configPath?: string;
  stateDir?: string;
  sessionDefaults: {
    defaultAgentId: string;   // Default agent (e.g., "main")
    mainKey: string;          // Main session key
    mainSessionKey: string;
    scope?: string;           // "per-sender" or "global"
  };
}
```

### Presence Entry

```typescript
{
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: string;
  lastInputSeconds?: number;
  reason?: string;
  tags?: string[];
  text?: string;
  ts: number;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
}
```

Presence entries are keyed by device identity, allowing a single row per device even
when it connects as both operator and node.

---

## 14. Message Format & Content Blocks

### Message Structure

Messages in history and streaming events use this format:

```typescript
type Message = {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  timestamp: number;        // Unix milliseconds
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  stopReason?: string;      // "end_turn", "injected", "aborted", etc.
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
```

### Rendering Messages

For a chat UI, you need to handle these content block types:

1. **Text blocks** (`type: "text"`): Render as markdown. The text field contains the
   full message text.

2. **Image blocks** (`type: "image"`): Render as `<img>` with a data URL:
   ```html
   <img src="data:${source.media_type};base64,${source.data}" />
   ```

3. **Tool use blocks** (`type: "tool_use"`): Show tool invocation details (name, input).
   These appear in verbose mode.

4. **Tool result blocks** (`type: "tool_result"`): Show tool execution results.

### Extracting Text from Messages

To extract plain text from a message's content blocks:

```typescript
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { content?: unknown };
  if (!msg.content) return "";

  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";

  return msg.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}
```

---

## 15. Tool Events & Verbose Levels

### Requesting Tool Events

To receive tool execution events, include the `"tool-events"` capability in your connect:

```json
{
  "caps": ["tool-events"]
}
```

### Verbose Levels

Sessions have a `verboseLevel` setting that controls tool event delivery:

| Level | Behavior |
|-------|----------|
| `"off"` | No tool events sent (default) |
| `"compact"` | Tool events sent with `result` and `partialResult` stripped |
| `"full"` | Complete tool events including results |

Set via `sessions.patch`:
```json
{ "key": "main", "verboseLevel": "compact" }
```

### Tool Event Structure

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "runId": "run-123",
    "seq": 5,
    "stream": "tool",
    "ts": 1737264000000,
    "sessionKey": "main",
    "data": {
      "name": "web_search",
      "status": "running",
      "input": { "query": "OpenClaw documentation" },
      "result": "...",
      "partialResult": "..."
    }
  }
}
```

Tool events are only sent to connections registered via `registerToolEventRecipient`
(automatically done when `caps` includes `"tool-events"`).

---

## 16. Stop / Abort / Reset Commands

### Stop Commands (Client-Side Detection)

The existing UI detects these as stop commands and calls `chat.abort` instead of `chat.send`:

```typescript
function isChatStopCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ["/stop", "stop", "esc", "abort", "wait", "exit"].includes(normalized);
}
```

### Reset Commands

These trigger a session reset via `sessions.reset`:

```typescript
function isChatResetCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "/new" || normalized === "/reset"
    || normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}
```

### Server-Side Stop Command Detection

The server also detects stop commands in `chat.send` and will abort all active runs
for the session instead of starting a new agent run.

---

## 17. Client Capabilities & Caps

The `caps` array in the connect params declares what the client supports:

| Capability | Value | Description |
|-----------|-------|-------------|
| Tool Events | `"tool-events"` | Receive agent tool execution events |

Additional node capabilities (not relevant for chat clients):
- `"camera"`, `"canvas"`, `"screen"`, `"location"`, `"voice"`

---

## 18. Sequence Numbers & Gap Detection

### Event Sequence Numbers

Every event frame has an optional `seq` field — a monotonically increasing integer.
The client should track the last seen `seq` and detect gaps:

```typescript
private lastSeq: number | null = null;

handleEvent(evt) {
  const seq = typeof evt.seq === "number" ? evt.seq : null;
  if (seq !== null) {
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      // Gap detected! Some events were missed.
      this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
    }
    this.lastSeq = seq;
  }
}
```

### Handling Gaps

When a gap is detected:
1. Log the gap for debugging
2. Consider refreshing state (reload history, session list) since events may have been lost
3. The server also emits `agent` events with `stream: "error"` and `reason: "seq gap"`

---

## 19. Tick / Heartbeat Protocol

### Server Ticks

The gateway sends periodic `tick` events at the interval specified in `hello-ok.policy.tickIntervalMs` (default: 15000ms):

```json
{
  "type": "event",
  "event": "tick",
  "payload": { "ts": 1737264000000 }
}
```

### Shutdown Events

Before shutting down, the gateway sends:

```json
{
  "type": "event",
  "event": "shutdown",
  "payload": {
    "reason": "server restarting",
    "restartExpectedMs": 5000
  }
}
```

Your client should:
1. Show a "server restarting" indicator
2. Wait for `restartExpectedMs` before reconnecting
3. Continue with normal backoff reconnection

---

## 20. Full Client Implementation Checklist

### Core Connection
- [ ] WebSocket connection to gateway URL
- [ ] Handle `connect.challenge` event and extract nonce
- [ ] Send `connect` request with auth, device identity, and client info
- [ ] Process `hello-ok` response — store device token, extract session defaults
- [ ] Implement exponential backoff reconnection (800ms → 15s cap, factor 1.7)
- [ ] Flush pending requests on disconnect
- [ ] Handle `tick` events (connection health monitoring)
- [ ] Handle `shutdown` events (graceful reconnection delay)
- [ ] Track event sequence numbers, detect and handle gaps

### Authentication
- [ ] Generate Ed25519 keypair on first use (via `@noble/ed25519` + WebCrypto)
- [ ] Persist device identity in localStorage
- [ ] Sign connect payload with challenge nonce
- [ ] Store issued device tokens in localStorage per role
- [ ] Fall back to token-only auth on insecure contexts (plain HTTP)
- [ ] Support token and password auth modes

### Chat Core
- [ ] Send messages via `chat.send` with unique `idempotencyKey` (UUID)
- [ ] Handle immediate ack response (`runId`, `status`)
- [ ] Process `chat` events: `delta`, `final`, `aborted`, `error`
- [ ] Display streaming text (replace, don't append — server sends full accumulated text)
- [ ] Show typing/thinking indicators during streaming
- [ ] Handle `final` — clear streaming state, optionally refresh history
- [ ] Handle `aborted` — clear streaming state, show "Cancelled"
- [ ] Handle `error` — display error message, clear streaming state
- [ ] Load conversation history via `chat.history` on session change/reconnect
- [ ] Implement message queue for sends during active runs
- [ ] Deduplicate events from different runs for same session

### Multi-Chat / Session Management
- [ ] List sessions via `sessions.list` with `includeDerivedTitles` and `includeLastMessage`
- [ ] Display session list in sidebar with titles, previews, timestamps
- [ ] Switch between sessions — update `sessionKey`, reload history
- [ ] Create new sessions via `sessions.reset` (or `/new` command)
- [ ] Delete sessions via `sessions.delete`
- [ ] Rename sessions via `sessions.patch` with `label` field
- [ ] Show active session indicator and session metadata
- [ ] Refresh session list after chat completion

### Model Switching
- [ ] List available models via `models.list`
- [ ] Display model picker UI with model name, provider, context window, reasoning capability
- [ ] Switch session model via `sessions.patch` with `model` field
- [ ] Show current model in session header
- [ ] Handle thinking/reasoning levels: set via `sessions.patch` with `thinkingLevel`

### Agent Support
- [ ] List agents via `agents.list`
- [ ] Display agent picker with name, avatar, emoji
- [ ] Route to agent-specific sessions (`"agent:<agentId>"`)
- [ ] Load agent avatars via HTTP (`GET /avatar/<agentId>`)
- [ ] Show agent identity in chat header

### Multimedia
- [ ] File input UI for image attachments (drag-drop, paste, file picker)
- [ ] Convert images to base64 for API format
- [ ] Preview images before sending
- [ ] Display image content blocks in message history
- [ ] Enforce size limits (5MB per image)
- [ ] Validate MIME types (jpeg, png, gif, webp)

### Tool Events (Optional)
- [ ] Declare `"tool-events"` capability in connect
- [ ] Handle `agent` events with `stream: "tool"`
- [ ] Display tool call names and status (running, completed, errored)
- [ ] Show tool inputs and results based on verbose level
- [ ] Set verbose level via `sessions.patch` with `verboseLevel`

### Abort / Stop
- [ ] Stop button to abort active runs via `chat.abort`
- [ ] Detect stop commands in text input (`/stop`, `stop`, `abort`, etc.)
- [ ] Detect reset commands (`/new`, `/reset`)
- [ ] Restore draft message after abort

### Error Handling
- [ ] Display error messages from `chat` error events
- [ ] Handle request failures gracefully (show error, allow retry)
- [ ] Show connection status indicator (connected/disconnecting/reconnecting)
- [ ] Handle idempotency (duplicate sends return cached results)

### UI / UX
- [ ] Responsive layout (desktop sidebar + mobile drawer/tabs)
- [ ] Markdown rendering for assistant messages
- [ ] Code syntax highlighting in messages
- [ ] Auto-scroll to bottom on new messages, with scroll-lock when user scrolls up
- [ ] Message timestamps
- [ ] Token usage display (when `responseUsage` is not `"off"`)
- [ ] Keyboard shortcuts (Enter to send, Shift+Enter for newlines, Escape to abort)
- [ ] Loading states for history, session list, model list
- [ ] Empty state for new sessions

---

## 21. Reference: Key Source Files

### Gateway Server
| File | Description |
|------|-------------|
| `src/gateway/server.impl.ts` | Gateway server initialization and lifecycle |
| `src/gateway/server/ws-connection.ts` | WebSocket connection handler |
| `src/gateway/server/ws-connection/message-handler.ts` | Message routing |
| `src/gateway/server-chat.ts` | Chat run registry, streaming, agent event handler |
| `src/gateway/server-methods/chat.ts` | `chat.send`, `chat.history`, `chat.abort`, `chat.inject` |
| `src/gateway/server-methods/sessions.ts` | Session CRUD operations |
| `src/gateway/server-broadcast.ts` | Event broadcasting to connected clients |
| `src/gateway/chat-attachments.ts` | Image attachment parsing and validation |
| `src/gateway/chat-abort.ts` | Abort logic and stop command detection |
| `src/gateway/chat-sanitize.ts` | Message sanitization for history |
| `src/gateway/auth.ts` | Authentication (token, password, device, Tailscale) |
| `src/gateway/device-auth.ts` | Device auth payload building |
| `src/gateway/openresponses-http.ts` | OpenResponses HTTP API (`/v1/responses`) |
| `src/gateway/openai-http.ts` | OpenAI-compatible HTTP API (`/v1/chat/completions`) |
| `src/gateway/session-utils.ts` | Session file I/O, message reading |
| `src/gateway/sessions-patch.ts` | Session metadata patching |

### Protocol Schema
| File | Description |
|------|-------------|
| `src/gateway/protocol/schema/frames.ts` | Request/Response/Event frame definitions |
| `src/gateway/protocol/schema/logs-chat.ts` | Chat method param/event schemas |
| `src/gateway/protocol/schema/sessions.ts` | Session method schemas |
| `src/gateway/protocol/schema/agent.ts` | Agent event and param schemas |
| `src/gateway/protocol/schema/agents-models-skills.ts` | Models and agents list schemas |
| `src/gateway/protocol/schema/snapshot.ts` | Presence and snapshot schemas |
| `src/gateway/protocol/schema/error-codes.ts` | Error code definitions |
| `src/gateway/protocol/schema/primitives.ts` | Primitive type definitions |
| `src/gateway/protocol/client-info.ts` | Client IDs, modes, capabilities |
| `src/gateway/protocol/schema/protocol-schemas.ts` | All schemas registry + protocol version |
| `src/gateway/open-responses.schema.ts` | OpenResponses API Zod schemas |

### Existing Browser Client (Reference Implementation)
| File | Description |
|------|-------------|
| `ui/src/ui/gateway.ts` | `GatewayBrowserClient` — WebSocket client for browsers |
| `ui/src/ui/device-identity.ts` | Ed25519 keypair generation and persistence |
| `ui/src/ui/device-auth.ts` | Device token storage in localStorage |
| `ui/src/ui/controllers/chat.ts` | Chat controller: send, history, abort, event handling |
| `ui/src/ui/app-chat.ts` | App-level chat: queuing, stop/reset detection, avatar |
| `ui/src/ui/views/chat.ts` | Lit web component for chat rendering |
| `ui/src/ui/uuid.ts` | UUID generation for request IDs |

### Other Client Implementations
| File | Description |
|------|-------------|
| `src/tui/gateway-chat.ts` | TUI (terminal) chat client — good clean reference |
| `src/gateway/client.ts` | Node.js backend WebSocket client |
| `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift` | iOS native client |

### Documentation
| File | Description |
|------|-------------|
| `docs/gateway/protocol.md` | Official protocol specification |
| `docs/web/webchat.md` | WebChat configuration guide |
| `docs/gateway/configuration.md` | Full gateway configuration reference |

---

## Appendix A: Minimal Working Example

A minimal browser client that connects, loads history, sends a message, and streams the response:

```typescript
// minimal-openclaw-client.ts

const GATEWAY_WS_URL = "ws://localhost:4080";
const GATEWAY_TOKEN = "your-token-here";
const SESSION_KEY = "main";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

let ws: WebSocket;
let pending = new Map<string, Pending>();
let currentRunId: string | null = null;
let streamText = "";

function generateUUID(): string {
  return crypto.randomUUID();
}

function connect() {
  ws = new WebSocket(GATEWAY_WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected, waiting for challenge...");
  };

  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data);

    // Handle challenge
    if (frame.type === "event" && frame.event === "connect.challenge") {
      sendConnect(frame.payload?.nonce);
      return;
    }

    // Handle responses
    if (frame.type === "res") {
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        frame.ok ? p.resolve(frame.payload) : p.reject(new Error(frame.error?.message));
      }
      return;
    }

    // Handle events
    if (frame.type === "event") {
      handleEvent(frame.event, frame.payload);
    }
  };

  ws.onclose = (ev) => {
    console.log(`Disconnected: ${ev.code} ${ev.reason}`);
    // Reconnect after delay
    setTimeout(connect, 2000);
  };
}

function sendConnect(nonce?: string) {
  request("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat-ui",
      version: "1.0.0",
      platform: "web",
      mode: "webchat",
    },
    role: "operator",
    scopes: ["operator.admin"],
    caps: ["tool-events"],
    auth: { token: GATEWAY_TOKEN },
  }).then((hello: any) => {
    console.log("Connected! Protocol:", hello.protocol);
    console.log("Default agent:", hello.snapshot?.sessionDefaults?.defaultAgentId);
    loadHistory();
  });
}

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = generateUUID();
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject: (e) => reject(e),
    });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function loadHistory() {
  const res = await request<{ messages: any[] }>("chat.history", {
    sessionKey: SESSION_KEY,
    limit: 50,
  });
  console.log(`Loaded ${res.messages.length} messages`);
  // Render messages in your UI...
}

async function sendMessage(text: string) {
  const runId = generateUUID();
  currentRunId = runId;
  streamText = "";

  const res = await request<{ runId: string; status: string }>("chat.send", {
    sessionKey: SESSION_KEY,
    message: text,
    idempotencyKey: runId,
  });

  console.log(`Send ack: ${res.status} (runId: ${res.runId})`);
}

function handleEvent(event: string, payload: any) {
  if (event === "chat") {
    if (payload.sessionKey !== SESSION_KEY) return;
    if (payload.runId !== currentRunId) return;

    switch (payload.state) {
      case "delta":
        // payload.message.content[0].text = full accumulated text
        streamText = payload.message?.content?.[0]?.text ?? streamText;
        console.log("Streaming:", streamText);
        break;
      case "final":
        console.log("Final message received");
        currentRunId = null;
        streamText = "";
        loadHistory(); // Refresh to get persisted message
        break;
      case "aborted":
        console.log("Run aborted");
        currentRunId = null;
        streamText = "";
        break;
      case "error":
        console.error("Run error:", payload.errorMessage);
        currentRunId = null;
        streamText = "";
        break;
    }
  }

  if (event === "agent") {
    // Tool events, lifecycle events, etc.
    if (payload.stream === "tool") {
      console.log(`Tool: ${payload.data?.name} (${payload.data?.status})`);
    }
  }

  if (event === "tick") {
    // Connection health — server is alive
  }
}

// Start the client
connect();

// Usage:
// sendMessage("Hello, tell me about OpenClaw!");
// sendMessage("/stop");  // Abort
// sendMessage("/new");   // Reset session
```

---

## Appendix B: TypeScript Type Definitions for Client Use

```typescript
// ─── Protocol Frames ───

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: StateVersion;
};

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

// ─── Error ───

export type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export type StateVersion = {
  presence: number;
  health: number;
};

// ─── Connect ───

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
    displayName?: string;
    instanceId?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
  };
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  auth?: { token?: string; password?: string };
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce?: string;
  };
  locale?: string;
  userAgent?: string;
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: {
    version: string;
    commit?: string;
    host?: string;
    connId: string;
  };
  features: {
    methods: string[];
    events: string[];
  };
  snapshot: Snapshot;
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
  auth?: {
    deviceToken: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  canvasHostUrl?: string;
};

export type Snapshot = {
  presence: PresenceEntry[];
  health: unknown;
  stateVersion: StateVersion;
  uptimeMs: number;
  configPath?: string;
  stateDir?: string;
  sessionDefaults?: {
    defaultAgentId: string;
    mainKey: string;
    mainSessionKey: string;
    scope?: string;
  };
};

export type PresenceEntry = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode?: string;
  lastInputSeconds?: number;
  reason?: string;
  tags?: string[];
  text?: string;
  ts: number;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
};

// ─── Chat ───

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  attachments?: ChatAttachment[];
  timeoutMs?: number;
  idempotencyKey: string;
};

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;  // base64-encoded
};

export type ChatHistoryParams = {
  sessionKey: string;
  limit?: number;
};

export type ChatAbortParams = {
  sessionKey: string;
  runId?: string;
};

export type ChatInjectParams = {
  sessionKey: string;
  message: string;
  label?: string;
};

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    role: string;
    content: ContentBlock[];
    timestamp: number;
    usage?: TokenUsage;
    stopReason?: string;
  };
  errorMessage?: string;
  usage?: TokenUsage;
  stopReason?: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type TokenUsage = {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

// ─── Sessions ───

export type SessionsListParams = {
  limit?: number;
  activeMinutes?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  agentId?: string;
  label?: string;
  search?: string;
  spawnedBy?: string;
};

export type SessionsPatchParams = {
  key: string;
  label?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  responseUsage?: "off" | "tokens" | "full" | "on" | null;
  elevatedLevel?: string | null;
  execHost?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
  execNode?: string | null;
  sendPolicy?: "allow" | "deny" | null;
  spawnedBy?: string | null;
  groupActivation?: "mention" | "always" | null;
};

export type SessionsResetParams = {
  key: string;
};

export type SessionsDeleteParams = {
  key: string;
  deleteTranscript?: boolean;
};

// ─── Models & Agents ───

export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type AgentSummary = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: AgentSummary[];
};

export type ModelsListResult = {
  models: ModelChoice[];
};

// ─── Agent Events ───

export type AgentEvent = {
  runId: string;
  seq: number;
  stream: string;  // "lifecycle" | "assistant" | "tool" | "thinking" | "error"
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};
```

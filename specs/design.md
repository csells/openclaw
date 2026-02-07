# OpenClaw Web Chat Client — Design Document

> A modern, full-featured AI chat web client built on the OpenClaw Gateway WebSocket protocol.

## Overview

This document defines the architecture, technology choices, component breakdown, and
incremental build plan for a standalone web chat client. The plan starts from a minimal
working example (single-session, token auth, text-only streaming) and builds up to the
full feature set: multi-chat, model switching, multimedia, tool events, responsive layout.

Each milestone produces a working, deployable artifact. Later milestones never block earlier
ones.

---

## Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Framework | **React 19** + TypeScript | Largest ecosystem, concurrent rendering for streaming, mature tooling |
| Build | **Vite 6** | Fast HMR, ESM-native, same tool family as existing OpenClaw UI |
| Styling | **Tailwind CSS 4** | Utility-first, responsive-by-default, zero runtime |
| State | **Zustand** | Minimal boilerplate, works well with WebSocket event-driven updates |
| Markdown | **react-markdown** + **rehype-highlight** | Renders assistant messages; syntax highlighting for code blocks |
| Crypto | **@noble/ed25519** | Same library the existing control UI uses for device identity |
| Testing | **Vitest** + **Playwright** | Unit + E2E, consistent with OpenClaw monorepo |
| Package manager | **pnpm** | Consistent with OpenClaw monorepo |

### Why Not Lit (like the existing control UI)?

The existing OpenClaw control UI uses Lit web components. We choose React for the custom
client because:
- Broader ecosystem for chat UIs (virtualized lists, markdown, drag-drop, mobile gestures)
- More engineers are familiar with React
- The client is standalone — it doesn't need to share components with the control UI
- React's concurrent features (transitions, suspense) are a natural fit for streaming

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React Application                     │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  UI Layer   │  │  State Layer │  │ Protocol Layer│  │
│  │             │  │   (Zustand)  │  │  (WebSocket)  │  │
│  │ ChatView    │◄─┤              │◄─┤               │  │
│  │ Sidebar     │  │ chatStore    │  │ GatewayClient │  │
│  │ Composer    │  │ sessionStore │  │               │  │
│  │ Header      │  │ uiStore     │  │ Handles:      │  │
│  │ ModelPicker │──┤              │──┤ - connect     │  │
│  │ ToolPanel   │  │              │  │ - framing     │  │
│  │             │  │              │  │ - reconnect   │  │
│  └─────────────┘  └──────────────┘  │ - auth        │  │
│                                     └───────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                     WebSocket (JSON)
                          │
                ┌─────────┴─────────┐
                │  OpenClaw Gateway  │
                └───────────────────┘
```

### Three-Layer Separation

1. **Protocol Layer** (`src/gateway/`) — Pure WebSocket client. No React, no DOM. Handles
   connect, auth, framing, request/response correlation, event dispatch, reconnection,
   sequence tracking. This layer is framework-agnostic and testable in isolation.

2. **State Layer** (`src/stores/`) — Zustand stores that translate protocol events into
   UI-ready state. Each store owns one concern (chat, sessions, models, connection). Stores
   call the protocol layer and subscribe to its events.

3. **UI Layer** (`src/components/`) — React components that read from stores and call store
   actions. Zero protocol knowledge. Pure rendering + user interaction.

---

## Milestone Plan

### Milestone 0 — Skeleton + Minimal Connection

**Goal**: Vite project boots, connects to gateway, prints hello-ok to console.

```
webchat/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.tsx                  # React root mount
│   ├── App.tsx                   # Top-level layout shell
│   ├── gateway/
│   │   ├── client.ts             # GatewayClient class
│   │   ├── types.ts              # Protocol frame types
│   │   └── auth.ts               # Token auth helper
│   └── components/
│       └── ConnectionStatus.tsx  # Shows connected/disconnected
```

**Protocol Layer — `GatewayClient`**

The core of the entire application. Extracted from the research doc's minimal working
example and hardened:

```typescript
// src/gateway/client.ts

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientId?: string;
  onHello: (hello: HelloOk) => void;
  onEvent: (event: string, payload: unknown, seq?: number) => void;
  onDisconnect: (reason: string) => void;
  onReconnecting: (attemptMs: number) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve, reject, timer }>();
  private backoffMs = 800;
  private lastSeq: number | null = null;
  private closed = false;
  private challengeNonce: string | null = null;

  constructor(private opts: GatewayClientOptions) {}

  // ── Lifecycle ──

  start(): void;        // Open WebSocket, wait for challenge, send connect
  stop(): void;         // Close WebSocket, cancel reconnect
  private connect(): void;
  private scheduleReconnect(): void;   // Exponential backoff: 800ms → 15s, factor 1.7

  // ── Framing ──

  request<T>(method: string, params?: unknown): Promise<T>;  // Send req, return promise
  private send(frame: RequestFrame): void;
  private handleMessage(data: string): void;  // Parse JSON, route to handler

  // ── Handlers ──

  private handleChallenge(payload: { nonce: string }): void;
  private handleResponse(frame: ResponseFrame): void;
  private handleEvent(frame: EventFrame): void;

  // ── Internal ──

  private sendConnect(): void;         // Build connect params with auth
  private flushPending(err: Error): void;
  private trackSeq(seq?: number): void;
}
```

**Key behaviors**:
- On `ws.open`: wait up to 750ms for `connect.challenge`; if none arrives, send connect anyway
- On challenge: store nonce, immediately send connect
- On hello-ok: reset backoff, call `onHello`, start accepting requests
- On `ws.close`: flush pending with error, schedule reconnect
- `request()` returns a `Promise` that resolves/rejects when the matching `res` frame arrives
- Request timeout: 30s default, configurable per-request
- Sequence gap detection: call `onEvent("_gap", ...)` when `seq` jumps

**Acceptance criteria**:
- `pnpm dev` opens browser
- Console shows `"Connected! Protocol: 3"`
- UI shows green "Connected" indicator
- Disconnecting gateway shows red "Disconnected", then auto-reconnects

---

### Milestone 1 — Single Chat (Text Streaming)

**Goal**: Send messages, see streaming responses, load history on refresh.

**New files**:
```
src/
├── stores/
│   ├── chatStore.ts          # Messages, streaming state, send/abort actions
│   └── connectionStore.ts    # Connection status, hello data
├── components/
│   ├── ChatView.tsx          # Message list + auto-scroll
│   ├── MessageBubble.tsx     # Single message rendering (user/assistant)
│   ├── Composer.tsx          # Text input + send button
│   ├── StreamingIndicator.tsx # Typing dots during streaming
│   └── Layout.tsx            # Full-page layout wrapper
└── utils/
    └── extractText.ts        # Extract text from content blocks
```

**Chat Store** (`chatStore.ts`):

```typescript
type ChatState = {
  // State
  sessionKey: string;             // Currently active session ("main")
  messages: Message[];            // Loaded history
  streamingText: string | null;   // Text being streamed (null = idle)
  streamingRunId: string | null;  // Active run ID
  error: string | null;           // Last error message
  loading: boolean;               // Loading history

  // Actions
  loadHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  handleChatEvent: (payload: ChatEvent) => void;
};
```

**Data flow for sending a message**:

```
User types → Composer.onSubmit
  → chatStore.sendMessage(text)
    → Optimistically add user message to messages[]
    → Set streamingRunId = uuid, streamingText = ""
    → gateway.request("chat.send", { sessionKey, message, idempotencyKey })
    → Ack received (runId confirmed)

Gateway streams → gateway.onEvent("chat", payload)
  → chatStore.handleChatEvent(payload)
    → if payload.state === "delta":
        streamingText = payload.message.content[0].text  (full replace)
    → if payload.state === "final":
        streamingText = null, streamingRunId = null
        loadHistory()  (get persisted version)
    → if payload.state === "error":
        streamingText = null, streamingRunId = null
        error = payload.errorMessage
```

**Message rendering rules**:
- User messages: right-aligned, colored background
- Assistant messages: left-aligned, markdown-rendered
- Streaming message: render `streamingText` as a temporary assistant bubble with a pulsing cursor
- On `final`: streaming bubble disappears, replaced by the real message from `loadHistory()`

**Composer behavior**:
- Enter sends, Shift+Enter inserts newline
- While streaming: input is disabled, send button becomes stop button
- Stop button calls `chatStore.abort()` → `gateway.request("chat.abort", ...)`
- Detect `/stop`, `stop`, `abort` → call abort instead of send
- Detect `/new`, `/reset` → call `sessions.reset` then reload

**Auto-scroll**:
- Scroll to bottom on every new delta and new message
- If user manually scrolls up, pin scroll position (don't auto-scroll)
- Resume auto-scroll when user scrolls back to bottom (within 50px threshold)

**Acceptance criteria**:
- Type message, see streaming response appear word-by-word
- Refresh page → history loads with previous messages
- Click stop → response stops, partial text preserved
- Long messages render markdown with syntax-highlighted code

---

### Milestone 2 — Multi-Chat (Session Sidebar)

**Goal**: Session list sidebar, create/switch/rename/delete sessions.

**New files**:
```
src/
├── stores/
│   └── sessionStore.ts       # Session list, active session, CRUD actions
├── components/
│   ├── Sidebar.tsx           # Session list panel
│   ├── SessionItem.tsx       # Single session row (title, preview, timestamp)
│   ├── NewChatButton.tsx     # "New Chat" button
│   └── SessionActions.tsx    # Rename/delete context menu
```

**Session Store** (`sessionStore.ts`):

```typescript
type SessionState = {
  sessions: SessionSummary[];
  activeKey: string;          // Currently selected session key
  loading: boolean;

  loadSessions: () => Promise<void>;
  switchSession: (key: string) => Promise<void>;
  createSession: () => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
};

type SessionSummary = {
  key: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number;
  model?: string;
  totalTokens?: number;
};
```

**Session lifecycle**:

| Action | Protocol Call | UI Effect |
|--------|-------------|-----------|
| Load list | `sessions.list` with `includeDerivedTitles`, `includeLastMessage` | Populate sidebar |
| Switch | Set `activeKey`, call `chat.history` | Clear messages, load new history |
| New chat | `sessions.reset` on current key **OR** `chat.send` to a new key | Sidebar adds entry, chat clears |
| Rename | `sessions.patch` with `label` | Sidebar title updates |
| Delete | `sessions.delete` | Remove from sidebar, switch to main |

**Sidebar layout** (desktop):
```
┌──────────┬──────────────────────────────┐
│ Sidebar  │                              │
│ 260px    │       Chat View              │
│          │                              │
│ [+ New]  │                              │
│ ──────── │                              │
│ Chat 1 ← │  [messages...]              │
│ Chat 2   │                              │
│ Chat 3   │                              │
│          │  ┌────────────────────────┐  │
│          │  │ Composer               │  │
│          │  └────────────────────────┘  │
└──────────┴──────────────────────────────┘
```

**Session switching behavior**:
- Switching sessions aborts any active run on the old session
- New session history loads with a loading skeleton
- Session list refreshes after every `chat.send` final event
- Active session is highlighted in sidebar
- Sessions sorted by `updatedAt` descending (most recent first)

**Acceptance criteria**:
- Sidebar shows list of sessions with titles
- Click session → loads its history
- Click "+ New Chat" → creates empty session
- Right-click session → rename/delete options
- After sending a message, session moves to top of list

---

### Milestone 3 — Model Switching & Thinking Levels

**Goal**: Choose model and thinking level per session.

**New files**:
```
src/
├── stores/
│   └── modelStore.ts         # Available models, current model per session
├── components/
│   ├── ChatHeader.tsx        # Session title + model badge + settings
│   ├── ModelPicker.tsx       # Dropdown to switch models
│   └── ThinkingToggle.tsx    # Thinking level selector
```

**Model Store** (`modelStore.ts`):

```typescript
type ModelState = {
  models: ModelChoice[];
  loading: boolean;

  loadModels: () => Promise<void>;
  setSessionModel: (sessionKey: string, modelId: string) => Promise<void>;
  setThinkingLevel: (sessionKey: string, level: string | null) => Promise<void>;
};
```

**Chat header layout**:
```
┌──────────────────────────────────────────┐
│ My Research Chat          [Opus 4.6 ▾]  │
│                         [Thinking: High] │
└──────────────────────────────────────────┘
```

**Model picker**:
- Dropdown populated from `models.list`
- Each entry shows: model name, provider, context window, reasoning badge
- Selecting a model calls `sessions.patch` with `model: selectedId`
- Current model displayed as a badge in the chat header

**Thinking level toggle**:
- Only shown for models where `reasoning === true`
- Options: Off, Low, Medium, High
- Changing calls `sessions.patch` with `thinkingLevel`

**Acceptance criteria**:
- Model picker shows all available models
- Switching model persists (survives page refresh)
- Thinking level toggle appears/hides based on model capability
- Model badge in header reflects current model

---

### Milestone 4 — Image Attachments

**Goal**: Attach images to messages, display images in history.

**New files**:
```
src/
├── components/
│   ├── AttachmentBar.tsx     # Preview strip above composer
│   ├── AttachmentButton.tsx  # Paperclip / + button
│   ├── ImagePreview.tsx      # Thumbnail with remove button
│   └── ImageBlock.tsx        # Render image content blocks in messages
└── utils/
    └── attachments.ts        # File → base64 conversion, validation
```

**Attachment flow**:

```
User selects file (click, paste, or drag-drop)
  → validate: must be image/jpeg|png|gif|webp, max 5MB
  → read as data URL via FileReader
  → add to pendingAttachments[] in chatStore
  → show thumbnail in AttachmentBar above composer

User sends message
  → for each attachment, strip data: prefix → { type: "image", mimeType, content }
  → include in chat.send params as attachments[]
  → clear pendingAttachments

Display in history
  → content block type "image" → render <img src="data:..." />
  → content block type "text" → render markdown as before
  → interleave text and images in order
```

**Input methods**:
1. **File picker**: Click paperclip button → `<input type="file" accept="image/*" multiple>`
2. **Paste**: Listen for `paste` event on composer → check `clipboardData.files`
3. **Drag-drop**: `dragover`/`drop` on the chat area → `event.dataTransfer.files`

**Validation** (client-side, before sending):
- MIME type must be one of: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- File size must be under 5MB
- Show toast/inline error for invalid files

**Acceptance criteria**:
- Drag image onto chat → preview appears above composer
- Paste screenshot → preview appears
- Click paperclip → file picker opens
- Send with image → image appears in user message bubble
- Assistant response referencing image content renders correctly
- Invalid file → error message shown, not sent

---

### Milestone 5 — Tool Events Panel

**Goal**: Show tool calls in real-time as the agent works.

**New files**:
```
src/
├── stores/
│   └── toolStore.ts          # Active tool events per run
├── components/
│   ├── ToolEventList.tsx     # Collapsible list of tool calls
│   ├── ToolEventItem.tsx     # Single tool call: name, status, input/result
│   └── VerboseToggle.tsx     # Off / Compact / Full selector
```

**Tool Store** (`toolStore.ts`):

```typescript
type ToolEvent = {
  id: string;             // Synthetic: `${runId}-${seq}`
  name: string;           // Tool name (e.g., "web_search")
  status: string;         // "running" | "completed" | "error"
  input?: unknown;        // Tool input (compact/full modes)
  result?: unknown;       // Tool result (full mode only)
  partialResult?: unknown;
  ts: number;
};

type ToolState = {
  events: Map<string, ToolEvent[]>;  // runId → events
  verboseLevel: "off" | "compact" | "full";

  handleAgentEvent: (payload: AgentEvent) => void;
  setVerboseLevel: (sessionKey: string, level: string) => Promise<void>;
  clearRun: (runId: string) => void;
};
```

**Display modes**:

| Verbose Level | What's Shown |
|---------------|-------------|
| `off` | Nothing — tool panel hidden |
| `compact` | Tool name + status indicator (spinner/check/x). No input/result. |
| `full` | Tool name + status + collapsible input JSON + collapsible result JSON |

**Tool event rendering**:
- Show below the streaming message, in a collapsible "Tools" section
- Each tool call: icon + name + status badge
- Running tools show a spinner
- Completed tools show a checkmark
- Failed tools show an error icon
- Click to expand and see input/result (in full mode)

**Acceptance criteria**:
- Set verbose level to "compact" → see tool names appear during streaming
- Set to "full" → see tool inputs and results
- Set to "off" → no tool events visible
- Tool list clears when a new run starts

---

### Milestone 6 — Device Identity & Secure Auth

**Goal**: Full Ed25519 device identity for HTTPS deployments.

**New files**:
```
src/
├── gateway/
│   ├── device-identity.ts    # Ed25519 keypair generation + localStorage
│   ├── device-auth.ts        # Device auth payload building + signing
│   └── device-tokens.ts      # Device token storage per role
├── components/
│   └── AuthGate.tsx          # Token/password entry if not configured
```

**Device identity flow**:

```
First visit (no identity in localStorage)
  → generate Ed25519 keypair via @noble/ed25519
  → derive deviceId = SHA-256(publicKey).hex
  → store { version: 1, deviceId, publicKey, privateKey, createdAtMs } in localStorage

On connect
  → receive challenge nonce from server
  → build deterministic payload string:
      deviceId + clientId + clientMode + role + scopes + signedAt + token + nonce
  → sign payload with private key
  → include device block in connect params

On hello-ok
  → if auth.deviceToken present, store it:
      { version: 1, deviceId, tokens: { [role]: { token, role, scopes, updatedAtMs } } }
  → use stored device token on future connects (instead of gateway token)
```

**Insecure context fallback**:
- If `crypto.subtle` is not available (plain HTTP, non-localhost):
  - Skip device identity entirely
  - Use token-only auth
  - Show warning: "Insecure connection — device pairing disabled"

**Auth gate component**:
- If no token configured and gateway rejects connection:
  - Show a simple form: "Gateway Token" input + "Connect" button
  - Store token in localStorage
  - Retry connection

**Acceptance criteria**:
- HTTPS: device identity generated, signed, verified on connect
- Device token persists across page reloads
- HTTP fallback: token-only auth works with warning
- Auth gate allows entering token manually

---

### Milestone 7 — Agent Selection

**Goal**: List agents, switch between agent-specific sessions.

**New files**:
```
src/
├── stores/
│   └── agentStore.ts         # Agent list, active agent, avatars
├── components/
│   ├── AgentPicker.tsx       # Agent selection UI
│   └── AgentAvatar.tsx       # Avatar image/emoji display
```

**Agent store**:

```typescript
type AgentState = {
  agents: AgentSummary[];
  defaultAgentId: string;
  activeAgentId: string;
  loading: boolean;

  loadAgents: () => Promise<void>;
  switchAgent: (agentId: string) => Promise<void>;
};
```

**Agent-session routing**:
- Default agent uses session key `"main"` (or whatever `sessionDefaults.mainKey` says)
- Other agents use session key `"agent:<agentId>"`
- Switching agent → switch session key → reload history → refresh session list

**Agent picker UI**:
- Dropdown or tab bar in the chat header
- Each agent shows: avatar (or emoji), name
- Active agent is highlighted
- Agent avatars loaded via `GET /avatar/<agentId>` (HTTP, not WebSocket)

**Acceptance criteria**:
- Agent picker shows all configured agents
- Switching agent loads that agent's conversation
- Agent avatar/emoji displayed in chat header
- Session sidebar filters to show only current agent's sessions

---

### Milestone 8 — Responsive Mobile Layout

**Goal**: Full mobile experience with bottom nav, swipeable sidebar, compact composer.

**Breakpoints**:
- Desktop: >= 768px — sidebar visible, split layout
- Mobile: < 768px — full-screen views, bottom navigation

**Mobile layout**:

```
┌──────────────────────────┐
│  Header (agent + model)  │
├──────────────────────────┤
│                          │
│      Chat Messages       │
│      (full width)        │
│                          │
├──────────────────────────┤
│  Composer (sticky bottom)│
├──────────────────────────┤
│ [Chats] [Chat] [Settings]│  ← Bottom nav
└──────────────────────────┘
```

**Mobile behaviors**:
- **Bottom nav tabs**: Chats (session list), Chat (active conversation), Settings (model/agent/verbose)
- **Session list**: Full-screen list view, tap to switch + navigate to Chat tab
- **Swipe right** on Chat tab → peek at session list (drawer from left)
- **Composer**: Single-line input with expand button; auto-grows to max 4 lines
- **Image attachments**: Thumbnail strip scrolls horizontally
- **Tool events**: Collapsed by default, tap to expand

**Desktop-only features** (hidden on mobile):
- Sidebar always visible
- Wider composer with more vertical space
- Tool panel shown inline rather than collapsed

**Acceptance criteria**:
- Resize browser below 768px → layout switches to mobile mode
- Bottom nav works for tab switching
- Session list works as full-screen view on mobile
- Composer stays fixed at bottom, doesn't cause layout shift
- Images and markdown render correctly on narrow screens

---

### Milestone 9 — Polish & Production Readiness

**Goal**: Error handling, loading states, keyboard shortcuts, accessibility.

**Error handling**:
- Connection errors: banner at top "Disconnected — reconnecting in Xs..."
- Send errors: inline error below composer with retry button
- History load errors: "Could not load history" with retry
- Agent timeout: "Response timed out" with retry button

**Loading states**:
- History loading: skeleton message bubbles (3-4 gray rectangles)
- Session list loading: skeleton list items
- Model list loading: spinner in dropdown
- Sending: composer disabled, stop button shown

**Keyboard shortcuts**:
| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |
| `Escape` | Abort active run |
| `Ctrl/Cmd+N` | New chat |
| `Ctrl/Cmd+K` | Focus search / command palette |
| `Up/Down` | Navigate session list (when sidebar focused) |

**Accessibility**:
- All interactive elements have ARIA labels
- Focus management: after send, focus returns to composer
- Screen reader announces new messages
- High contrast support via Tailwind's dark mode + system preference
- Keyboard-navigable session list and model picker

**Performance**:
- Virtualized message list for long conversations (react-window or similar)
- Debounce session list refresh (don't reload on every delta)
- Image lazy loading in message history
- Request deduplication (don't send `sessions.list` while one is in flight)

**Acceptance criteria**:
- All error states have visible, actionable UI
- All loading states show skeletons/spinners
- Keyboard shortcuts work
- Lighthouse accessibility score >= 90
- 1000-message conversation scrolls smoothly

---

## File Structure (Final)

```
webchat/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   │
│   ├── gateway/                    # Protocol Layer
│   │   ├── client.ts               #   WebSocket client
│   │   ├── types.ts                #   Frame + protocol types
│   │   ├── auth.ts                 #   Token/password auth
│   │   ├── device-identity.ts      #   Ed25519 keypair
│   │   ├── device-auth.ts          #   Challenge signing
│   │   └── device-tokens.ts        #   Device token persistence
│   │
│   ├── stores/                     # State Layer
│   │   ├── connectionStore.ts      #   Connection status, hello data
│   │   ├── chatStore.ts            #   Messages, streaming, send/abort
│   │   ├── sessionStore.ts         #   Session list, active session
│   │   ├── modelStore.ts           #   Available models
│   │   ├── agentStore.ts           #   Available agents
│   │   └── toolStore.ts            #   Tool events
│   │
│   ├── components/                 # UI Layer
│   │   ├── Layout.tsx              #   Desktop/mobile responsive shell
│   │   ├── Sidebar.tsx             #   Session list panel
│   │   ├── SessionItem.tsx         #   Single session row
│   │   ├── NewChatButton.tsx
│   │   ├── SessionActions.tsx      #   Rename/delete context menu
│   │   ├── ChatView.tsx            #   Message list with auto-scroll
│   │   ├── MessageBubble.tsx       #   Single message (markdown, images)
│   │   ├── Composer.tsx            #   Text input + send/stop
│   │   ├── ChatHeader.tsx          #   Title + model + agent
│   │   ├── StreamingIndicator.tsx  #   Pulsing cursor / dots
│   │   ├── ConnectionStatus.tsx    #   Connected/disconnected banner
│   │   ├── ModelPicker.tsx         #   Model dropdown
│   │   ├── ThinkingToggle.tsx      #   Thinking level selector
│   │   ├── AgentPicker.tsx         #   Agent selector
│   │   ├── AgentAvatar.tsx         #   Avatar/emoji display
│   │   ├── AttachmentBar.tsx       #   Image preview strip
│   │   ├── AttachmentButton.tsx    #   Paperclip button
│   │   ├── ImagePreview.tsx        #   Thumbnail with remove
│   │   ├── ImageBlock.tsx          #   Image in message content
│   │   ├── ToolEventList.tsx       #   Tool call list
│   │   ├── ToolEventItem.tsx       #   Single tool call display
│   │   ├── VerboseToggle.tsx       #   Verbose level selector
│   │   ├── AuthGate.tsx            #   Token entry form
│   │   └── MobileNav.tsx           #   Bottom tab bar (mobile)
│   │
│   ├── hooks/                      # React Hooks
│   │   ├── useAutoScroll.ts        #   Auto-scroll with pin detection
│   │   ├── useKeyboardShortcuts.ts #   Global keyboard shortcuts
│   │   └── useMediaQuery.ts        #   Responsive breakpoint detection
│   │
│   └── utils/
│       ├── extractText.ts          #   Extract text from content blocks
│       ├── attachments.ts          #   File → base64, validation
│       ├── commands.ts             #   Stop/reset command detection
│       └── formatTime.ts           #   Relative timestamps
│
├── tests/
│   ├── gateway/
│   │   └── client.test.ts          #   WebSocket client unit tests
│   ├── stores/
│   │   ├── chatStore.test.ts
│   │   └── sessionStore.test.ts
│   └── e2e/
│       └── chat.spec.ts            #   Playwright E2E tests
```

---

## State Store Design

### Connection Store

```typescript
type ConnectionState = {
  status: "disconnected" | "connecting" | "connected" | "reconnecting";
  hello: HelloOk | null;
  error: string | null;
  reconnectMs: number | null;    // null when connected

  // Derived
  serverVersion: string | null;
  defaultAgentId: string;
  mainSessionKey: string;
  availableMethods: string[];
};
```

### Chat Store

```typescript
type ChatState = {
  sessionKey: string;
  messages: Message[];
  streamingText: string | null;
  streamingRunId: string | null;
  pendingAttachments: Attachment[];
  error: string | null;
  loading: boolean;
  sendQueue: string[];           // Messages queued while a run is active

  // Actions
  loadHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  addAttachment: (file: File) => Promise<void>;
  removeAttachment: (index: number) => void;
  clearError: () => void;
};
```

### Session Store

```typescript
type SessionState = {
  sessions: SessionSummary[];
  activeKey: string;
  loading: boolean;

  loadSessions: () => Promise<void>;
  switchSession: (key: string) => Promise<void>;
  createSession: () => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
};
```

### Inter-Store Communication

Stores talk to each other via Zustand's `subscribe` and direct imports:

```
connectionStore.onConnect
  → sessionStore.loadSessions()
  → chatStore.loadHistory()
  → modelStore.loadModels()
  → agentStore.loadAgents()

chatStore.onFinal
  → sessionStore.loadSessions()    // Refresh sidebar

sessionStore.switchSession(key)
  → chatStore.abort()              // Abort active run
  → chatStore.setSessionKey(key)
  → chatStore.loadHistory()
```

---

## Protocol Method Usage Map

| Feature | Protocol Methods | Events |
|---------|-----------------|--------|
| Connect | `connect` | `connect.challenge`, `tick`, `shutdown` |
| Send message | `chat.send` | `chat` (delta, final, aborted, error) |
| Load history | `chat.history` | — |
| Abort | `chat.abort` | `chat` (aborted) |
| Inject note | `chat.inject` | `chat` (final) |
| List sessions | `sessions.list` | — |
| Switch session | `chat.history` | — |
| New chat | `sessions.reset` | — |
| Rename chat | `sessions.patch` (label) | — |
| Delete chat | `sessions.delete` | — |
| List models | `models.list` | — |
| Switch model | `sessions.patch` (model) | — |
| Set thinking | `sessions.patch` (thinkingLevel) | — |
| List agents | `agents.list` | — |
| Tool events | — | `agent` (stream: "tool") |
| Set verbose | `sessions.patch` (verboseLevel) | — |
| Image attach | `chat.send` (attachments) | — |
| Connection health | — | `tick` |
| Server restart | — | `shutdown` |

---

## Non-Goals (Out of Scope)

These are explicitly not in scope for the initial client:

- **Voice/talk mode**: Requires `talkMode` channel support and audio streaming
- **Canvas/A2UI**: The gateway supports embedded canvases; we don't render them
- **Node hosting**: No exec, screen, camera, location capabilities
- **Plugin SDK**: No plugin loading; this is a pure chat client
- **OpenAI/OpenResponses HTTP API**: We use WebSocket exclusively
- **Multi-gateway**: One gateway connection at a time
- **Offline mode**: No local message caching or service worker
- **User management**: Single-user client, no login system
- **Message editing/deletion**: Not supported by the protocol
- **Message reactions**: Not part of the protocol
- **File uploads beyond images**: The WebSocket protocol only supports image attachments
  (the OpenResponses HTTP API supports PDFs and text files, but we use WebSocket)

---

## Dependencies

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "react-markdown": "^10.0.0",
    "rehype-highlight": "^8.0.0",
    "remark-gfm": "^5.0.0",
    "@noble/ed25519": "3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "vitest": "^3.0.0",
    "playwright": "^1.50.0",
    "@vitest/browser-playwright": "^3.0.0"
  }
}
```

Total production dependencies: **6** (React, Zustand, react-markdown, rehype-highlight, remark-gfm, @noble/ed25519). Deliberately minimal.

---

## Build & Deploy

```bash
# Development
pnpm install
pnpm dev                    # Vite dev server on :5173

# Production build
pnpm build                  # Output to dist/
pnpm preview                # Preview production build

# Test
pnpm test                   # Vitest unit tests
pnpm test:e2e               # Playwright E2E tests
```

**Deployment options**:
- Static hosting (Vercel, Netlify, Cloudflare Pages) — just serve `dist/`
- Self-hosted alongside gateway — serve from gateway's static file handler
- Docker — nginx serving the static build

**Environment configuration**:
```env
VITE_GATEWAY_URL=ws://localhost:4080     # Gateway WebSocket URL
VITE_GATEWAY_TOKEN=                       # Optional: pre-configured token
```

The gateway URL and token can also be set at runtime via the Auth Gate UI.

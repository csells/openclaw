# ClawTalk

A modern AI chat web client built on the OpenClaw Gateway WebSocket protocol.

## Features

- Real-time streaming chat with markdown rendering
- WebSocket protocol with challenge handshake and auto-reconnect
- Dark theme UI with responsive layout
- Token-based authentication with persistent storage

## Quick Start

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Enter your gateway URL and token to connect.

## Environment Variables

```env
VITE_GATEWAY_URL=ws://localhost:4080     # Gateway WebSocket URL
VITE_GATEWAY_TOKEN=                       # Optional: pre-configured token
```

## Project Structure

```
clawtalk/
├── src/                        # Application source
│   ├── gateway/                #   Protocol layer (WebSocket client)
│   ├── stores/                 #   State layer (Zustand stores)
│   ├── components/             #   UI layer (React components)
│   └── hooks/                  #   React hooks
├── specs/                      # Design & research documents
│   ├── design.md               #   Architecture & milestone plan
│   ├── research-openclaw-chat-client-protocol.md
│   └── ramble.md               #   Original vision
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Tech Stack

- React 19, TypeScript, Vite 6
- Tailwind CSS 4
- Zustand (state management)
- react-markdown + remark-gfm (message rendering)

## Build

```bash
npm run build     # Production build to dist/
npm run preview   # Preview production build
```

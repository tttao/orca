# Orca Self-Hosted Web IDE

## Goal
Run Orca entirely in a browser, self-hosted on any machine that runs Node.js, without the Electron desktop app. One command deploys it; users connect with a browser.

## Current state (baseline)
`vite.web.config.ts` already builds a static SPA into `out/web/` (relative asset URLs via `base: './'`, so it works behind a reverse proxy). However `src/renderer/src/web/main.tsx` is a **pairing client**: it shows `WebConnect` and only renders `App` once paired with a *desktop* Orca host via `web-runtime-client` (WebSocket). It is not a standalone IDE and cannot be self-hosted alone.

The API surface the frontend expects from a host is defined by `PreloadApi` (`src/preload/api-types.ts`) and assembled in `src/renderer/src/web/web-preload-api.ts` — pty/terminal, fs, git, worktrees, repos, sessions, agent accounts, CLI, runtime, notifications, etc. A self-hosted web IDE must implement that same contract server-side.

## Design
- **Frontend (standalone):** `src/renderer/src/web/web-standalone.tsx` boots `App` directly (like the desktop `main.tsx`), skips the `WebConnect` pairing screen, and installs `window.api` backed by a WebSocket + fetch transport to the local server. New entry HTML `src/renderer/src/web-standalone-index.html`.
- **Backend:** `config/scripts/web-server/index.ts` — Node `http` + `ws` server. Serves the built static assets; WebSocket endpoint `/ws` carries JSON-RPC-style `PreloadApi` calls; REST endpoints for health/sessions. Spawns real shell/agent processes (node-pty-style) for terminals and agents.
- **Build:** `vite.web.standalone.config.ts` → `out/web-standalone/`; scripts `dev:web-standalone`, `build:web-standalone`, `web-server`.
- **Deploy:** `pnpm run build:web-standalone` then `pnpm run web-server` (or `tsx config/scripts/web-server/index.ts`) on any host; browse `http://<host>:<port>`.

## Phases
1. **Scaffolding (this session):** server skeleton (static serving + WS + health/sessions + pty), standalone frontend entry, build config + scripts, this spec.
2. **Port PreloadApi:** implement fs, git, worktrees, repos, sessions, agent spawn, CLI, notifications on the server; wire `window.api` transport.
3. **Verify:** build + run end-to-end in an environment with ≥1 GB RAM (this box OOMs the full Vite bundle at ~500 MB free). Typecheck the new code here instead.

## Non-goals for phase 1
- Full Electron parity (design mode, computer use, native chat, macOS keychain, WSL, auto-updater).
- Multi-user auth (single-user by default; auth is phase 3 / deployment concern).
- In-browser agent execution (agents run server-side via node-pty/ssh, same as the desktop app).

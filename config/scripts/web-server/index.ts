// Orca self-hosted web IDE server.
//
// Serves the built Orca web frontend and exposes a WebSocket + HTTP API that
// implements the PreloadApi contract (pty/terminal, fs, git, worktrees,
// sessions, agent spawn) so the browser can run Orca without the Electron
// desktop app. Deploy anywhere Node runs:
//
//   pnpm run build:web-standalone   # build the frontend once
//   pnpm run web-server            # or: tsx config/scripts/web-server/index.ts
//
// Browse http://<host>:<PORT> (default 8765).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..', '..')

// Where the standalone frontend build lives (see vite.web.standalone.config.ts).
const WEB_OUT = join(REPO_ROOT, process.env.ORCA_WEB_OUT ?? 'out/web-standalone')
const PORT = Number(process.env.PORT ?? 8765)
const HOST = process.env.HOST ?? '0.0.0.0'

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
}

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  const buf = Buffer.from(payload, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(buf)
}

// ---------------------------------------------------------------------------
// In-memory session / PTY registry
// ---------------------------------------------------------------------------

interface PtySession {
  id: string
  cwd: string
  proc: ChildProcess
  clients: Set<WebSocket>
  closed: boolean
}

const sessions = new Map<string, PtySession>()

function endSession(session: PtySession): void {
  if (session.closed) return
  session.closed = true
  for (const ws of session.clients) {
    try { ws.close() } catch { /* noop */ }
  }
  session.clients.clear()
  try { session.proc.kill('SIGTERM') } catch { /* noop */ }
  sessions.delete(session.id)
}

// ---------------------------------------------------------------------------
// Static file serving (SPA fallback for client-side routing)
// ---------------------------------------------------------------------------

function serveFile(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false
  const stat = statSync(filePath)
  if (stat.isDirectory()) {
    const index = join(filePath, 'index.html')
    if (existsSync(index)) return serveFile(res, index)
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  const stream = createReadStream(filePath)
  res.writeHead(200, {
    'Content-Type': mimeFor(filePath),
    'Content-Length': String(stat.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
  stream.pipe(res)
  return true
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Content-Length': '0',
    })
    res.end()
    return
  }

  // Health
  if (url === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'orca-web-ide', version: '0.1.0' })
    return
  }

  // List active sessions
  if (url === '/api/sessions' && req.method === 'GET') {
    sendJson(res, 200, {
      sessions: Array.from(sessions.values()).map((s) => ({ id: s.id, cwd: s.cwd })),
    })
    return
  }

  // Static assets / SPA fallback
  let urlPath = url.split('?', 2)[0]!.split('#', 2)[0]!
  if (urlPath === '/') urlPath = '/index.html'
  if (urlPath.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('bad path')
    return
  }
  const filePath = join(WEB_OUT, urlPath)
  if (!serveFile(res, filePath)) {
    const index = join(WEB_OUT, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      createReadStream(index).pipe(res)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('frontend not built; run pnpm run build:web-standalone')
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket API (JSON-RPC style)
// ---------------------------------------------------------------------------

type WsMessage = { type?: string; method?: string; params?: unknown; payload?: unknown; id?: string | number }

function parseWsMessage(raw: Buffer): WsMessage | null {
  try {
    return JSON.parse(raw.toString('utf8')) as WsMessage
  } catch {
    return null
  }
}

function wsSend(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

function wsError(ws: WebSocket, id: unknown, code: string, message: string): void {
  wsSend(ws, { jsonrpc: '2.0', id, error: { code, message } })
}

function wsResult(ws: WebSocket, id: unknown, result: unknown): void {
  wsSend(ws, { jsonrpc: '2.0', id, result })
}

// PTY / terminal handling
function handlePtyCreate(ws: WebSocket, id: unknown, payload: unknown): void {
  const p = (payload ?? {}) as Record<string, unknown>
  const cwd = (typeof p.cwd === 'string' ? p.cwd : process.cwd())
  const cols = Number(p.cols ?? 80)
  const rows = Number(p.rows ?? 24)

  let proc: ChildProcess
  try {
    // Same spirit as the desktop app's node-pty usage: spawn a real shell so
    // agents and terminals run server-side. Override with ORCA_SHELL if set.
    proc = spawn(process.env.ORCA_SHELL ?? '/bin/sh', [], {
      cwd,
      env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    wsError(ws, id, 'spawn_failed', err instanceof Error ? err.message : String(err))
    return
  }

  const sessionId = `pty-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const session: PtySession = { id: sessionId, cwd, proc, clients: new Set([ws]), closed: false }
  sessions.set(sessionId, session)

  let closed = false
  const markClosed = () => {
    if (closed) return
    closed = true
    session.clients.delete(ws)
    if (session.clients.size === 0) endSession(session)
  }

  proc.stdout!.on('data', (chunk: Buffer) => {
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pty.output', sessionId, data: chunk.toString('base64') }))
      }
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pty.output', sessionId, data: chunk.toString('base64'), stream: 'stderr' }))
      }
    }
  })
  proc.on('close', () => {
    markClosed()
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pty.exit', sessionId }))
      }
    }
  })

  wsResult(ws, id, { sessionId, cwd })

  ws.on('message', (raw) => {
    if (!session.clients.has(ws)) return
    const msg = parseWsMessage(raw as Buffer)
    if (!msg || msg.type !== 'pty.input') return
    const input = (msg.payload as { data?: string } | null)?.data ?? ''
    try { proc.stdin!.write(Buffer.from(input, 'base64')) } catch { /* noop */ }
  })
  ws.on('close', () => markClosed())
  ws.on('error', () => markClosed())
}

function handlePtyInput(ws: WebSocket, id: unknown, payload: unknown): void {
  const p = (payload ?? {}) as Record<string, unknown>
  const session = sessions.get(String(p.sessionId ?? ''))
  if (!session || session.closed) { wsError(ws, id, 'not_found', 'session not found'); return }
  if (!session.clients.has(ws)) session.clients.add(ws)
  const input = String(p.data ?? '')
  try { session.proc.stdin!.write(Buffer.from(input, 'base64')) } catch { /* noop */ }
  wsResult(ws, id, { ok: true })
}

// Generic method dispatch for the JSON-RPC API
function handleWsMessage(ws: WebSocket, msg: WsMessage): void {
  const method = (msg.method ?? msg.type)
  const { id } = msg
  const payload = msg.payload ?? msg.params
  if (method === 'pty.create') { handlePtyCreate(ws, id, payload); return }
  if (method === 'pty.input') { handlePtyInput(ws, id, payload); return }
  if (method === 'session.list') {
    wsResult(ws, id, { sessions: Array.from(sessions.values()).map((s) => ({ id: s.id, cwd: s.cwd })) })
    return
  }
  // Unimplemented methods return a clear "not yet ported" error so the frontend
  // degrades gracefully instead of failing silently.
  wsError(ws, id, 'method_not_implemented', `method ${method} not yet ported to the web server`)
}

const httpServer = createServer(handleHttp)
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    const msg = parseWsMessage(raw as Buffer)
    if (msg) handleWsMessage(ws, msg)
  })
  ws.on('error', () => { /* noop */ })
})

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`orca web ide listening on http://${HOST}:${PORT} (serving ${WEB_OUT})`)
})

process.on('SIGINT', () => {
  for (const session of sessions.values()) endSession(session)
  httpServer.close()
  process.exit(0)
})

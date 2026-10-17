// Orca self-hosted web IDE server.
//
// Serves the built Orca web frontend and exposes a WebSocket + HTTP API that
// implements the PreloadApi contract (pty/terminal, fs, git, worktrees,
// sessions) so the browser can run Orca without the Electron desktop app.
//
//   pnpm run build:web-standalone   # build the frontend once
//   pnpm run web-server            # or: tsx config/scripts/web-server/index.ts
//
// Browse http://<host>:<PORT> (default 8765). Set ORCA_WORKSPACE_ROOT to the
// directory the IDE should operate on (defaults to cwd).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, promises as fs, statSync } from 'node:fs'
import { join, dirname, extname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, execFile, type ChildProcess } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..', '..')

// Workspace root the IDE operates on. All file paths are resolved against this
// root and path-traversal is rejected.
const WORKSPACE_ROOT = resolve(process.env.ORCA_WORKSPACE_ROOT ?? process.cwd())

// Where the standalone frontend build lives (see vite.web.standalone.config.ts).
const WEB_OUT = join(REPO_ROOT, process.env.ORCA_WEB_OUT ?? 'out/web-standalone')
const PORT = Number(process.env.PORT ?? 8765)
const HOST = process.env.HOST ?? '0.0.0.0'

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function safePath(userPath: string): string {
  const resolved = resolve(WORKSPACE_ROOT, userPath)
  const rel = relative(WORKSPACE_ROOT, resolved)
  // rel === '' means resolved IS the workspace root (safe). rel.startsWith('..')
  // means the path escapes above the root (unsafe).
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.includes(`${sep}..${sep}`)) {
    throw new Error(`path outside workspace root: ${userPath}`)
  }
  return resolved
}

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

import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function runGit(worktreePath: string, args: string[]): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return execFileAsync('git', args, { cwd: worktreePath, maxBuffer: 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr), error: null }),
    (error: Error & { stdout?: string; stderr?: string }) => ({
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      error,
    })
  )
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
    sendJson(res, 200, { ok: true, service: 'orca-web-ide', version: '0.2.0', workspace: WORKSPACE_ROOT })
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

// ---- PTY / terminal ----

function handlePtyCreate(ws: WebSocket, id: unknown, payload: unknown): void {
  const p = (payload ?? {}) as Record<string, unknown>
  const cwd = safePath(typeof p.cwd === 'string' ? p.cwd : '')
  const cols = Number(p.cols ?? 80)
  const rows = Number(p.rows ?? 24)

  let proc: ChildProcess
  try {
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
    const input = ((msg.payload ?? msg.params) as { data?: string } | null)?.data ?? ''
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

// ---- Filesystem ----

async function handleFsReadDir(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const dirPath = safePath(String(p.dirPath ?? ''))
  const entries: Array<{ name: string; isDirectory: boolean }> = []
  for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
    entries.push({ name: entry.name, isDirectory: entry.isDirectory() })
  }
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
  wsResult(ws, id, { entries })
}

async function handleFsReadFile(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const filePath = safePath(String(p.filePath ?? ''))
  const content = await fs.readFile(filePath, 'utf8')
  wsResult(ws, id, { content, isBinary: false })
}

async function handleFsStat(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const filePath = safePath(String(p.filePath ?? ''))
  const stat = await fs.stat(filePath)
  wsResult(ws, id, { size: stat.size, isDirectory: stat.isDirectory(), mtime: stat.mtimeMs })
}

async function handleFsPathExists(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  let exists = false
  try {
    const filePath = safePath(String(p.filePath ?? ''))
    await fs.access(filePath)
    exists = true
  } catch { /* noop */ }
  wsResult(ws, id, { exists })
}

async function handleFsWriteFile(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const filePath = safePath(String(p.filePath ?? ''))
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, String(p.content ?? ''), 'utf8')
  wsResult(ws, id, { ok: true })
}

async function handleFsCreateFile(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const filePath = safePath(String(p.filePath ?? ''))
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, '', 'utf8')
  wsResult(ws, id, { ok: true })
}

async function handleFsCreateDir(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const dirPath = safePath(String(p.dirPath ?? ''))
  await fs.mkdir(dirPath, { recursive: true })
  wsResult(ws, id, { ok: true })
}

async function handleFsRename(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const oldPath = safePath(String(p.oldPath ?? ''))
  const newPath = safePath(String(p.newPath ?? ''))
  await fs.mkdir(dirname(newPath), { recursive: true })
  await fs.rename(oldPath, newPath)
  wsResult(ws, id, { ok: true })
}

async function handleFsDeletePath(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const targetPath = safePath(String(p.targetPath ?? ''))
  const recursive = Boolean(p.recursive)
  const stat = await fs.stat(targetPath)
  if (stat.isDirectory() && recursive) {
    await fs.rm(targetPath, { recursive: true, force: true })
  } else if (stat.isDirectory()) {
    await fs.rmdir(targetPath)
  } else {
    await fs.unlink(targetPath)
  }
  wsResult(ws, id, { ok: true })
}

// ---- Git ----

async function handleGitStatus(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const worktreePath = safePath(String(p.worktreePath ?? ''))
  const { stdout } = await runGit(worktreePath, ['status', '--porcelain=v1', '--branch'])
  wsResult(ws, id, { raw: stdout })
}

async function handleGitDiff(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const worktreePath = safePath(String(p.worktreePath ?? ''))
  const filePath = String(p.filePath ?? '')
  const staged = Boolean(p.staged)
  const args: string[] = ['diff']
  if (staged) args.push('--cached')
  args.push('--', filePath)
  const { stdout } = await runGit(worktreePath, args)
  wsResult(ws, id, { diff: stdout })
}

async function handleGitHistory(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const worktreePath = safePath(String(p.worktreePath ?? ''))
  const limit = Number(p.limit ?? 50)
  const { stdout } = await runGit(worktreePath, ['log', `--max-count=${limit}`, '--pretty=format:%H|%an|%ae|%ad|%s', '--date=iso'])
  wsResult(ws, id, { history: stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, author, email, date, ...subjectParts] = line.split('|')
    return { hash, author, email, date, subject: subjectParts.join('|') }
  }) })
}

// ---- Worktrees ----

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

function entryName(path: string): string {
  const parts = path.split(sep).filter(Boolean)
  return parts[parts.length - 1] || path
}

async function handleWorktreesList(ws: WebSocket, id: unknown, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>
  const repoId = String(p.repoId ?? WORKSPACE_ROOT)
  const root = safePath(repoId)
  const worktrees: Array<{ id: string; path: string; name: string; repoId: string }> = []
  if (await isGitRepo(root)) {
    worktrees.push({ id: entryName(root), path: root, name: entryName(root), repoId: root })
  }
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      if (await isGitRepo(dir)) {
        worktrees.push({ id: entry.name, path: dir, name: entry.name, repoId: root })
      }
    }
  } catch { /* root may not exist */ }
  wsResult(ws, id, { worktrees })
}

async function handleWorktreesListAll(ws: WebSocket, id: unknown): Promise<void> {
  const worktrees: Array<{ id: string; path: string; name: string; repoId: string }> = []
  if (await isGitRepo(WORKSPACE_ROOT)) {
    worktrees.push({ id: entryName(WORKSPACE_ROOT), path: WORKSPACE_ROOT, name: entryName(WORKSPACE_ROOT), repoId: WORKSPACE_ROOT })
  }
  try {
    for (const entry of await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(WORKSPACE_ROOT, entry.name)
      if (await isGitRepo(dir)) {
        worktrees.push({ id: entry.name, path: dir, name: entry.name, repoId: WORKSPACE_ROOT })
      }
    }
  } catch { /* noop */ }
  wsResult(ws, id, { worktrees })
}

// ---- Session ----

async function handleSessionGet(ws: WebSocket, id: unknown): Promise<void> {
  wsResult(ws, id, { state: { worktrees: [], activeWorktreeId: null } })
}

async function handleSessionListHostIds(ws: WebSocket, id: unknown): Promise<void> {
  wsResult(ws, id, { hostIds: ['local'] })
}

// ---- Method dispatch ----

function handleWsMessage(ws: WebSocket, msg: WsMessage): void {
  const method = (msg.method ?? msg.type)
  const { id } = msg
  const payload = msg.payload ?? msg.params
  const handlers: Record<string, (ws: WebSocket, id: unknown, payload: unknown) => void | Promise<void>> = {
    'pty.create': handlePtyCreate,
    'pty.input': handlePtyInput,
    'session.list': async (_ws, _id) => {
      wsResult(_ws, _id, { sessions: Array.from(sessions.values()).map((s) => ({ id: s.id, cwd: s.cwd })) })
    },
    'fs.readDir': handleFsReadDir,
    'fs.readFile': handleFsReadFile,
    'fs.stat': handleFsStat,
    'fs.pathExists': handleFsPathExists,
    'fs.writeFile': handleFsWriteFile,
    'fs.createFile': handleFsCreateFile,
    'fs.createDir': handleFsCreateDir,
    'fs.rename': handleFsRename,
    'fs.deletePath': handleFsDeletePath,
    'git.status': handleGitStatus,
    'git.diff': handleGitDiff,
    'git.history': handleGitHistory,
    'worktrees.list': handleWorktreesList,
    'worktrees.listAll': async (_ws, _id) => handleWorktreesListAll(_ws, _id),
    'session.get': async (_ws, _id) => handleSessionGet(_ws, _id),
    'session.listHostIds': async (_ws, _id) => handleSessionListHostIds(_ws, _id),
  }
  const handler = handlers[method]
  if (!handler) {
    wsError(ws, id, 'method_not_implemented', `method ${method} not yet ported to the web server`)
    return
  }
  const result = handler(ws, id, payload)
  if (result && typeof result.then === 'function') {
    result.catch((err) => {
      wsError(ws, id, 'handler_error', err instanceof Error ? err.message : String(err))
    })
  }
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
  console.log(`orca web ide listening on http://${HOST}:${PORT} (serving ${WEB_OUT}, workspace ${WORKSPACE_ROOT})`)
})

process.on('SIGINT', () => {
  for (const session of sessions.values()) endSession(session)
  httpServer.close()
  process.exit(0)
})

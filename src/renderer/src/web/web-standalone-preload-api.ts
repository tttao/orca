// Standalone preload API for the self-hosted Orca web IDE.
//
// Imports the same `PreloadApi` contract the desktop web client uses
// (web-preload-api.ts) and implements it over a WebSocket + fetch transport to
// config/scripts/web-server/index.ts. Methods not yet ported to the server fall
// back through `withFallback` to safe defaults (see web-fallback-api.ts), so
// the renderer boots without the desktop host.
//
// Phase 1: pty.create/pty.input and a handful of read-only namespaces are real;
// everything else is a graceful stub. Phase 2 ports the rest of PreloadApi.

import type { PreloadApi } from '../../../preload/api-types'
import { withFallback } from './preload-api/web-fallback-api'

// WebSocket origin of the local web IDE server. In dev (vite on 5173) this
// becomes ws://localhost:5173/ws; in production served by the server on 8765
// it becomes ws://<host>:8765/ws.
const API_BASE =
  typeof location !== 'undefined' && location.origin
    ? location.origin.replace(/^http/, 'ws')
    : 'ws://localhost:8765'

let socket: WebSocket | null = null
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
let seq = 0

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(`${API_BASE}/ws`)
    socket.onopen = () => resolve()
    socket.onerror = (event: Event) => reject(new Error(`WebSocket error to ${API_BASE}/ws`))
    socket.onmessage = (event: MessageEvent) => {
      let msg: { id?: string; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }
      const id = msg.id != null ? String(msg.id) : null
      const settle = id != null ? pending.get(id) : null
      if (!settle) return
      pending.delete(id)
      if (msg.error) settle.reject(new Error(String(msg.error)))
      else settle.resolve(msg.result)
    }
  })
}

function call(method: string, payload?: unknown): Promise<unknown> {
  const ensure = () =>
    new Promise<void>((resolve, reject) => {
      if (socket && socket.readyState === WebSocket.OPEN) return resolve()
      connect().then(resolve).catch(reject)
    })
  return ensure().then(() => {
    const id = String(++seq)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: payload }))
    })
  })
}

function createStandalonePreloadApi(): PreloadApi {
  return {
    app: {
      getVersion: () => Promise.resolve('0.1.0-web')
    },
    platform: {
      getInfo: () => Promise.resolve({ name: 'web', arch: 'x64' })
    },
    pty: {
      create: (options: unknown) =>
        call('pty.create', options).then((result) => result as { sessionId?: string; cwd?: string }),
      input: (sessionId: string, data: string) => call('pty.input', { sessionId, data })
    },
    session: {
      list: () =>
        call('session.list').then(
          (result) => (result as { sessions?: unknown[] }).sessions ?? []
        )
    },
    settings: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(undefined)
    },
    notifications: {
      show: () => Promise.resolve(undefined)
    },
    telemetryTrack: () => Promise.resolve(undefined),
    telemetrySetOptIn: () => Promise.resolve(undefined),
    telemetryGetConsentState: () => Promise.resolve({ state: 'granted' }),
    telemetryAcknowledgeBanner: () => Promise.resolve(undefined),
    cli: {
      run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    },
    git: {
      status: () => Promise.resolve({})
    },
    fs: {
      read: () => Promise.resolve('')
    },
    worktrees: {
      list: () => Promise.resolve([])
    },
    repos: {
      list: () => Promise.resolve([])
    },
    runtime: {
      listEnvironments: () => Promise.resolve([])
    }
  } as unknown as PreloadApi
}

export function installStandalonePreloadApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  window.api = withFallback(createStandalonePreloadApi(), []) as PreloadApi
  return connect().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(
      '[web-standalone] server transport unavailable; API calls fall back to defaults',
      error
    )
  })
}

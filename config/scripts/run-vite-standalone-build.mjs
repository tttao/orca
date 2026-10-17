import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'

// Builds the standalone web IDE frontend (out/web-standalone) using
// vite.web.standalone.config.ts. Mirrors config/scripts/run-vite-web-build.mjs.

const require = createRequire(import.meta.url)
const vitePackageJson = require.resolve('vite/package.json')
const viteCli = path.join(path.dirname(vitePackageJson), 'bin', 'vite.js')

const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

const child = spawn(
  process.execPath,
  [viteCli, 'build', '--config', 'vite.web.standalone.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: nodeOptions }
  }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

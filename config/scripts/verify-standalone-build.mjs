import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Verifies the standalone web build emitted relative asset URLs so it can be
// served behind any reverse-proxy path prefix by config/scripts/web-server.

const indexPath = resolve('out/web-standalone/web-standalone-index.html')
const html = await readFile(indexPath, 'utf8')

const absoluteAssetReference = /\b(?:src|href)=["']\/assets\//.exec(html)

if (absoluteAssetReference) {
  console.error(
    `Standalone web build must use relative asset URLs; found ${absoluteAssetReference[0]} in ${indexPath}`
  )
  process.exit(1)
}

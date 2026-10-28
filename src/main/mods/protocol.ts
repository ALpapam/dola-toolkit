// ---------------------------------------------------------------------------
// Dola Toolkit — dola-mod:// protocol
//
// Serves an installed mod's files so the renderer can load its bundle with a normal
// <script> tag. `dola-mod://<id>/<path>` maps to `<userData>/mods/<id>/<path>`, and the
// path is resolved and checked to stay inside that folder — a mod must never be able
// to read outside its own directory.
// ---------------------------------------------------------------------------

import { protocol } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { normalize, join, extname, sep } from 'node:path'
import { modDir } from './manager'

export const MOD_SCHEME = 'dola-mod'

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.html': 'text/html; charset=utf-8'
}

export function registerModProtocol(): void {
  protocol.handle(MOD_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // dola-mod://library/index.js → host "library", path "/index.js"
      const id = decodeURIComponent(url.hostname)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) return new Response('bad mod id', { status: 400 })

      const root = normalize(modDir(id))
      const target = normalize(join(root, rel || 'index.html'))
      // a mod may not escape its own folder with ../ or an absolute path
      if (target !== root && !target.startsWith(root + sep)) {
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return new Response('not found', { status: 404 })
      }
      const body = readFileSync(target)
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      return new Response('error', { status: 500 })
    }
  })
}

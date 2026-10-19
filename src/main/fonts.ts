// ---------------------------------------------------------------------------
// Dola Toolkit — reader font service (main process)
//
// Responsibilities
//   * know where user fonts live (<userData>/fonts)
//   * import a font file the user picked (copy into the managed dir)
//   * enumerate fonts = bundled default + every managed file
//   * hand the renderer a URL it can put in an @font-face src
//
// Fonts are never loaded through file:// from the renderer (the CSP forbids it),
// so the bytes are streamed over a custom `dola-font://` protocol registered in
// main. That keeps the renderer sandboxed while still allowing any user font.
// ---------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, protocol } from 'electron'
import type { FontFace, FontList } from '@shared/types'
import {
  DEFAULT_READER_FONT_FAMILY,
  DEFAULT_READER_FONT_ID,
  FONT_FILE_EXTENSIONS,
  fontFormatOf
} from '@shared/fonts'

export const FONT_SCHEME = 'dola-font'

/** basename without extension, used as the stable id / family name */
function stem(file: string): string {
  const base = basename(file)
  const ext = extname(base)
  return base.slice(0, base.length - ext.length)
}

export function fontsDir(): string {
  const dir = join(app.getPath('userData'), 'fonts')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Directory holding the fonts bundled with the app (read-only). */
export function bundledFontsDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'fonts')
  return join(app.getAppPath(), 'resources', 'fonts')
}

/** Register the streaming protocol handler. Call once, after app.whenReady(). */
export function registerFontProtocol(): void {
  try {
    protocol.handle(FONT_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        // Chromium may normalise `dola-font:///builtin/x.woff2` so that the
        // first segment lands in `host` instead of `pathname`. Join both back
        // together and split on "/" so either shape works.
        const full = `${url.host ?? ''}${url.pathname ?? ''}`
        const parts = full.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
        const [kind, ...rest] = parts
        const rel = rest.join('/')
        if (!kind || !rel || rel.includes('..')) {
          console.warn('[dola-font] bad request', JSON.stringify({ raw: request.url, full, parts }))
          return new Response('bad request', { status: 400 })
        }
        const dir = kind === 'builtin' ? bundledFontsDir() : fontsDir()
        const abs = join(dir, rel)
        if (!existsSync(abs)) {
          console.warn('[dola-font] not found', abs)
          return new Response('not found', { status: 404 })
        }
        const { readFileSync } = await import('node:fs')
        const buf = readFileSync(abs)
        const fmt = fontFormatOf(abs)
        const mime =
          fmt === 'woff2'
            ? 'font/woff2'
            : fmt === 'woff'
              ? 'font/woff'
              : fmt === 'otf'
                ? 'font/otf'
                : 'font/ttf'
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: {
            'content-type': mime,
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*'
          }
        })
      } catch {
        return new Response('error', { status: 500 })
      }
    })
  } catch {
    /* already registered (HMR / second boot) */
  }
}

/** A URL the renderer can use in `src: url(...)`. */
export function fontUrl(id: string): string | null {
  if (id === DEFAULT_READER_FONT_ID) {
    const file = bundledFontRegular()
    if (!file) return null
    return `${FONT_SCHEME}:///builtin/${encodeURIComponent(file)}`
  }
  const dir = fontsDir()
  for (const name of safeList(dir)) {
    if (stem(name) === id) return `${FONT_SCHEME}:///user/${encodeURIComponent(name)}`
  }
  return null
}

/** The regular weight file of the bundled family, if present. */
export function bundledFontRegular(): string | null {
  const dir = bundledFontsDir()
  if (!existsSync(dir)) return null
  const preferred = [
    'JetBrainsMapleMono-Regular.woff2',
    'JetBrainsMapleMono-Regular.ttf',
    'JetBrainsMapleMonoNL-Regular.woff2',
    'JetBrainsMapleMonoNL-Regular.ttf'
  ]
  for (const name of preferred) {
    if (existsSync(join(dir, name))) return name
  }
  const first = safeList(dir).find((f) => fontFormatOf(f))
  return first ?? null
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => fontFormatOf(f) !== null)
  } catch {
    return []
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** Enumerate every selectable family. */
export function listFonts(): FontList {
  const out: FontFace[] = []

  // builtin (bundled) family
  const builtinDir = bundledFontsDir()
  const builtinFiles = existsSync(builtinDir) ? safeList(builtinDir) : []
  const regular = bundledFontRegular()
  if (regular) {
    out.push({
      id: DEFAULT_READER_FONT_ID,
      name: DEFAULT_READER_FONT_FAMILY,
      path: join(builtinDir, regular),
      format: fontFormatOf(regular) ?? 'ttf',
      managed: false,
      size: builtinFiles.reduce((sum, f) => sum + sizeOf(join(builtinDir, f)), 0),
      builtin: true
    })
  }

  // user-imported families
  const dir = fontsDir()
  const seen = new Set<string>()
  for (const file of safeList(dir).sort()) {
    const id = stem(file)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: id,
      path: join(dir, file),
      format: fontFormatOf(file) ?? 'ttf',
      managed: true,
      size: sizeOf(join(dir, file)),
      builtin: false
    })
  }

  return { fonts: out, defaultId: DEFAULT_READER_FONT_ID }
}

export interface ImportResult {
  imported: FontFace[]
  skipped: { path: string; reason: string }[]
}

/**
 * Copy the given font files into the managed dir.
 * A .zip / .ttc is expanded by the caller (renderer asks the user to pick a
 * single font file); here we only accept real font files.
 */
export function importFonts(paths: string[]): ImportResult {
  const dir = fontsDir()
  const imported: FontFace[] = []
  const skipped: { path: string; reason: string }[] = []

  for (const src of paths) {
    try {
      const fmt = fontFormatOf(src)
      if (!fmt) {
        skipped.push({ path: src, reason: '不是受支持的字体文件（ttf/otf/woff/woff2）' })
        continue
      }
      if (!existsSync(src)) {
        skipped.push({ path: src, reason: '文件不存在' })
        continue
      }
      const target = join(dir, basename(src))
      copyFileSync(src, target)
      imported.push({
        id: stem(basename(src)),
        name: stem(basename(src)),
        path: target,
        format: fmt,
        managed: true,
        size: sizeOf(target),
        builtin: false
      })
    } catch (e) {
      skipped.push({ path: src, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { imported, skipped }
}

/** Delete a managed font by id. The bundled font can never be removed. */
export function removeFont(id: string): { ok: boolean; reason?: string } {
  if (id === DEFAULT_READER_FONT_ID) return { ok: false, reason: '内置字体不可删除' }
  const dir = fontsDir()
  const match = safeList(dir).find((f) => stem(f) === id)
  if (!match) return { ok: false, reason: '未找到该字体' }
  try {
    unlinkSync(join(dir, match))
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export { FONT_FILE_EXTENSIONS }

// ---------------------------------------------------------------------------
// Dola Toolkit — cover image helpers.
//
// Image decoding normally goes through Electron's `nativeImage`. For headless
// tests (plain `node`, no Electron) the module accepts an injected
// implementation and otherwise falls back to a tiny built-in PNG decoder so a
// dominant colour can still be computed without any native dependency.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { coverColorFromTitle, fnv1a, rgbToHex, safeFileName } from './scan'

export interface CoverImage {
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): CoverImage
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
  toDataURL(options?: { scaleFactor?: number }): string
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  /** Electron-only; when present it is used to average pixels. */
  toBitmap?(): Buffer
}

export interface ImageOps {
  fromFile(path: string): CoverImage | null
}

let injectedOps: ImageOps | null | undefined

/** Inject an ImageOps implementation (tests / alternate runtimes). */
export function setImageOps(ops: ImageOps | null | undefined): void {
  injectedOps = ops
}

/**
 * Resolve the native image backend. Returns `null` when Electron is not
 * available (headless tests) — callers must degrade gracefully.
 */
export function getImageOps(): ImageOps | null {
  if (injectedOps !== undefined) return injectedOps
  // `require('electron')` outside a real Electron process resolves to the npm
  // package whose main script downloads the binary — never do that.
  const inElectron = Boolean(process.versions && process.versions['electron'])
  if (!inElectron) {
    injectedOps = null
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron')
    if (electron && typeof electron.nativeImage?.createFromPath === 'function') {
      injectedOps = {
        fromFile(p: string): CoverImage | null {
          try {
            const img = electron.nativeImage.createFromPath(p)
            return img && !img.isEmpty() ? (img as unknown as CoverImage) : null
          } catch {
            return null
          }
        }
      }
      return injectedOps
    }
  } catch {
    /* not running inside Electron */
  }
  injectedOps = null
  return null
}

/* ------------------------------------------------------------------ */
/* Minimal PNG decoder (fallback colour sampling)                      */
/* ------------------------------------------------------------------ */

interface Rgb {
  r: number
  g: number
  b: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunks(buf: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = []
  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Decode enough of a PNG to sample its average colour.
 * Supports 8-bit greyscale / RGB / RGBA / palette images (the common cases).
 */
export function samplePngColor(buf: Buffer): Rgb | null {
  try {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
    const chunks = pngChunks(buf)
    const ihdr = chunks.find((c) => c.type === 'IHDR')
    if (!ihdr || ihdr.data.length < 13) return null
    const width = ihdr.data.readUInt32BE(0)
    const height = ihdr.data.readUInt32BE(4)
    const bitDepth = ihdr.data[8]
    const colorType = ihdr.data[9]
    const interlace = ihdr.data[12]
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
    if (!channels) return null

    let palette: Buffer | null = null
    const plte = chunks.find((c) => c.type === 'PLTE')
    if (plte) palette = plte.data

    const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
    if (!idat.length) return null
    const raw = zlib.inflateSync(idat)
    const stride = width * channels
    if (raw.length < (stride + 1) * height) return null

    const pixels: Buffer = Buffer.alloc(stride * height)
    let prev = Buffer.alloc(stride)
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      const cur = Buffer.from(line)
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0
        const b = prev[x]
        const c = x >= channels ? prev[x - channels] : 0
        switch (filter) {
          case 1:
            cur[x] = (cur[x] + a) & 0xff
            break
          case 2:
            cur[x] = (cur[x] + b) & 0xff
            break
          case 3:
            cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff
            break
          case 4:
            cur[x] = (cur[x] + paeth(a, b, c)) & 0xff
            break
          default:
            break
        }
      }
      cur.copy(pixels, y * stride)
      prev = cur
    }

    let r = 0
    let g = 0
    let b = 0
    let weight = 0
    const stepX = Math.max(1, Math.floor(width / 24))
    const stepY = Math.max(1, Math.floor(height / 32))
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const i = y * stride + x * channels
        let pr = 0
        let pg = 0
        let pb = 0
        let alpha = 255
        if (colorType === 0 || colorType === 4) {
          pr = pg = pb = pixels[i]
          if (colorType === 4) alpha = pixels[i + 1]
        } else if (colorType === 2 || colorType === 6) {
          pr = pixels[i]
          pg = pixels[i + 1]
          pb = pixels[i + 2]
          if (colorType === 6) alpha = pixels[i + 3]
        } else if (colorType === 3 && palette) {
          const idx = pixels[i] * 3
          if (idx + 2 < palette.length) {
            pr = palette[idx]
            pg = palette[idx + 1]
            pb = palette[idx + 2]
          }
        }
        if (alpha < 32) continue
        // Chroma weighting: vivid/saturated pixels matter more for a book cover.
        const max = Math.max(pr, pg, pb)
        const min = Math.min(pr, pg, pb)
        const chroma = max - min
        if (max > 244 && chroma < 10) continue // near-white page margins
        if (max < 24) continue // near-black letterboxing
        const w = 1 + chroma * 0.9 + (1 - Math.abs(max - 160) / 255) * 0.4
        r += pr * w
        g += pg * w
        b += pb * w
        weight += w
      }
    }
    if (weight <= 0) return null
    return { r: r / weight, g: g / weight, b: b / weight }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const SAMPLE_W = 8
const SAMPLE_H = 12

/** Dominant colour of an image file, or null when it cannot be sampled. */
export async function dominantColor(imagePath: string): Promise<string | null> {
  if (!imagePath) return null
  const ops = getImageOps()
  if (ops) {
    try {
      const img = ops.fromFile(imagePath)
      if (img && !img.isEmpty()) {
        const small = img.resize({ width: SAMPLE_W, height: SAMPLE_H, quality: 'good' })
        const bitmap = small.toBitmap ? small.toBitmap() : null
        if (bitmap && bitmap.length >= SAMPLE_W * SAMPLE_H * 4) {
          let r = 0
          let g = 0
          let b = 0
          let weight = 0
          for (let i = 0; i + 3 < bitmap.length; i += 4) {
            // BGRA on both Windows and macOS bitmaps from nativeImage
            const pb = bitmap[i]
            const pg = bitmap[i + 1]
            const pr = bitmap[i + 2]
            const pa = bitmap[i + 3]
            if (pa < 32) continue
            const max = Math.max(pr, pg, pb)
            const min = Math.min(pr, pg, pb)
            const chroma = max - min
            if (max > 244 && chroma < 10) continue
            if (max < 24) continue
            const w = 1 + chroma * 0.9
            r += pr * w
            g += pg * w
            b += pb * w
            weight += w
          }
          if (weight > 0) return rgbToHex(r / weight, g / weight, b / weight)
        }
        // Fall through to raw-buffer decoding below.
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const buf = await fs.readFile(imagePath)
    const sampled = samplePngColor(buf)
    if (sampled) return rgbToHex(sampled.r, sampled.g, sampled.b)
  } catch {
    /* ignore */
  }
  return null
}

/** Dominant colour with a stable title-derived fallback. */
export async function dominantColorOrFallback(imagePath: string | null, title: string): Promise<string> {
  if (imagePath) {
    const color = await dominantColor(imagePath)
    if (color) return color
  }
  return coverColorFromTitle(title || 'dola')
}

/* ------------------------------------------------------------------ */
/* Data URL cache (renderer asks per book)                             */
/* ------------------------------------------------------------------ */

const CACHE_LIMIT = 160
const dataUrlCache = new Map<string, { url: string | null; stamp: number }>()

function cacheGet(key: string): { url: string | null; stamp: number } | undefined {
  const hit = dataUrlCache.get(key)
  if (!hit) return undefined
  // refresh LRU position
  dataUrlCache.delete(key)
  dataUrlCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: { url: string | null; stamp: number }): void {
  dataUrlCache.delete(key)
  dataUrlCache.set(key, value)
  while (dataUrlCache.size > CACHE_LIMIT) {
    const first = dataUrlCache.keys().next()
    if (first.done) break
    dataUrlCache.delete(first.value)
  }
}

export function clearCoverCache(): void {
  dataUrlCache.clear()
}

/**
 * Read a cover file as a small JPEG data URL (~320 px wide).
 * Returns null when the file is missing or cannot be decoded.
 */
export async function coverDataUrl(coverPath: string | null, maxWidth = 320): Promise<string | null> {
  if (!coverPath) return null
  let stamp = 0
  try {
    const st = await fs.stat(coverPath)
    if (!st.isFile()) return null
    stamp = st.mtimeMs
  } catch {
    return null
  }
  const key = `${coverPath}|${maxWidth}`
  const cached = cacheGet(key)
  if (cached && cached.stamp === stamp) return cached.url

  let url: string | null = null
  const ops = getImageOps()
  if (ops) {
    try {
      const img = ops.fromFile(coverPath)
      if (img && !img.isEmpty()) {
        const size = img.getSize()
        const resized = size.width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img
        const jpeg = resized.toJPEG(82)
        if (jpeg && jpeg.length) url = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      }
    } catch {
      url = null
    }
  }
  if (!url) {
    // Fall back to handing the raw file back as a data URL. SVG covers are
    // common in EPUBs and cannot be decoded by nativeImage, but the renderer can
    // display them directly — so sniff the real container instead of trusting
    // the file extension (covers are frequently saved as .jpg while holding SVG).
    try {
      const buf = await fs.readFile(coverPath)
      url = sniffImageDataUrl(buf)
    } catch {
      url = null
    }
  }
  cacheSet(key, { url, stamp })
  return url
}

/** Detect the image container from magic bytes / text head and build a data URL. */
export function sniffImageDataUrl(buf: Buffer): string | null {
  if (!buf || !buf.length) return null
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return `data:image/png;base64,${buf.toString('base64')}`
  if (buf[0] === 0xff && buf[1] === 0xd8) return `data:image/jpeg;base64,${buf.toString('base64')}`
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return `data:image/gif;base64,${buf.toString('base64')}`
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return `data:image/webp;base64,${buf.toString('base64')}`
  }
  const head = buf.subarray(0, Math.min(400, buf.length)).toString('utf8').trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) {
    // Strip a leading XML declaration — data URLs must carry the SVG element
    // itself or some engines refuse to render them.
    const text = buf.toString('utf8')
    const start = text.indexOf('<svg')
    const svg = start >= 0 ? text.slice(start) : text
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Writing covers                                                      */
/* ------------------------------------------------------------------ */

export interface SavedCover {
  path: string
  /** dominant colour of the saved image */
  color: string | null
}

/** Persist raw cover bytes into `dir`, returning the absolute file path. */
export async function saveCover(
  data: Buffer,
  dir: string,
  baseName: string,
  ext: 'jpg' | 'png' | 'svg' = 'jpg'
): Promise<SavedCover | null> {
  if (!data || !data.length) return null
  try {
    await fs.mkdir(dir, { recursive: true })
    const name = `${safeFileName(baseName, 60)}-${fnv1a(baseName + data.length).toString(16)}.${ext}`
    const target = path.join(dir, name)
    await fs.writeFile(target, data)
    const color = await dominantColor(target)
    return { path: target, color }
  } catch {
    return null
  }
}

/** Remove a cover file if it lives inside our covers directory. */
export async function removeCoverFile(coverPath: string | null, coversDir: string): Promise<void> {
  if (!coverPath) return
  try {
    const normalizedCovers = coversDir.toLowerCase().replace(/[\\/]+$/, '')
    if (!coverPath.toLowerCase().startsWith(normalizedCovers)) return
    await fs.unlink(coverPath)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Dola Toolkit — file scanning, format sniffing and text decoding helpers.
//
// This module is intentionally *pure Node* (no `electron` import) so the whole
// import/metadata pipeline can be exercised in a plain `node` test process.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import type { BookFormat, BookRecord } from '../../shared/types'

/** Extensions accepted by `library:import` (order is used by the dialog). */
export const BOOK_EXTENSIONS = ['epub', 'pdf', 'fb2', 'mobi', 'azw3', 'txt', 'rtf'] as const

export interface DialogFilter {
  name: string
  extensions: string[]
}

export const DIALOG_FILTERS: DialogFilter[] = [
  { name: '电子书', extensions: [...BOOK_EXTENSIONS] },
  { name: '文本文件', extensions: ['txt', 'rtf'] },
  { name: '所有文件', extensions: ['*'] }
]

const FORMAT_BY_EXT: Record<string, BookFormat> = {
  epub: 'epub',
  pdf: 'pdf',
  fb2: 'fb2',
  mobi: 'mobi',
  azw3: 'azw3',
  azw: 'azw3',
  txt: 'txt',
  text: 'txt',
  rtf: 'rtf',
  epub3: 'epub',
  prc: 'mobi'
}

/** Detect the book format from the extension, with a magic-number fallback. */
export function detectFormat(filePath: string, head?: Buffer): BookFormat {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  const byExt = FORMAT_BY_EXT[ext]
  if (byExt) {
    // `.azw3` files are MOBI containers; keep the extension answer.
    return byExt
  }
  if (!head || head.length < 8) return 'unknown'
  const ascii = head.toString('latin1')
  if (ascii.startsWith('PK\u0003\u0004')) return 'epub'
  if (ascii.startsWith('%PDF')) return 'pdf'
  if (ascii.startsWith('{\\rtf')) return 'rtf'
  if (ascii.slice(60, 68) === 'BOOKMOBI') return 'mobi'
  if (ascii.includes('<FictionBook')) return 'fb2'
  if (/^[\u0009\u000a\u000d\u0020-\u007e]*$/.test(ascii) && !head.includes(0)) return 'txt'
  return 'unknown'
}

export function isSupportedFormat(format: BookFormat): boolean {
  return format !== 'unknown'
}

export function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

export async function readHead(filePath: string, bytes = 128): Promise<Buffer> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
}

/* ------------------------------------------------------------------ */
/* Text decoding                                                       */
/* ------------------------------------------------------------------ */

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gbk' | 'big5' | 'latin1'

export interface DecodeResult {
  text: string
  encoding: TextEncoding
  hadBom: boolean
  /** ratio of U+FFFD in the decoded result (0 = clean) */
  replacementRatio: number
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function tryDecode(encoding: string, buf: Buffer): string | null {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buf)
  } catch {
    return null
  }
}

/** Higher is better. Used to pick between competing legacy code pages. */
function scoreText(text: string): number {
  let score = 0
  const len = Math.min(text.length, 200_000)
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i)
    if (code === 0xfffd) {
      score -= 30
      continue
    }
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      score -= 20
      continue
    }
    if (code >= 0x4e00 && code <= 0x9fff) score += 3
    else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) score += 2
    else if (code >= 0x0400 && code <= 0x04ff) score += 2
    else if (code >= 0x20 && code <= 0x7e) score += 1
    else if (code >= 0xe000 && code <= 0xf8ff) score -= 8
    else if (code >= 0xa0) score += 0.5
  }
  return score / Math.max(1, len)
}

/** True when the raw bytes look like UTF-16 (many NUL high bytes). */
function looksUtf16le(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  if (sample.length < 8) return false
  let zeros = 0
  let pairs = 0
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i + 1] === 0) zeros++
    if (sample[i] === 0 && sample[i + 1] === 0) return false
    pairs++
  }
  return pairs > 0 && zeros / pairs > 0.3
}

/** Decode a text buffer, guessing the charset (UTF-8 / UTF-16 / GBK / Big5). */
export function decodeText(buf: Buffer): DecodeResult {
  if (!buf.length) return { text: '', encoding: 'utf8', hadBom: false, replacementRatio: 0 }

  // BOM handling first.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const text = buf.subarray(3).toString('utf8')
    return { text, encoding: 'utf8', hadBom: true, replacementRatio: ratioOfReplacement(text) }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = tryDecode('utf-16le', buf.subarray(2)) ?? buf.subarray(2).toString('utf8')
    return { text, encoding: 'utf16le', hadBom: true, replacementRatio: ratioOfReplacement(text) }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = tryDecode('utf-16be', buf.subarray(2)) ?? ''
    return { text, encoding: 'utf16be', hadBom: true, replacementRatio: ratioOfReplacement(text) }
  }

  if (looksUtf16le(buf)) {
    const text = tryDecode('utf-16le', buf) ?? buf.toString('utf8')
    return { text, encoding: 'utf16le', hadBom: false, replacementRatio: ratioOfReplacement(text) }
  }

  // Clean UTF-8 wins immediately.
  try {
    const text = utf8Strict.decode(buf)
    return { text, encoding: 'utf8', hadBom: false, replacementRatio: 0 }
  } catch {
    /* not valid UTF-8 → try legacy code pages */
  }

  const candidates: TextEncoding[] = ['gbk', 'big5', 'latin1']
  let best: { text: string; encoding: TextEncoding; score: number } | null = null
  for (const encoding of candidates) {
    const text = tryDecode(encoding, buf)
    if (text === null) continue
    // Strip replacement chars from the score, but they still lower it.
    const score = scoreText(text) - ratioOfReplacement(text) * 20
    if (!best || score > best.score) best = { text, encoding, score }
  }
  if (!best) {
    const text = buf.toString('utf8')
    return { text, encoding: 'utf8', hadBom: false, replacementRatio: ratioOfReplacement(text) }
  }
  return {
    text: best.text,
    encoding: best.encoding,
    hadBom: false,
    replacementRatio: ratioOfReplacement(best.text)
  }
}

export function ratioOfReplacement(text: string): number {
  if (!text.length) return 0
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text
  let count = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) count++
  }
  return count / sample.length
}

/* ------------------------------------------------------------------ */
/* XML / HTML helpers (no parser dependency)                           */
/* ------------------------------------------------------------------ */

export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** First `<tag ...>inner</tag>` block, or null. Tag may contain a namespace. */
export function xmlBlock(xml: string, tag: string): string | null {
  const t = escapeRegExp(tag)
  const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i')
  const m = re.exec(xml)
  return m ? m[1] : null
}

/** All `<tag ...>inner</tag>` blocks. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const t = escapeRegExp(tag)
  const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

/** Text content of the first matching tag (tags stripped, entities decoded). */
export function xmlTagText(xml: string, tag: string): string {
  const block = xmlBlock(xml, tag)
  return block ? stripHtml(block) : ''
}

export function xmlAttr(tagXml: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')
  const m = re.exec(tagXml)
  return m ? decodeEntities(m[2]) : null
}

/** Find the first `<tag ... />` / `<tag ...>` opening tag markup. */
export function xmlOpenTag(xml: string, tag: string): string | null {
  const t = escapeRegExp(tag)
  const re = new RegExp(`<${t}(?:\\s[^>]*)?/?>`, 'i')
  const m = re.exec(xml)
  return m ? m[0] : null
}

/* ------------------------------------------------------------------ */
/* Title / author / language guessing                                  */
/* ------------------------------------------------------------------ */

const NOISE_PATTERNS: RegExp[] = [
  /\((?:z-lib(?:rary)?(?:\.org)?|libgen|annas?-archive)[^)]*\)/gi,
  /\[(?:www\.|https?:\/\/)[^\]]*\]/gi,
  /【[^】]*(?:下载|网站|www|http)[^】]*】/gi,
  /\[[^\]]*(?:下载|网站|www|http)[^\]]*\]/gi,
  /\s*-\s*副本$/i,
  /\s*\(\d+\)$/,
  /\s*（\d+）$/,
  /\.(?:epub|pdf|fb2|mobi|azw3|txt|rtf)$/i
]

export function cleanTitle(raw: string): string {
  let out = raw.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const re of NOISE_PATTERNS) out = out.replace(re, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** Book title guessed from a bare file name. */
export function titleFromFileName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  const cleaned = cleanTitle(base)
  return cleaned || base || '未命名书籍'
}

export interface AuthorGuess {
  author: string
  /** the line that produced the guess, for debugging */
  line?: string
}

const AUTHOR_LINE_RE =
  /^\s*(?:作\s*者|著\s*者|Author|AUTHOR|author|by|By)\s*[:：]?\s*(.{1,80}?)\s*$/m

/** Look for `作者：xxx` / `Author: xxx` style lines in a text sample. */
export function guessAuthorFromText(sample: string): AuthorGuess {
  const m = AUTHOR_LINE_RE.exec(sample)
  if (!m) return { author: '' }
  let author = m[1]
    .replace(/[\]】)]+\s*$/, '')
    .replace(/\s*(?:著|编著|主编|编|译|著者)$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!author || author.length > 60) return { author: '' }
  // avoid grabbing a sentence that merely starts with "by"
  if (/\s/.test(author) && author.split(/\s+/).length > 6) return { author: '' }
  return { author, line: m[0].trim() }
}

export function guessLanguage(text: string, fallback = 'zh'): string {
  const sample = text.slice(0, 12_000)
  if (!sample.trim()) return fallback
  let han = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0
  let latin = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c >= 0x4e00 && c <= 0x9fff) han++
    else if (c >= 0x3040 && c <= 0x30ff) kana++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
  }
  if (kana > 40) return 'ja'
  if (hangul > 40) return 'ko'
  if (han > 40) return 'zh'
  if (cyrillic > 40) return 'ru'
  if (latin > 40) return 'en'
  return fallback
}

/* ------------------------------------------------------------------ */
/* Names, colors, misc                                                 */
/* ------------------------------------------------------------------ */

export function safeFileName(name: string, maxLen = 70): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, maxLen)
    .trim()
  return cleaned || 'book'
}

/** Pick a non-colliding path inside `dir` for `base + ext`. */
export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  const safeBase = safeFileName(base)
  const candidate = path.join(dir, `${safeBase}${ext}`)
  if (!(await fileExists(candidate))) return candidate
  for (let i = 2; i < 500; i++) {
    const next = path.join(dir, `${safeBase}-${i}${ext}`)
    if (!(await fileExists(next))) return next
  }
  return path.join(dir, `${safeBase}-${Date.now()}${ext}`)
}

export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function hashHue(input: string): number {
  return fnv1a(input || 'dola') % 360
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.min(1, Math.max(0, s))
  const light = Math.min(1, Math.max(0, l))
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

/** Stable, pleasant cover colour derived from the title when no cover exists. */
export function coverColorFromTitle(title: string): string {
  const hue = hashHue(title)
  return hslToHex(hue, 0.38 + ((fnv1a(title) >>> 8) % 20) / 100, 0.46)
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let value = m[1]
  if (value.length === 3) value = value.split('').map((c) => c + c).join('')
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function mimeFromFormat(format: BookFormat): string {
  switch (format) {
    case 'epub':
      return 'application/epub+zip'
    case 'pdf':
      return 'application/pdf'
    case 'fb2':
      return 'application/x-fictionbook+xml'
    case 'mobi':
    case 'azw3':
      return 'application/x-mobipocket-ebook'
    case 'rtf':
      return 'application/rtf'
    default:
      return 'text/plain'
  }
}

/** Normalise a series/folder name for duplicate detection. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》「」『』【】\[\]()（）<>{}·•.,，。:：;；!！?？'"“”‘’、\-_—–~～|/\\]+/g, '')
    .replace(/(?:系列|合集|全集|套装|丛书|套书|书系|作品集)$/u, '')
    .trim()
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trim()}…`
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/* ------------------------------------------------------------------ */
/* PalmDOC decompression (shared by MOBI metadata + text extraction)   */
/* ------------------------------------------------------------------ */

export function palmDocDecompress(data: Buffer): Buffer {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const b = data[i]
    i++
    if (b === 0) {
      out.push(0)
      continue
    }
    if (b <= 0x08) {
      const count = b
      for (let k = 0; k < count && i < data.length; k++) out.push(data[i++])
      continue
    }
    if (b <= 0x7f) {
      out.push(b)
      continue
    }
    if (b >= 0xc0) {
      out.push(0x20)
      out.push(b ^ 0x80)
      continue
    }
    // 0x80..0xbf — two byte LZ77 pair
    if (i >= data.length) break
    const next = data[i]
    i++
    const pair = ((b << 8) | next) & 0x3fff
    const distance = pair >> 3
    const length = (pair & 0x07) + 3
    const start = out.length - distance
    if (distance <= 0 || start < 0) continue
    for (let k = 0; k < length; k++) {
      out.push(out[start + k] ?? 0)
      if (out.length > 32 * 1024 * 1024) return Buffer.from(out)
    }
  }
  return Buffer.from(out)
}

/** Titles like `book (Series #2)` — used by the EPUB/Calibre fallback. */
export function seriesFromTitle(title: string): string {
  const m = /^(.*?)\s*[（(]\s*([^()（）]{1,60}?)\s*(?:#|第)?\s*\d*\s*[)）]\s*$/.exec(title)
  if (!m) return ''
  const candidate = m[2].trim()
  if (!candidate) return ''
  return candidate
}

export function isBookRecord(value: unknown): value is BookRecord {
  if (!value || typeof value !== 'object') return false
  const rec = value as Partial<BookRecord>
  return typeof rec.id === 'string' && typeof rec.title === 'string' && typeof rec.filePath === 'string'
}


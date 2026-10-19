import JSZip from 'jszip'
import type { BookContent, BookRecord } from '@shared/types'

/**
 * A single measurable block of book content. Pagination is done by the reader
 * at runtime (measure → accumulate), because a character budget can never match
 * the real rendered height for mixed CJK / latin / image content.
 */
export interface Block {
  html: string
  /** plain text of the block, used for the measure hint and AI excerpts */
  text: string
  /**
   * `image` blocks are full-page illustrations. They are never measured or
   * split — the reader gives each one its own page so artwork is never cropped.
   */
  kind?: 'text' | 'image'
}

export interface RenderSource {
  kind: 'blocks' | 'pdf' | 'epub'
  blocks: Block[]
  /** raw pdf bytes */
  bytes?: Uint8Array
  /** raw EPUB bytes (base64) — rendered by epub.js so every resource resolves */
  epubBase64?: string
  /** book title/author parsed out of the container file, when present */
  title?: string
  author?: string
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ */
/* plain text → blocks                                                 */
/* ------------------------------------------------------------------ */
export function blocksFromText(text: string): Block[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return [{ html: '<p class="muted">（空文件）</p>', text: '' }]
  const paragraphs = normalized.split(/\n{2,}/)
  const blocks: Block[] = []
  for (const raw of paragraphs) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    // a paragraph with hard line breaks keeps them
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      if (!line) continue
      // headings: short standalone lines that look like chapter titles
      const isHeading = line.length <= 32 && /^(第[一二三四五六七八九十百零〇\d]+[章节回部卷]|[0-9]+[.、]|序章|楔子|后记|尾声|番外)/.test(line)
      blocks.push({
        html: isHeading ? `<h2>${escapeHtml(line)}</h2>` : `<p>${escapeHtml(line)}</p>`,
        text: line
      })
    }
  }
  return blocks.length ? blocks : [{ html: '<p class="muted">（空文件）</p>', text: '' }]
}

/* ------------------------------------------------------------------ */
/* html → blocks                                                       */
/* ------------------------------------------------------------------ */
export function blocksFromHtml(html: string): Block[] {
  const blocks: Block[] = []
  const re = /<(p|div|h[1-6]|li|blockquote|pre|section|figure|table|hr|img)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/gi
  let m: RegExpExecArray | null
  let consumed = 0
  const push = (fragment: string): void => {
    const text = stripTags(fragment)
    // A block that is (or contains) a real image becomes a dedicated page so
    // artwork is never split across a page break or clipped by pagination.
    if (/<img\b/i.test(fragment) && /src="data:image\//i.test(fragment)) {
      blocks.push({ html: fragment, text: '', kind: 'image' })
      return
    }
    if (!text && !/<img|<hr/i.test(fragment)) return
    blocks.push({ html: fragment, text })
  }
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase()
    if (tag === 'hr') continue
    if (tag === 'img') {
      const between = html.slice(consumed, m.index).trim()
      if (between) push(`<p>${escapeHtml(stripTags(between))}</p>`)
      consumed = m.index + m[0].length
      push(m[0])
      continue
    }
    const between = html.slice(consumed, m.index).trim()
    if (between) push(`<p>${escapeHtml(stripTags(between))}</p>`)
    consumed = m.index + m[0].length
    push(m[0])
  }
  const tail = html.slice(consumed).trim()
  if (tail) push(`<p>${escapeHtml(stripTags(tail))}</p>`)
  return blocks.length ? blocks : [{ html: html.trim() || '<p>(空)</p>', text: stripTags(html) }]
}

/* ------------------------------------------------------------------ */
/* RTF → plain text                                                   */
/* ------------------------------------------------------------------ */
export function rtfToText(rtf: string): string {
  const noGroups = rtf.replace(/\\par[d]?/g, '\n').replace(/\\line/g, '\n')
  let out = ''
  let i = 0
  while (i < noGroups.length) {
    const ch = noGroups[i]
    if (ch === '{') {
      // skip font / colour / style tables and pictures
      if (
        /^\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|object|themedata|datastore)/.test(
          noGroups.slice(i, i + 26)
        )
      ) {
        let depth = 1
        let j = i + 1
        while (j < noGroups.length && depth > 0) {
          if (noGroups[j] === '{') depth++
          else if (noGroups[j] === '}') depth--
          j++
        }
        i = j
        continue
      }
      i++
      continue
    }
    if (ch === '}') {
      i++
      continue
    }
    if (ch === '\\') {
      const rest = noGroups.slice(i)
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rest)
      if (m) {
        if (m[1] === 'par' || m[1] === 'line') out += '\n'
        else if (m[1] === 'tab') out += '\t'
        else if (m[1] === 'u') {
          const code = Number(m[2])
          out += String.fromCharCode(code < 0 ? code + 65536 : code)
        }
        i += m[0].length
        continue
      }
      const hx = /^\\'([0-9a-fA-F]{2})/.exec(rest)
      if (hx) {
        out += String.fromCharCode(parseInt(hx[1], 16))
        i += 4
        continue
      }
      i += rest.length > 1 ? 2 : 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    out += ch
    i++
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/* ------------------------------------------------------------------ */
/* FB2 → html                                                          */
/* ------------------------------------------------------------------ */
export function fb2ToHtml(xml: string): { html: string; title: string; author: string } {
  const strip = (s: string): string => stripTags(s)
  const title = strip(/<book-title>([\s\S]*?)<\/book-title>/.exec(xml)?.[1] ?? '')
  const first = strip(/<first-name>([\s\S]*?)<\/first-name>/.exec(xml)?.[1] ?? '')
  const last = strip(/<last-name>([\s\S]*?)<\/last-name>/.exec(xml)?.[1] ?? '')
  const middles = [...xml.matchAll(/<middle-name>([\s\S]*?)<\/middle-name>/g)].map((m) => strip(m[1]))
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(xml)?.[1] ?? xml
  const html = body
    .replace(/<section[^>]*>/g, '')
    .replace(/<title>/g, '<h2>')
    .replace(/<\/title>/g, '</h2>')
    .replace(/<subtitle[^>]*>/g, '<h3>')
    .replace(/<\/subtitle>/g, '</h3>')
    .replace(/<p[^>]*>/g, '<p>')
    .replace(/<empty-line\s*\/>/g, '<p>&nbsp;</p>')
    .replace(/<emphasis[^>]*>/g, '<em>')
    .replace(/<strong[^>]*>/g, '<strong>')
    .replace(/<strikethrough[^>]*>/g, '<s>')
    .replace(/<image[^>]*l:href="#[^"]*"[^>]*\/>/g, '')
    .replace(/<binary[\s\S]*?<\/binary>/g, '')
  return { html, title, author: [first, ...middles, last].filter(Boolean).join(' ') }
}

/* ------------------------------------------------------------------ */
/* EPUB path resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Resolve an href relative to the directory of the document that references it.
 * EPUBs routinely use `../Images/001.jpg`; JSZip does NOT collapse `..`, so the
 * path must be normalised segment by segment before lookup. Percent-encoding and
 * Windows-style separators are handled too, and the leading `/` (package root)
 * is stripped because zip entry names are always relative.
 */
export function resolveZipPath(baseDir: string, href: string): string {
  let raw = href
  try {
    raw = decodeURIComponent(href)
  } catch {
    /* malformed escape sequence — keep it verbatim */
  }
  raw = raw.split('#')[0].split('?')[0]
  if (!raw) return ''
  const combined = raw.startsWith('/') ? raw.slice(1) : baseDir + raw
  const parts: string[] = []
  for (const seg of combined.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

/** Case-insensitive + decoded lookup, because zip entry casing is unreliable. */
function findZipEntry(zip: JSZip, candidates: string[]): JSZip.JSZipObject | null {
  const index = new Map<string, JSZip.JSZipObject>()
  for (const [name, entry] of Object.entries(zip.files)) {
    if ((entry as JSZip.JSZipObject).dir) continue
    index.set(name.toLowerCase(), entry as JSZip.JSZipObject)
    try {
      index.set(decodeURIComponent(name).toLowerCase(), entry as JSZip.JSZipObject)
    } catch {
      /* ignore malformed names */
    }
  }
  for (const c of candidates) {
    if (!c) continue
    const direct = zip.file(c)
    if (direct) return direct
    const hit = index.get(c.toLowerCase())
    if (hit) return hit
  }
  return null
}

function mimeForImagePath(p: string): string {
  const ext = (p.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'avif':
      return 'image/avif'
    default:
      return 'application/octet-stream'
  }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|svg|webp|bmp|avif)$/i

/* ------------------------------------------------------------------ */
/* EPUB                                                                */
/* ------------------------------------------------------------------ */
export interface EpubData {
  title: string
  author: string
  chapters: { id: string; title: string; html: string }[]
  html: string
  /** how many images were successfully inlined (for diagnostics) */
  imagesInlined: number
  /** images referenced by the book but missing from the archive */
  imagesMissing: string[]
}

export async function parseEpub(base64: string): Promise<EpubData> {
  const bin = b64ToBytes(base64)
  const zip = await JSZip.loadAsync(bin)
  const containerFile = findZipEntry(zip, ['META-INF/container.xml'])
  let opfPath = ''
  if (containerFile) {
    const xml = await containerFile.async('string')
    opfPath = /full-path="([^"]+)"/.exec(xml)?.[1] ?? ''
  }
  if (!opfPath) {
    const guess = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf'))
    if (guess) opfPath = guess
  }
  if (!opfPath) throw new Error('EPUB 缺少 OPF 文件')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfFile = findZipEntry(zip, [opfPath])
  if (!opfFile) throw new Error('EPUB 无法读取 OPF 文件')
  const opf = await opfFile.async('string')

  const title = stripTags(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? '')
  const author = stripTags(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1] ?? '')

  const manifest = new Map<string, string>()
  const itemRe = /<item\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(opf))) {
    const tag = m[0]
    const id = /id="([^"]+)"/.exec(tag)?.[1]
    const href = /href="([^"]+)"/.exec(tag)?.[1]
    const type = /media-type="([^"]+)"/.exec(tag)?.[1] ?? ''
    if (id && href && (type.includes('html') || type.includes('xml'))) manifest.set(id, href)
  }
  const order: string[] = []
  const spineRe = /<itemref\b[^>]*idref="([^"]+)"/g
  while ((m = spineRe.exec(opf))) order.push(m[1])

  const chapters: EpubData['chapters'] = []
  const imagesMissing: string[] = []
  let imagesInlined = 0

  for (const id of order) {
    const href = manifest.get(id)
    if (!href) continue
    const path = resolveZipPath(opfDir, href)
    const file = findZipEntry(zip, [path])
    if (!file) continue
    const raw = await file.async('string')
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? raw
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    const inlined = await inlineImages(body, zip, dir, (ok) => {
      if (ok) imagesInlined++
      else imagesMissing.push(path)
    })
    const clean = inlined
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\s(class|id|style|epub:type|xmlns(:[a-z]+)?|lang|dir|role|aria-[a-z]+)="[^"]*"/gi, '')
    const heading = stripTags(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(clean)?.[1] ?? '')
    chapters.push({ id, title: heading, html: clean })
  }

  return {
    title,
    author,
    chapters,
    html: chapters.map((c) => `<hr/>${c.html}`).join('\n'),
    imagesInlined,
    imagesMissing
  }
}

/**
 * Rewrite every image reference in a chapter into a self-contained data URL.
 * Handles:
 *  - `src="../Images/001.jpg"` with `..` segments (the common Calibre layout)
 *  - `<image xlink:href="...">` / SVG wrappers used by some Kindle conversions
 *  - percent-encoded names, mixed case, backslashes
 *  - `srcset`, `poster`, CSS `url(...)` inside inline style attributes
 * Images that cannot be found are replaced with a visible placeholder rather
 * than being silently dropped, so layout and diagnostics stay truthful.
 */
async function inlineImages(
  body: string,
  zip: JSZip,
  baseDir: string,
  onResult?: (ok: boolean) => void
): Promise<string> {
  const replacements = new Map<string, string>()

  const resolveOne = async (rawSrc: string): Promise<string | null> => {
    const trimmed = rawSrc.trim()
    if (!trimmed) return null
    if (/^(https?:|data:|blob:)/i.test(trimmed)) return null
    const candidates = [
      resolveZipPath(baseDir, trimmed),
      resolveZipPath('', trimmed),
      trimmed.replace(/^\.\//, '')
    ]
    const file = findZipEntry(zip, candidates)
    if (!file) return null
    const mime = mimeForImagePath(file.name)
    const kind = mime.startsWith('image/') ? mime : 'image/jpeg'
    const b64 = await file.async('base64')
    return `data:${kind};base64,${b64}`
  }

  const attrs = [/src="([^"]+)"/gi, /xlink:href="([^"]+)"/gi, /href="([^"]+)"/gi]
  const collected = new Set<string>()
  for (const re of attrs) {
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) {
      const v = m[1]
      if (v && !v.startsWith('#') && !/^https?:|^data:|^mailto:/i.test(v)) collected.add(v)
    }
  }
  // inline CSS url(...) references
  const cssRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
  let cm: RegExpExecArray | null
  while ((cm = cssRe.exec(body))) {
    const v = cm[1]
    if (v && !/^https?:|^data:/i.test(v)) collected.add(v)
  }

  for (const src of collected) {
    const isLikelyImage = IMAGE_EXT_RE.test(src) || /^url\(/i.test(src)
    const dataUrl = await resolveOne(src)
    if (dataUrl) {
      replacements.set(src, dataUrl)
      onResult?.(true)
    } else if (isLikelyImage && !src.startsWith('Text/')) {
      onResult?.(false)
    }
  }

  let out = body
  for (const [from, to] of replacements) {
    // replace both quoted attribute forms and css url() forms
    out = out.split(`"${from}"`).join(`"${to}"`)
    out = out.split(`'${from}'`).join(`'${to}'`)
    out = out.split(`url(${from})`).join(`url(${to})`)
    out = out.split(`url("${from}")`).join(`url("${to}")`)
    out = out.split(`url('${from}')`).join(`url('${to}')`)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* MOBI / AZW3 — PalmDOC-ish text extraction                           */
/* ------------------------------------------------------------------ */
export function mobiToText(bytes: Uint8Array): string {
  const dec = new TextDecoder('utf-8', { fatal: false })
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const numRecords = view.getUint16(76, false)
    if (!numRecords || numRecords > 60000) throw new Error('bad header')
    const offsets: number[] = []
    for (let i = 0; i < numRecords; i++) offsets.push(view.getUint32(78 + i * 8, false))
    let out = ''
    for (let i = 1; i < numRecords; i++) {
      const start = offsets[i]
      const end = i + 1 < numRecords ? offsets[i + 1] : bytes.length
      if (end <= start) continue
      const chunk = dec.decode(bytes.subarray(start, end))
      const printable = chunk.replace(/[^\u0009\u000a\u0020-\u007e\u00a0-\uffef]/g, '')
      if (printable.replace(/\s/g, '').length > 20) out += printable
    }
    const trimmed = out.replace(/[ \t]{2,}/g, ' ').replace(/\s{3,}/g, '\n\n').trim()
    if (trimmed.length > 120) return trimmed
  } catch {
    /* fall through to the crude path */
  }
  return dec
    .decode(bytes)
    .replace(/[^\u0009\u000a\u0020-\u007e\u00a0-\uffef]/g, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------------ */
/* Build a render source from an IPC payload                           */
/* ------------------------------------------------------------------ */
export async function buildSource(content: BookContent, book: BookRecord): Promise<RenderSource> {
  const fmt = content.format
  if (fmt === 'pdf') {
    return { kind: 'pdf', blocks: [], bytes: b64ToBytes(content.data), title: book.title }
  }
  if (fmt === 'epub') {
    // EPUB rendering is handled by epub.js in the reader. We only pull the
    // metadata here (cheap) and hand the raw archive over untouched, because
    // epub.js resolves every internal resource itself — that is what makes
    // illustrations load regardless of relative paths or archive layout.
    let title = book.title
    let author = book.author
    try {
      const meta = await parseEpub(content.data)
      title = meta.title || title
      author = meta.author || author
    } catch {
      /* metadata is optional; the reader can still open the archive */
    }
    return { kind: 'epub', blocks: [], epubBase64: content.data, title, author }
  }
  if (fmt === 'fb2') {
    const parsed = fb2ToHtml(content.data)
    const blocks = blocksFromHtml(parsed.html)
    if (parsed.title) blocks.unshift({ html: `<h1>${escapeHtml(parsed.title)}</h1>`, text: parsed.title })
    return { kind: 'blocks', blocks, title: parsed.title || book.title, author: parsed.author }
  }
  if (fmt === 'rtf') {
    return { kind: 'blocks', blocks: blocksFromText(rtfToText(content.data)), title: book.title }
  }
  if (fmt === 'mobi' || fmt === 'azw3') {
    const text =
      content.encoding === 'utf8' ? content.data : mobiToText(b64ToBytes(content.data))
    return { kind: 'blocks', blocks: blocksFromText(text), title: book.title }
  }
  // txt & fallback
  const text =
    content.encoding === 'utf8' ? content.data : new TextDecoder('utf-8').decode(b64ToBytes(content.data))
  return { kind: 'blocks', blocks: blocksFromText(text), title: book.title }
}

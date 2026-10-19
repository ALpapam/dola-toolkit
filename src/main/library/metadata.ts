// ---------------------------------------------------------------------------
// Dola Toolkit — book metadata extraction (EPUB / FB2 / PDF / MOBI / TXT / RTF).
//
// Pure Node: `jszip` for EPUB, hand-rolled scanners elsewhere. Every extractor
// is defensive — a broken file yields empty metadata, never an exception that
// escapes to the IPC layer.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'
import type { BookFormat } from '../../shared/types'
import {
  cleanTitle,
  decodeEntities,
  decodeText,
  guessAuthorFromText,
  guessLanguage,
  palmDocDecompress,
  seriesFromTitle,
  stripHtml,
  titleFromFileName,
  truncate,
  xmlAttr,
  xmlBlock,
  xmlBlocks,
  xmlOpenTag,
  xmlTagText
} from './scan'

export interface ExtractedMeta {
  title: string
  author: string
  language: string
  publisher: string
  description: string
  series: string
  /** raw cover bytes when the format embeds one */
  cover: { data: Buffer; ext: 'jpg' | 'png' | 'svg' } | null
  /** plain-text sample used for author/description guessing */
  excerpt: string
  /** non-fatal notes, surfaced in dev logs */
  notes: string[]
}

export interface MetaContext {
  filePath: string
  format: BookFormat
  /** file size in bytes, used to skip absurd reads */
  size: number
}

const MAX_TEXT_READ = 24 * 1024 * 1024

function emptyMeta(filePath: string): ExtractedMeta {
  return {
    title: titleFromFileName(filePath),
    author: '',
    language: '',
    publisher: '',
    description: '',
    series: '',
    cover: null,
    excerpt: '',
    notes: []
  }
}

/** Extract metadata for one file. Never throws. */
export async function extractMetadata(ctx: MetaContext): Promise<ExtractedMeta> {
  const base = emptyMeta(ctx.filePath)
  try {
    switch (ctx.format) {
      case 'epub':
        return await extractEpub(ctx, base)
      case 'fb2':
        return await extractFb2(ctx, base)
      case 'pdf':
        return await extractPdf(ctx, base)
      case 'mobi':
      case 'azw3':
        return await extractMobi(ctx, base)
      case 'rtf':
        return await extractRtf(ctx, base)
      case 'txt':
        return await extractTxt(ctx, base)
      default:
        base.notes.push('未知格式，仅按文件名推断')
        return base
    }
  } catch (err) {
    base.notes.push(`解析失败：${err instanceof Error ? err.message : String(err)}`)
    return base
  }
}

async function readFileCapped(filePath: string, cap = MAX_TEXT_READ): Promise<Buffer> {
  const st = await fs.stat(filePath)
  if (st.size <= cap) return fs.readFile(filePath)
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(cap)
    const { bytesRead } = await handle.read(buf, 0, cap, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    const trimmed = (value ?? '').trim()
    if (trimmed) return trimmed
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* TXT                                                                 */
/* ------------------------------------------------------------------ */

async function extractTxt(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await readFileCapped(ctx.filePath, 2 * 1024 * 1024)
  const decoded = decodeText(buf)
  const sample = decoded.text.slice(0, 8000)
  const guess = guessAuthorFromText(sample)
  meta.author = firstNonEmpty(guess.author, meta.author)
  meta.language = guessLanguage(decoded.text, 'zh')

  // Heuristic: the first non-empty line is often the real title when the file
  // name looks machine-generated (digits, hashes) or is very short.
  const lines = decoded.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const firstLine = lines[0] ?? ''
  const fileTitle = titleFromFileName(ctx.filePath)
  if (
    firstLine.length >= 2 &&
    firstLine.length <= 60 &&
    !/[：:]\s*$/.test(firstLine) &&
    !/^(作\s*者|著|author|by|书名|title)[：:\s]/i.test(firstLine) &&
    (fileTitle.length <= 3 || /\d{4,}/.test(fileTitle) || /^[A-Za-z0-9_-]{6,}$/.test(fileTitle))
  ) {
    meta.title = cleanTitle(firstLine)
  }
  const series = seriesFromTitle(fileTitle)
  if (series) meta.series = series

  meta.excerpt = truncate(
    lines.filter((l) => !/^(作\s*者|著|author|by)[：:]/i.test(l)).slice(0, 12).join(' '),
    400
  )
  meta.notes.push(`encoding=${decoded.encoding}`)
  return meta
}

/* ------------------------------------------------------------------ */
/* EPUB                                                                */
/* ------------------------------------------------------------------ */

function resolveHref(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]).replace(/\\/g, '/')
  if (clean.startsWith('/')) return clean.slice(1)
  const joined = baseDir ? `${baseDir.replace(/\/+$/, '')}/${clean}` : clean
  const parts: string[] = []
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

async function extractEpub(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await fs.readFile(ctx.filePath)
  const zip = await JSZip.loadAsync(buf)

  let opfPath = ''
  const container = zip.file('META-INF/container.xml')
  if (container) {
    const xml = await container.async('string')
    opfPath = xmlAttr(xmlOpenTag(xml, 'rootfile') ?? '', 'full-path') ?? ''
  }
  if (!opfPath) {
    const candidate = Object.keys(zip.files).find((name) => /\.opf$/i.test(name))
    if (candidate) opfPath = candidate
  }
  if (!opfPath) {
    meta.notes.push('EPUB 缺少 OPF')
    return meta
  }
  const opfFile = zip.file(opfPath) ?? zip.file(decodeURIComponent(opfPath))
  if (!opfFile) {
    meta.notes.push('EPUB OPF 路径无效')
    return meta
  }
  const opf = await opfFile.async('string')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''

  const metadata = xmlBlock(opf, 'metadata') ?? opf
  meta.title = cleanTitle(
    firstNonEmpty(
      xmlTagText(metadata, 'dc:title'),
      xmlTagText(metadata, 'title'),
      meta.title
    )
  )
  // Multiple dc:creator entries: take the first, prefer one marked as author.
  const creators = xmlBlocks(metadata, 'dc:creator').map((c) => stripHtml(c))
  meta.author = firstNonEmpty(
    creators[0] ?? '',
    xmlTagText(metadata, 'creator'),
    xmlTagText(metadata, 'dc:contributor')
  )
  meta.language = firstNonEmpty(
    xmlTagText(metadata, 'dc:language'),
    xmlTagText(metadata, 'language')
  )
  meta.publisher = firstNonEmpty(
    xmlTagText(metadata, 'dc:publisher'),
    xmlTagText(metadata, 'publisher')
  )
  const descriptionRaw = firstNonEmpty(
    xmlTagText(metadata, 'dc:description'),
    xmlTagText(metadata, 'description')
  )
  meta.description = truncate(descriptionRaw, 1600)

  // Series: calibre meta, EPUB3 belongs-to-collection, or "Title (Series #n)".
  const metaTags = [...metadata.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0])
  let series = ''
  for (const tag of metaTags) {
    const name = (xmlAttr(tag, 'name') ?? '').toLowerCase()
    if (name === 'calibre:series') {
      series = xmlAttr(tag, 'content') ?? ''
      break
    }
  }
  if (!series) {
    const belongs = metaTags.find((tag) => (xmlAttr(tag, 'property') ?? '').includes('belongs-to-collection'))
    if (belongs) series = xmlAttr(belongs, 'id') ?? ''
    const collection = xmlBlock(metadata, 'meta')
    if (!series && collection) {
      const m = /<meta\b[^>]*property="belongs-to-collection"[^>]*>([\s\S]*?)<\/meta>/i.exec(metadata)
      if (m) series = stripHtml(m[1])
    }
  }
  // EPUB3 collections also appear as <meta refines> text; fall back to the title.
  if (!series) series = seriesFromTitle(meta.title)
  meta.series = cleanTitle(series)

  // Manifest: id → { href, mediaType, properties }
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>()
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0]
    const id = xmlAttr(tag, 'id')
    const href = xmlAttr(tag, 'href')
    if (!id || !href) continue
    manifest.set(id, {
      href,
      mediaType: (xmlAttr(tag, 'media-type') ?? '').toLowerCase(),
      properties: (xmlAttr(tag, 'properties') ?? '').toLowerCase()
    })
  }

  // Cover selection. The OPF `meta name="cover"` is often wrong or ambiguous:
  // Calibre writes the manifest *id*, but some publishers (and this NGNL set)
  // point it at a back-cover / promo image while the real front cover lives in
  // a spine item named cover.*. Instead of trusting the first hit, collect every
  // candidate with a confidence score and prefer the strongest one.
  interface CoverCandidate {
    href: string
    score: number
    why: string
  }
  const coverCandidates: CoverCandidate[] = []
  const pushCandidate = (href: string | undefined, score: number, why: string): void => {
    if (!href || !/\.(?:jpe?g|png|webp|gif|svg)$/i.test(href)) return
    if (coverCandidates.some((c) => c.href === href)) {
      const existing = coverCandidates.find((c) => c.href === href)
      if (existing && score > existing.score) {
        existing.score = score
        existing.why = why
      }
      return
    }
    coverCandidates.push({ href, score, why })
  }

  for (const tag of metaTags) {
    const name = (xmlAttr(tag, 'name') ?? '').toLowerCase()
    if (name === 'cover') {
      const val = xmlAttr(tag, 'content') ?? ''
      const item = manifest.get(val)
      if (item) {
        pushCandidate(item.href, 60, 'meta-cover-id')
      } else {
        // content is sometimes a bare href or basename rather than a manifest id
        pushCandidate(val, 45, 'meta-cover-href')
        pushCandidate(resolveHref(opfDir, val), 45, 'meta-cover-resolved')
      }
    }
  }
  for (const [id, item] of manifest) {
    if (item.properties.includes('cover-image')) pushCandidate(item.href, 90, 'prop-cover-image')
    // manifest ids literally named cover* are a strong signal
    if (/^cover(?:[-_.]?image)?$/i.test(id)) pushCandidate(item.href, 80, 'id-cover')
  }
  for (const [name] of Object.entries(zip.files)) {
    if (!/\.(?:jpe?g|png|webp|gif|svg)$/i.test(name)) continue
    const base = name.split('/').pop() ?? ''
    if (/^cover\.(?:jpe?g|png|webp|gif|svg)$/i.test(base)) pushCandidate(name, 70, 'file-cover')
    else if (/^cover[^/]*\.(?:jpe?g|png|webp|gif|svg)$/i.test(base)) {
      // backcover.jpg must never win over cover.jpg
      if (/back[_-]?cover/i.test(base)) pushCandidate(name, 5, 'file-backcover')
      else pushCandidate(name, 40, 'file-cover-ish')
    }
  }

  // Prefer cover-looking files that are actually portrait-ish and reasonably large.
  coverCandidates.sort((a, b) => b.score - a.score)
  for (const cand of coverCandidates) {
    const href = cand.href
    const resolved = /\.(?:jpe?g|png|webp|gif|svg)$/i.test(href) && href.includes('/') ? href : resolveHref(opfDir, href)
    const file = zip.file(resolved) ?? zip.file(decodeURIComponent(resolved))
    if (!file) continue
    const ext: 'jpg' | 'png' | 'svg' = /\.png$/i.test(resolved) ? 'png' : /\.svg$/i.test(resolved) ? 'svg' : 'jpg'
    const data = await file.async('nodebuffer')
    if (data.length > 512 && data.length < 12 * 1024 * 1024) {
      meta.cover = { data, ext }
      break
    }
  }

  // Excerpt: text of the first couple of spine items.
  const spine: string[] = []
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = xmlAttr(m[0], 'idref')
    if (idref) {
      const item = manifest.get(idref)
      if (item && /x?html/.test(item.mediaType)) spine.push(item.href)
    }
  }
  if (!spine.length) {
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir && /\.x?html?$/i.test(name)) spine.push(name)
    }
    spine.sort()
  }
  let excerpt = ''
  for (const href of spine.slice(0, 3)) {
    const resolved = href.includes('/') ? resolveHref(opfDir, href) : resolveHref(opfDir, href)
    const file = zip.file(resolved) ?? zip.file(decodeURIComponent(resolved))
    if (!file) continue
    const html = await file.async('string')
    const body = xmlBlock(html, 'body') ?? html
    const text = stripHtml(body)
    excerpt += ` ${text}`
    if (excerpt.length > 600) break
  }
  meta.excerpt = truncate(excerpt, 600)
  if (!meta.author) {
    const guess = guessAuthorFromText(meta.excerpt.slice(0, 2000))
    if (guess.author) meta.author = guess.author
  }
  if (!meta.language) meta.language = guessLanguage(meta.excerpt, 'zh')
  meta.notes.push(`epub spine=${spine.length}`)
  return meta
}

/* ------------------------------------------------------------------ */
/* FB2                                                                 */
/* ------------------------------------------------------------------ */

const FB2_BINARY_RE = /<binary\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/binary>/gi

async function extractFb2(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await readFileCapped(ctx.filePath, 40 * 1024 * 1024)
  const decoded = decodeText(buf)
  const xml = decoded.text
  const titleInfo = xmlBlock(xml, 'title-info') ?? xml
  const description = xmlBlock(xml, 'description') ?? ''

  meta.title = cleanTitle(
    firstNonEmpty(xmlTagText(titleInfo, 'book-title'), meta.title)
  )
  const firstName = xmlTagText(titleInfo, 'first-name')
  const lastName = xmlTagText(titleInfo, 'last-name')
  const nickname = xmlTagText(titleInfo, 'nickname')
  const middleName = xmlTagText(titleInfo, 'middle-name')
  meta.author = firstNonEmpty(
    [firstName, middleName, lastName].filter(Boolean).join(' ').trim(),
    nickname
  )
  meta.language = firstNonEmpty(xmlTagText(titleInfo, 'lang'))
  if (!meta.language) meta.language = guessLanguage(xml.slice(0, 20000), 'ru')
  const annotation = xmlBlock(titleInfo, 'annotation')
  meta.description = truncate(annotation ? stripHtml(annotation) : '', 1600)
  const genres = xmlBlocks(titleInfo, 'genre').map((g) => stripHtml(g)).filter(Boolean)
  if (genres.length) meta.notes.push(`genres=${genres.slice(0, 4).join(',')}`)
  const seq = /<sequence\b[^>]*>/i.exec(xmlBlock(titleInfo, 'title-info') ?? xml) ??
    /<sequence\b[^>]*>/i.exec(/<publish-info>[\s\S]*?<\/publish-info>/i.exec(description)?.[0] ?? '')
  if (seq) {
    meta.series = cleanTitle(xmlAttr(seq[0], 'name') ?? '')
  }
  const publisher = xmlBlock(description, 'publish-info')
  if (publisher) meta.publisher = xmlTagText(publisher, 'publisher')
  if (!meta.publisher) meta.publisher = xmlTagText(titleInfo, 'publisher')

  // Coverpage → <binary id="..." content-type="image/jpeg">base64</binary>
  const coverpage = xmlBlock(xml, 'coverpage')
  if (coverpage) {
    const imageTag = xmlOpenTag(coverpage, 'image') ?? ''
    const href = (xmlAttr(imageTag, 'l:href') ?? xmlAttr(imageTag, 'href') ?? '').replace(/^#/, '')
    if (href) {
      for (const m of xml.matchAll(FB2_BINARY_RE)) {
        if (m[1] !== href) continue
        const b64 = m[2].replace(/\s+/g, '')
        try {
          const data = Buffer.from(b64, 'base64')
          if (data.length > 512) {
            const isPng = data[0] === 0x89 && data[1] === 0x50
            const isSvg = data.subarray(0, 200).toString('utf8').includes('<svg')
            meta.cover = { data, ext: isPng ? 'png' : isSvg ? 'svg' : 'jpg' }
          }
        } catch {
          /* ignore */
        }
        break
      }
    }
  }
  const body = xmlBlock(xml, 'body')
  if (body) meta.excerpt = truncate(stripHtml(body), 600)
  return meta
}

/* ------------------------------------------------------------------ */
/* PDF (light byte scan; pdfjs is an opportunistic enhancement)        */
/* ------------------------------------------------------------------ */

interface PdfInfo {
  title: string
  author: string
  pages: number
}

function decodePdfString(raw: string): string {
  // UTF-16BE hex string: <FEFF...>
  if (/^feff/i.test(raw)) {
    const bytes = Buffer.from(raw.slice(4), 'hex')
    const swapped = Buffer.alloc(bytes.length)
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1]
      swapped[i + 1] = bytes[i]
    }
    return swapped.toString('utf16le')
  }
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    const bytes = Buffer.from(raw, 'hex')
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return utf8.includes('\ufffd') ? bytes.toString('latin1') : utf8
  }
  return raw
    .replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
        case 'b':
          return '\b'
        case 'f':
          return '\f'
        default:
          return ch
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

function scanPdfInfo(buf: Buffer): PdfInfo {
  const info: PdfInfo = { title: '', author: '', pages: 0 }
  // latin1 keeps byte offsets stable and is enough to find ASCII dictionary keys
  const text = buf.toString('latin1')

  const pick = (key: string): string => {
    const re = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^()\\\\])*\\)|<[0-9A-Fa-f\\s]+>)`)
    const m = re.exec(text)
    if (!m) return ''
    let value = m[1]
    if (value.startsWith('(')) value = value.slice(1, -1)
    else value = value.slice(1, -1)
    try {
      return decodePdfString(value).replace(/\u0000/g, '').trim()
    } catch {
      return ''
    }
  }

  info.title = pick('Title')
  info.author = pick('Author')

  // Page count: prefer /Count on the page tree root, else count /Type /Page.
  const counts: number[] = []
  const countRe = /\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/g
  let m: RegExpExecArray | null
  while ((m = countRe.exec(text))) counts.push(Number(m[1]))
  if (counts.length) {
    info.pages = Math.max(...counts.filter((n) => Number.isFinite(n) && n > 0 && n < 200000), 0)
  }
  if (!info.pages) {
    const pageRe = /\/Type\s*\/Page(?![sA-Za-z])/g
    let count = 0
    while ((m = pageRe.exec(text))) count++
    info.pages = count
  }
  return info
}

let pdfjsWarned = false

async function extractPdf(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await fs.readFile(ctx.filePath)
  const info = scanPdfInfo(buf)
  meta.title = cleanTitle(firstNonEmpty(info.title, meta.title))
  meta.author = firstNonEmpty(info.author)
  if (info.pages > 0) meta.notes.push(`pdf pages=${info.pages}`)

  // Opportunistic upgrade via pdf.js (works headless in Node 22 — verified).
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> }
      GlobalWorkerOptions?: { workerSrc: string }
    }
    // pdf.js needs a resolvable worker; point it at the bundled worker file.
    if (pdfjs.GlobalWorkerOptions) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createRequire } = await import('node:module')
        const { pathToFileURL } = await import('node:url')
        const req = createRequire(typeof __filename === 'string' ? __filename : process.cwd() + '/node_modules/')
        const workerPath = req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
      } catch {
        /* leave the default; getDocument degrades to fake worker */
      }
    }
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0
    }).promise
    const metaInfo = await doc.getMetadata().catch(() => null)
    const raw = (metaInfo?.info ?? {}) as Record<string, unknown>
    const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    meta.title = cleanTitle(firstNonEmpty(asText(raw['Title']), meta.title))
    meta.author = firstNonEmpty(asText(raw['Author']), meta.author)
    meta.publisher = firstNonEmpty(asText(raw['Publisher']), meta.publisher)
    const subject = asText(raw['Subject'])
    if (subject) meta.description = truncate(subject, 1600)
    if (doc.numPages > 0) {
      meta.notes.push(`pdfjs pages=${doc.numPages}`)
    }
    // First page text for language/excerpt (best effort, never fatal).
    if (doc.numPages > 0) {
      const page = await doc.getPage(1).catch(() => null)
      if (page) {
        const content = await page.getTextContent().catch(() => null)
        const items = (content?.items ?? []) as { str?: string }[]
        const words = items.map((i) => i.str ?? '').join(' ')
        meta.excerpt = truncate(words, 600)
      }
    }
    // PDFDocumentProxy may not expose destroy() in every build.
    const maybe = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> }
    try {
      if (typeof maybe.destroy === 'function') await maybe.destroy()
      else if (typeof maybe.cleanup === 'function') await maybe.cleanup()
    } catch {
      /* ignore */
    }
  } catch (err) {
    if (!pdfjsWarned) {
      pdfjsWarned = true
      meta.notes.push(`pdfjs 不可用：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!meta.language) meta.language = guessLanguage(meta.excerpt || meta.title, 'zh')
  return meta
}

interface PdfDocumentLike {
  numPages: number
  getMetadata(): Promise<{ info?: Record<string, unknown> }>
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
  destroy?(): Promise<void>
  cleanup?(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* MOBI / AZW3                                                         */
/* ------------------------------------------------------------------ */

interface MobiInfo {
  title: string
  author: string
  language: string
  publisher: string
  series: string
  excerpt: string
  descriptionFallback: string
}

function readCString(buf: Buffer, offset: number, maxLen = 512): string {
  let end = offset
  const limit = Math.min(buf.length, offset + maxLen)
  while (end < limit && buf[end] !== 0) end++
  return buf.toString('utf8', offset, end).replace(/\u0000/g, '').trim()
}

function scanMobi(buf: Buffer): MobiInfo {
  const info: MobiInfo = {
    title: '',
    author: '',
    language: '',
    publisher: '',
    series: '',
    excerpt: '',
    descriptionFallback: ''
  }
  if (buf.length < 132) return info
  const name = buf.toString('latin1', 0, 32).replace(/\u0000+$/g, '').trim()
  info.title = name

  const numRecords = buf.readUInt16BE(76)
  if (!numRecords || numRecords > 60000) return info
  const offsets: number[] = []
  for (let i = 0; i < numRecords; i++) {
    const off = 78 + i * 8
    if (off + 4 > buf.length) break
    offsets.push(buf.readUInt32BE(off))
  }
  const recordEnd = (i: number): number =>
    i + 1 < offsets.length ? offsets[i + 1] : buf.length

  // Record 0: PalmDOC header (16 bytes) + MOBI header.
  const rec0 = offsets[0] ?? 0
  let mobiHeaderOffset = -1
  if (rec0 + 20 < buf.length && buf.toString('latin1', rec0 + 16, rec0 + 20) === 'MOBI') {
    mobiHeaderOffset = rec0 + 16
  }
  let textEncoding = 1252
  let firstImageIndex = 0xffffffff
  let exthOffset = -1
  if (mobiHeaderOffset >= 0) {
    try {
      const headerLen = buf.readUInt32BE(mobiHeaderOffset + 4)
      textEncoding = buf.readUInt32BE(mobiHeaderOffset + 12) || 1252
      // Full name: offset/length live at 0x44/0x48 of the MOBI header.
      const fullNameOffset = buf.readUInt32BE(mobiHeaderOffset + 0x44)
      const fullNameLength = buf.readUInt32BE(mobiHeaderOffset + 0x48)
      if (fullNameOffset > 0 && fullNameOffset < buf.length) {
        const candidate = readCString(
          buf,
          rec0 + fullNameOffset,
          Math.min(Math.max(fullNameLength, 1) + 1, 1024)
        )
        if (candidate) info.title = candidate
      }
      // First image index sits at 0x5C; validate before trusting it.
      if (mobiHeaderOffset + 0x60 <= buf.length) {
        const value = buf.readUInt32BE(mobiHeaderOffset + 0x5c)
        if (value > 1 && value < numRecords) firstImageIndex = value
      }
      // EXTH is located by magic rather than by the (ambiguous) flags field.
      const afterHeader = mobiHeaderOffset + headerLen
      if (afterHeader + 4 <= buf.length && buf.toString('latin1', afterHeader, afterHeader + 4) === 'EXTH') {
        exthOffset = afterHeader
      }
    } catch {
      /* partial file */
    }
  }

  // EXTH records (author, publisher, series, language).
  if (exthOffset > 0 && exthOffset + 12 <= buf.length) {
    try {
      if (buf.toString('latin1', exthOffset, exthOffset + 4) === 'EXTH') {
        const count = buf.readUInt32BE(exthOffset + 8)
        let cursor = exthOffset + 12
        for (let i = 0; i < Math.min(count, 200); i++) {
          if (cursor + 8 > buf.length) break
          const type = buf.readUInt32BE(cursor)
          const len = buf.readUInt32BE(cursor + 4)
          if (len < 8 || cursor + len > buf.length) break
          const value = buf.subarray(cursor + 8, cursor + len)
          const asText = (): string =>
            textEncoding === 65001 ? value.toString('utf8') : decodeText(value).text
          switch (type) {
            case 100:
              info.author = firstNonEmpty(info.author, asText())
              break
            case 105:
              info.title = firstNonEmpty(asText(), info.title)
              break
            case 101:
              info.publisher = firstNonEmpty(asText())
              break
            case 524:
              info.language = firstNonEmpty(asText())
              break
            case 106:
              info.descriptionFallback = asText()
              break
            case 501:
            case 502:
              info.series = firstNonEmpty(info.series, asText())
              break
            case 503:
              info.series = firstNonEmpty(info.series, asText())
              break
            default:
              break
          }
          cursor += len
        }
      }
    } catch {
      /* ignore EXTH problems */
    }
  }

  if (!info.author) {
    // Some MOBI files keep "Author: X" in the first text record.
    const guess = guessAuthorFromText(readCString(buf, rec0, 4096))
    if (guess.author) info.author = guess.author
  }

  // Text sample from the first text records (PalmDOC compressed).
  try {
    let text = ''
    const start = mobiHeaderOffset >= 0 ? 1 : 1
    for (let i = start; i < Math.min(offsets.length, 8); i++) {
      if (firstImageIndex !== 0xffffffff && i >= firstImageIndex) break
      const from = offsets[i]
      const to = recordEnd(i)
      if (!from || to <= from || from >= buf.length) continue
      const chunk = buf.subarray(from, Math.min(to, buf.length))
      let plain: string
      // PalmDOC compression lives in the PalmDOC header at record 0 (offset 0).
      const flag = rec0 + 2 <= buf.length ? buf.readUInt16BE(rec0) : 1
      if ((flag & 1) === 1) {
        const inflated = palmDocDecompress(chunk)
        plain = decodeMobiText(inflated, textEncoding)
      } else {
        plain = decodeMobiText(chunk, textEncoding)
      }
      text += ` ${plain}`
      if (text.length > 4000) break
    }
    info.excerpt = truncate(
      text.replace(/[^\S\n]+/g, ' ').replace(/[^\u0009\u000a\u0020-\u007e\u00a0-\uffef]/g, ' '),
      1200
    )
  } catch {
    /* ignore */
  }
  if (!info.title) info.title = titleFromFileName('')
  return info
}

function decodeMobiText(buf: Buffer, encoding: number): string {
  if (encoding === 65001) return buf.toString('utf8')
  if (encoding === 1252 || encoding === 0) return buf.toString('latin1')
  const decoded = decodeText(buf)
  return decoded.text
}

async function extractMobi(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await readFileCapped(ctx.filePath, 48 * 1024 * 1024)
  const info = scanMobi(buf)
  meta.title = cleanTitle(firstNonEmpty(info.title, meta.title))
  meta.author = firstNonEmpty(info.author)
  meta.publisher = firstNonEmpty(info.publisher)
  meta.series = cleanTitle(firstNonEmpty(info.series, seriesFromTitle(meta.title)))
  meta.language = firstNonEmpty(info.language, guessLanguage(info.excerpt, 'zh'))
  meta.excerpt = info.excerpt
  if (!meta.description && info.excerpt) meta.description = truncate(info.excerpt, 400)
  meta.notes.push('mobi best-effort')
  return meta
}

/* ------------------------------------------------------------------ */
/* RTF                                                                 */
/* ------------------------------------------------------------------ */

/** Extract the raw text of an RTF destination group (`\title`, `\author`, …). */
function rtfDestinationText(rtf: string, name: string): string {
  const marker = `\\${name}`
  let from = rtf.indexOf(marker)
  while (from >= 0) {
    const next = rtf[from + marker.length]
    // ensure we matched the whole control word (not \titleword)
    if (next === undefined || /[\s{\\}\\]/.test(next)) break
    from = rtf.indexOf(marker, from + marker.length)
  }
  if (from < 0) return ''
  let i = from + marker.length
  // skip one delimiter space
  if (rtf[i] === ' ') i++
  let depth = 0
  let raw = ''
  while (i < rtf.length) {
    const ch = rtf[i]
    if (ch === '{') {
      depth++
      raw += ch
      i++
      continue
    }
    if (ch === '}') {
      if (depth === 0) break
      depth--
      raw += ch
      i++
      continue
    }
    // stop at a following control word at this level
    if (ch === '\\' && depth === 0 && /^\\[a-zA-Z]/.test(rtf.slice(i, i + 2)) && !/^\\(?:u|'|\\|{|}|~|-|_|:|\|)/.test(rtf.slice(i, i + 3))) {
      break
    }
    raw += ch
    i++
  }
  return rtfUnescape(raw)
}

export function rtfToPlainText(rtf: string): { text: string; title: string; author: string } {
  const title = rtfDestinationText(rtf, 'title')
  const author = rtfDestinationText(rtf, 'author')

  let out = ''
  let skipDepth = -1
  let depth = 0
  let i = 0
  const DESTINATIONS =
    /^\{\\(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|filetbl|revtbl|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|datastore|latentstyles|pgptbl|shppict|nonshppict)/
  while (i < rtf.length) {
    const ch = rtf[i]
    if (ch === '{') {
      depth++
      if (skipDepth < 0 && DESTINATIONS.test(rtf.slice(i, i + 40))) skipDepth = depth
      i++
      continue
    }
    if (ch === '}') {
      if (skipDepth >= 0 && depth === skipDepth) skipDepth = -1
      depth--
      i++
      continue
    }
    if (skipDepth >= 0) {
      i++
      continue
    }
    if (ch === '\\') {
      const rest = rtf.slice(i)
      const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rest)
      if (word) {
        const name = word[1]
        const arg = word[2]
        if (name === 'par' || name === 'line' || name === 'sect' || name === 'row') out += '\n'
        else if (name === 'tab' || name === 'cell') out += '\t'
        else if (name === 'emdash') out += '—'
        else if (name === 'endash') out += '–'
        else if (name === 'lquote') out += '‘'
        else if (name === 'rquote') out += '’'
        else if (name === 'ldblquote') out += '“'
        else if (name === 'rdblquote') out += '”'
        else if (name === 'bullet') out += '•'
        else if (name === 'u' && arg !== undefined) {
          // \uN — negative values are UTF-16 code units > 32767.
          let code = parseInt(arg, 10)
          if (Number.isFinite(code)) {
            if (code < 0) code += 65536
            out += String.fromCharCode(code)
          }
          // Skip the ANSI fallback that follows: `\'xx` or a single `?`.
          const after = i + word[0].length
          const hexFallback = /^\\'[0-9a-fA-F]{2}/.exec(rtf.slice(after))
          if (hexFallback) {
            i += word[0].length + hexFallback[0].length
          } else if (rtf[after] === '?') {
            i += word[0].length + 1
          } else {
            i += word[0].length
          }
          continue
        }
        i += word[0].length
        continue
      }
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(rest)
      if (hex) {
        out += Buffer.from([parseInt(hex[1], 16)]).toString('latin1')
        i += 4
        continue
      }
      if (rest.length > 1) {
        i += 2
        continue
      }
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    out += ch
    i++
  }
  const text = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
  return { text: repairRtfBytes(text), title, author }
}

/** `\'xx` bytes are collected as latin1; re-decode them as GBK when needed. */
function repairRtfBytes(text: string): string {
  if (!/[\u0080-\u00ff]/.test(text)) return text
  const asLatin1 = Buffer.from(text, 'latin1')
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(asLatin1)
  const bad = (s: string): number => {
    let n = 0
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++
    return n
  }
  if (bad(asUtf8) === 0 && /[\u4e00-\u9fff]/.test(asUtf8)) return asUtf8
  if (/[\u4e00-\u9fff]/.test(text)) return text
  const asGbk = decodeText(asLatin1)
  if (bad(asGbk.text) === 0 && /[\u4e00-\u9fff]/.test(asGbk.text)) return asGbk.text
  return text
}

/**
 * Decode a raw RTF fragment (control words, `\uN`, `\'xx`) into plain text.
 * Deliberately avoids `rtfToPlainText` to keep destination extraction acyclic.
 */
function rtfUnescape(raw: string): string {
  if (!raw) return ''
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      const rest = raw.slice(i)
      const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rest)
      if (word) {
        const name = word[1]
        const arg = word[2]
        if (name === 'u' && arg !== undefined) {
          let code = parseInt(arg, 10)
          if (Number.isFinite(code)) {
            if (code < 0) code += 65536
            out += String.fromCharCode(code)
          }
          const after = i + word[0].length
          const hexFallback = /^\\'[0-9a-fA-F]{2}/.exec(raw.slice(after))
          if (hexFallback) i += word[0].length + hexFallback[0].length
          else if (raw[after] === '?') i += word[0].length + 1
          else i += word[0].length
          continue
        }
        if (name === 'par' || name === 'line') out += '\n'
        else if (name === 'tab') out += '\t'
        else if (name === 'emdash') out += '—'
        else if (name === 'endash') out += '–'
        else if (name === 'ldblquote') out += '“'
        else if (name === 'rdblquote') out += '”'
        i += word[0].length
        continue
      }
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(rest)
      if (hex) {
        out += Buffer.from([parseInt(hex[1], 16)]).toString('latin1')
        i += 4
        continue
      }
      i += rest.length > 1 ? 2 : 1
      continue
    }
    if (ch === '{' || ch === '}') {
      i++
      continue
    }
    out += ch
    i++
  }
  return repairRtfBytes(out).trim()
}

async function extractRtf(ctx: MetaContext, meta: ExtractedMeta): Promise<ExtractedMeta> {
  const buf = await readFileCapped(ctx.filePath, 8 * 1024 * 1024)
  const raw = buf.toString('latin1')
  const { text, title, author } = rtfToPlainText(raw)
  meta.title = cleanTitle(firstNonEmpty(title, meta.title))
  meta.author = firstNonEmpty(author)
  const guess = guessAuthorFromText(text.slice(0, 4000))
  if (!meta.author && guess.author) meta.author = guess.author
  meta.language = guessLanguage(text, 'zh')
  meta.excerpt = truncate(text, 500)
  const series = seriesFromTitle(meta.title)
  if (series) meta.series = series
  /** Full text is not returned here — the content channel re-derives it. */
  meta.notes.push(`rtf chars=${text.length}`)
  return meta
}


/* ------------------------------------------------------------------ */
/* MOBI text extraction (shared with the reader via library/index)      */
/* ------------------------------------------------------------------ */

interface RecordTable {
  offsets: number[]
  mobiHeader: number
  encoding: number
  firstImageIndex: number
  compression: number
  textLength: number
}

function readRecordTable(buf: Buffer): RecordTable | null {
  if (buf.length < 132) return null
  const numRecords = buf.readUInt16BE(76)
  if (!numRecords || numRecords > 60000) return null
  const offsets: number[] = []
  for (let i = 0; i < numRecords; i++) {
    const at = 78 + i * 8
    if (at + 4 > buf.length) break
    offsets.push(buf.readUInt32BE(at))
  }
  if (!offsets.length) return null
  const rec0 = offsets[0]
  let mobiHeader = -1
  let encoding = 1252
  let firstImageIndex = 0xffffffff
  let compression = 1
  let textLength = 0
  if (rec0 + 20 <= buf.length && buf.toString('latin1', rec0 + 16, rec0 + 20) === 'MOBI') {
    mobiHeader = rec0 + 16
    try {
      encoding = buf.readUInt32BE(mobiHeader + 12) || 1252
      compression = buf.readUInt16BE(mobiHeader + 0x12) || 1
      textLength = buf.readUInt32BE(mobiHeader + 4) > 0 ? buf.readUInt32BE(mobiHeader + 4) : 0
      if (mobiHeader + 112 <= buf.length) {
        const value = buf.readUInt32BE(mobiHeader + 108)
        firstImageIndex = value || 0xffffffff
      }
    } catch {
      /* partial */
    }
  }
  return { offsets, mobiHeader, encoding, firstImageIndex, compression, textLength }
}

function decodeChunk(chunk: Buffer, encoding: number): string {
  if (encoding === 65001) return chunk.toString('utf8')
  if (encoding === 1252 || encoding === 0) return chunk.toString('latin1')
  return decodeText(chunk).text
}

/** Extract readable text from a PalmDOC/MOBI container. Best effort. */
export function extractMobiText(buf: Buffer): string {
  const table = readRecordTable(buf)
  if (!table) return ''
  const { offsets, firstImageIndex, encoding, compression } = table
  if (offsets.length < 2) return ''
  const parts: string[] = []
  try {
    for (let i = 1; i < offsets.length; i++) {
      if (firstImageIndex !== 0xffffffff && i >= firstImageIndex) break
      if (parts.join('').length > 6 * 1024 * 1024) break
      const from = offsets[i]
      const to = i + 1 < offsets.length ? offsets[i + 1] : buf.length
      if (!from || to <= from || from >= buf.length) continue
      const chunk = buf.subarray(from, Math.min(to, buf.length))
      if (!chunk.length) continue
      let plain: Buffer
      if (compression === 1 || compression === 2) {
        // 2 = PalmDOC with "no compression" records; treat as raw
        plain = compression === 1 ? palmDocDecompress(chunk) : chunk
      } else {
        plain = chunk
      }
      const text = decodeChunk(plain, encoding)
      parts.push(text)
    }
  } catch {
    /* partial extraction is fine */
  }

  let out = parts.join('\n')
  // Strip control/binary noise while keeping CJK ranges.
  out = out
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (out.replace(/\s/g, '').length < 200) {
    // Last resort: keep printable runs from the whole file.
    const latin = buf.toString('utf8').replace(/[^\u0009\u000a\u0020-\u007e\u00a0-\uffef]/g, ' ')
    const cleaned = latin.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (cleaned.length > out.length) out = cleaned
  }
  return out
}


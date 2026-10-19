// ---------------------------------------------------------------------------
// Dola Toolkit — free book catalog sources.
//
//   gutendex        https://gutendex.com/books?search=…&page=n      (JSON)
//   openlibrary     https://openlibrary.org/search.json?q=…         (JSON)
//   standardebooks  https://standardebooks.org/ebooks?query=…       (HTML)
//
// Network reality varies per machine/region: each source fails softly and the
// caller receives a partial `CatalogResult` with an error message.
// ---------------------------------------------------------------------------

import type { CatalogBook, CatalogQuery, CatalogResult } from '../../shared/types'
import { decodeEntities, escapeRegExp, stripHtml, truncate } from './scan'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const TIMEOUT_MS = 12_000
const PAGE_SIZE = 24
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000

export interface FetchResult {
  ok: boolean
  status: number
  body: string
  error?: string
}

/** Small fetch wrapper with UA, redirect handling and a hard timeout. */
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number; accept?: string; headers?: Record<string, string> } = {}
): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: opts.accept ?? 'application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.headers ?? {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
    })
    const body = await res.text()
    if (!res.ok) {
      return { ok: false, status: res.status, body, error: `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, body }
  } catch (err) {
    const name = (err as { name?: string }).name
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? '请求超时'
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, status: 0, body: '', error: message }
  }
}

/* ------------------------------------------------------------------ */
/* Gutendex                                                            */
/* ------------------------------------------------------------------ */

interface GutendexBook {
  id: number
  title: string
  authors?: { name?: string }[]
  languages?: string[]
  formats?: Record<string, string>
  download_count?: number
}

interface GutendexResponse {
  count?: number
  results?: GutendexBook[]
}

function mapGutendex(book: GutendexBook): CatalogBook {
  const formats = book.formats ?? {}
  const entries = Object.entries(formats)
    .filter(([, url]) => typeof url === 'string' && /^https?:/i.test(url))
    .map(([mime, url]) => ({ mime, url }))
  const prefer = [
    'application/epub+zip',
    'application/epub',
    'text/plain; charset=utf-8',
    'text/plain; charset=us-ascii',
    'text/html; charset=utf-8'
  ]
  let downloadUrl: string | null = null
  for (const mime of prefer) {
    const hit = entries.find((e) => e.mime.toLowerCase() === mime.toLowerCase())
    if (hit) {
      downloadUrl = hit.url
      break
    }
  }
  if (!downloadUrl) {
    const epub = entries.find((e) => /epub/i.test(e.mime))
    const plain = entries.find((e) => /text\/plain/i.test(e.mime))
    downloadUrl = epub?.url ?? plain?.url ?? null
  }
  return {
    source: 'gutendex',
    id: `gutendex:${book.id}`,
    title: stripHtml(book.title || '未知书名'),
    author: (book.authors ?? []).map((a) => a.name ?? '').filter(Boolean).join(', '),
    language: (book.languages ?? []).join(','),
    cover: formats['image/jpeg'] ?? null,
    formats: entries,
    downloadUrl,
    downloads: book.download_count ?? 0
  }
}

async function searchGutendex(query: string, page: number): Promise<CatalogResult> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('search', query.trim())
  params.set('page', String(Math.max(1, page)))
  const url = `https://gutendex.com/books?${params.toString()}`
  const res = await httpGet(url)
  if (!res.ok) {
    return { books: [], total: 0, error: `Gutendex 请求失败：${res.error ?? '未知错误'}` }
  }
  try {
    const data = JSON.parse(res.body) as GutendexResponse
    const books = (data.results ?? []).map(mapGutendex)
    return { books, total: typeof data.count === 'number' ? data.count : books.length }
  } catch {
    return { books: [], total: 0, error: 'Gutendex 返回了无法解析的数据' }
  }
}

/* ------------------------------------------------------------------ */
/* Open Library                                                        */
/* ------------------------------------------------------------------ */

interface OpenLibraryDoc {
  key?: string
  title?: string
  author_name?: string[]
  language?: string[]
  cover_i?: number
  ia?: string[]
  ebook_access?: string
  first_publish_year?: number
}

interface OpenLibraryResponse {
  numFound?: number
  docs?: OpenLibraryDoc[]
}

function mapOpenLibrary(doc: OpenLibraryDoc): CatalogBook {
  const ia = doc.ia?.[0]
  const formats: { mime: string; url: string }[] = []
  let downloadUrl: string | null = null
  if (ia) {
    // Archive.org full-text PDFs follow this pattern for most scanned items.
    formats.push({
      mime: 'application/pdf',
      url: `https://archive.org/download/${encodeURIComponent(ia)}/${encodeURIComponent(ia)}.pdf`
    })
    const key = (doc.key ?? '').replace(/^\/works\//, '')
    if (key) {
      formats.push({ mime: 'text/html', url: `https://openlibrary.org/works/${encodeURIComponent(key)}` })
    }
    if (doc.ebook_access !== 'no_ebook') {
      downloadUrl = `https://archive.org/download/${encodeURIComponent(ia)}/${encodeURIComponent(ia)}.pdf`
    }
  }
  const cover = doc.cover_i
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
    : null
  return {
    source: 'openlibrary',
    id: `openlibrary:${doc.key ?? doc.title ?? Math.random().toString(36).slice(2)}`,
    title: stripHtml(doc.title ?? '未知书名'),
    author: (doc.author_name ?? []).join(', '),
    language: (doc.language ?? []).join(','),
    cover,
    formats,
    downloadUrl,
    downloads: 0
  }
}

async function searchOpenLibrary(query: string, page: number): Promise<CatalogResult> {
  const params = new URLSearchParams({
    q: query.trim() || 'subject:fiction',
    limit: String(PAGE_SIZE),
    page: String(Math.max(1, page)),
    fields: 'key,title,author_name,language,cover_i,ia,ebook_access,first_publish_year'
  })
  const url = `https://openlibrary.org/search.json?${params.toString()}`
  const res = await httpGet(url)
  if (!res.ok) {
    return { books: [], total: 0, error: `Open Library 请求失败：${res.error ?? '未知错误'}` }
  }
  try {
    const data = JSON.parse(res.body) as OpenLibraryResponse
    const books = (data.docs ?? []).map(mapOpenLibrary)
    return { books, total: typeof data.numFound === 'number' ? data.numFound : books.length }
  } catch {
    return { books: [], total: 0, error: 'Open Library 返回了无法解析的数据' }
  }
}

/* ------------------------------------------------------------------ */
/* Standard Ebooks (HTML scraping: the OPDS/atom feed is 401)          */
/* ------------------------------------------------------------------ */

function extractSeItems(html: string): { slug: string; title: string; author: string; cover: string | null }[] {
  const items: { slug: string; title: string; author: string; cover: string | null }[] = []
  const listStart = html.search(/<ol[^>]*class="[^"]*ebooks-list[^"]*"/i)
  const region = listStart >= 0 ? html.slice(listStart) : html
  const itemRe = /<li\b[^>]*about="(\/ebooks\/[^"]+)"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(region)) && items.length < 48) {
    const slug = m[1]
    const body = m[2]
    const title =
      stripHtml(/<span[^>]*property="schema:name"[^>]*>([\s\S]*?)<\/span>/i.exec(body)?.[1] ?? '') ||
      stripHtml(/<a\b[^>]*property="schema:url"[^>]*>([\s\S]*?)<\/a>/i.exec(body)?.[1] ?? '')
    const author = stripHtml(
      /<p[^>]*class="author"[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1] ?? ''
    )
    const coverRel = /<img\b[^>]*src="(\/images\/covers\/[^"]+)"/i.exec(body)?.[1] ?? null
    if (!title) continue
    items.push({
      slug,
      title,
      author,
      cover: coverRel ? `https://standardebooks.org${coverRel}` : null
    })
  }
  return items
}

function mapStandardEbooks(item: {
  slug: string
  title: string
  author: string
  cover: string | null
}): CatalogBook {
  const slugName = item.slug.split('/').filter(Boolean).pop() ?? item.slug
  const downloadUrl = `https://standardebooks.org${item.slug}/downloads/${encodeURIComponent(
    item.slug.split('/').filter(Boolean).slice(1).join('_')
  )}.epub`
  return {
    source: 'standardebooks',
    id: `standardebooks:${item.slug}`,
    title: item.title,
    author: item.author,
    language: 'en',
    cover: item.cover,
    formats: [
      { mime: 'application/epub+zip', url: downloadUrl },
      { mime: 'text/html', url: `https://standardebooks.org${item.slug}` }
    ],
    downloadUrl,
    downloads: 0
  }
}

async function searchStandardEbooks(query: string, page: number): Promise<CatalogResult> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('query', query.trim())
  if (page > 1) params.set('page', String(page))
  params.set('per-page', String(PAGE_SIZE))
  const url = `https://standardebooks.org/ebooks?${params.toString()}`
  const res = await httpGet(url)
  if (!res.ok) {
    return { books: [], total: 0, error: `Standard Ebooks 请求失败：${res.error ?? '未知错误'}` }
  }
  const items = extractSeItems(res.body)
  if (!items.length) {
    return { books: [], total: 0, error: 'Standard Ebooks 返回页面中没有找到书籍' }
  }
  const totalMatch = new RegExp('(\\d[\\d,]*)\\s*(?:ebooks|results)', 'i').exec(res.body)
  return {
    books: items.map(mapStandardEbooks),
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : items.length
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function searchCatalog(query: CatalogQuery): Promise<CatalogResult> {
  const q = typeof query?.query === 'string' ? query.query : ''
  const page = Math.max(1, Math.min(50, Number(query?.page ?? 1) || 1))
  try {
    switch (query?.source) {
      case 'openlibrary':
        return await searchOpenLibrary(q, page)
      case 'standardebooks':
        return await searchStandardEbooks(q, page)
      case 'gutendex':
      default:
        return await searchGutendex(q, page)
    }
  } catch (err) {
    return {
      books: [],
      total: 0,
      error: `书源请求失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pure parsers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

export function parseGutendexResponse(body: string): CatalogResult {
  try {
    const data = JSON.parse(body) as GutendexResponse
    const books = (data.results ?? []).map(mapGutendex)
    return { books, total: typeof data.count === 'number' ? data.count : books.length }
  } catch {
    return { books: [], total: 0, error: 'Gutendex 返回了无法解析的数据' }
  }
}

export function parseOpenLibraryResponse(body: string): CatalogResult {
  try {
    const data = JSON.parse(body) as OpenLibraryResponse
    const books = (data.docs ?? []).map(mapOpenLibrary)
    return { books, total: typeof data.numFound === 'number' ? data.numFound : books.length }
  } catch {
    return { books: [], total: 0, error: 'Open Library 返回了无法解析的数据' }
  }
}

export function parseStandardEbooksHtml(body: string): CatalogResult {
  const items = extractSeItems(body)
  if (!items.length) {
    return { books: [], total: 0, error: 'Standard Ebooks 返回页面中没有找到书籍' }
  }
  const totalMatch = /(\d[\d,]*)\s*(?:ebooks|results)/i.exec(body)
  return {
    books: items.map(mapStandardEbooks),
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : items.length
  }
}

const EXT_BY_MIME: { test: RegExp; ext: string }[] = [
  { test: /epub/i, ext: '.epub' },
  { test: /pdf/i, ext: '.pdf' },
  { test: /x-mobipocket|mobi|azw/i, ext: '.mobi' },
  { test: /fb2|fictionbook/i, ext: '.fb2' },
  { test: /rtf/i, ext: '.rtf' },
  { test: /plain|text\/html/i, ext: '.txt' }
]

function extensionFor(url: string, mime: string): string {
  const fromUrl = /\.(epub|pdf|mobi|azw3|fb2|rtf|txt)(?:[?#]|$)/i.exec(url)
  if (fromUrl) return `.${fromUrl[1].toLowerCase()}`
  for (const entry of EXT_BY_MIME) {
    if (entry.test.test(mime)) return entry.ext
  }
  return '.epub'
}

export function fileNameForBook(book: CatalogBook, url: string, mime: string): string {
  const base = truncate(book.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' '), 70) || 'book'
  const author = truncate(book.author.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' '), 40)
  const stem = author ? `${base} - ${author}` : base
  return `${stem}${extensionFor(url, mime)}`
}

export interface DownloadResult {
  ok: boolean
  data: Buffer
  fileName: string
  mime: string
  error?: string
}

/** Download a catalog book (max 80 MB, 60 s, follows redirects). */
export async function downloadCatalogBook(book: CatalogBook): Promise<DownloadResult> {
  const failures: string[] = []
  const candidates: string[] = []
  if (book.downloadUrl) candidates.push(book.downloadUrl)
  for (const format of book.formats) {
    if (/epub|pdf|mobipocket|plain|fb2/i.test(format.mime)) candidates.push(format.url)
  }
  const ordered = Array.from(new Set(candidates.filter((u) => /^https?:\/\//i.test(u))))
  if (!ordered.length) {
    return { ok: false, data: Buffer.alloc(0), fileName: '', mime: '', error: '这本书没有可用的下载直链' }
  }
  for (const url of ordered.slice(0, 3)) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
      if (!res.ok) {
        failures.push(`${url} → HTTP ${res.status}`)
        continue
      }
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > MAX_DOWNLOAD_BYTES) {
        failures.push(`${url} → 文件过大`)
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
        failures.push(`${url} → 文件过大`)
        continue
      }
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
      if (buffer.length < 64) {
        failures.push(`${url} → 内容为空`)
        continue
      }
      return {
        ok: true,
        data: buffer,
        mime,
        fileName: fileNameForBook(book, url, mime)
      }
    } catch (err) {
      const name = (err as { name?: string }).name
      failures.push(
        `${url} → ${name === 'TimeoutError' || name === 'AbortError' ? '下载超时' : err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return {
    ok: false,
    data: Buffer.alloc(0),
    fileName: '',
    mime: '',
    error: `下载失败：${failures.join('；')}`
  }
}

/** Escape helper re-exported for tests. */
export { escapeRegExp, decodeEntities }

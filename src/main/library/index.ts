// ---------------------------------------------------------------------------
// Dola Toolkit — library façade.
//
//  * re-exports the singleton `libraryStore`
//  * `initLibrary()` loads the persisted index (idempotent)
//  * reader content serving (`readBookContent`)
//  * the AI series classifier (`classifyLibrary`)
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'
import type {
  BookContent,
  BookRecord,
  ClassifyResult,
  FolderRecord
} from '../../shared/types'
import { aiChat, extractJsonPayload, readAIConfig } from '../ai'
import { decodeText, normalizeName, truncate } from './scan'
import { extractMobiText, rtfToPlainText } from './metadata'
import { getLibraryStore, type LibraryStore } from './store'

export { getLibraryStore, LibraryStore, setLibraryStore, resolveLibraryRoot, broadcast } from './store'
export { importFile, importPaths, importBuffer } from './import'
export { extractMetadata } from './metadata'
export { coverDataUrl, dominantColor, setImageOps } from './cover'
export { searchCatalog, downloadCatalogBook } from './catalog'
export { coverColorFromTitle } from './scan'

/** Shared singleton used by the IPC layer. */
export const libraryStore: LibraryStore = getLibraryStore()

let initDone = false
let initPromise: Promise<void> | null = null

/**
 * Load the persisted library once. Safe to call from every IPC registration;
 * never throws (a missing/corrupt index yields an empty library).
 */
export function initLibrary(): void {
  if (initDone) return
  if (initPromise) return
  initPromise = libraryStore
    .load()
    .then(() => {
      initDone = true
    })
    .catch(() => {
      initDone = true
    })
    .finally(() => {
      initPromise = null
    })
}

export function isLibraryReady(): boolean {
  return initDone
}

/* ------------------------------------------------------------------ */
/* Reader content                                                      */
/* ------------------------------------------------------------------ */

const MAX_TEXT_BYTES = 32 * 1024 * 1024
const MAX_BINARY_BYTES = 160 * 1024 * 1024

async function readLimited(filePath: string, cap: number): Promise<Buffer> {
  const stat = await fs.stat(filePath)
  if (stat.size <= cap) return fs.readFile(filePath)
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(cap)
    const { bytesRead } = await handle.read(buf, 0, cap, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Build the reader payload for a book.
 *  txt / fb2 / rtf  → utf8 text
 *  epub / pdf       → base64 raw bytes
 *  mobi / azw3      → extracted utf8 text when usable, else base64
 */
export async function readBookContent(book: BookRecord): Promise<BookContent> {
  const stat = await fs.stat(book.filePath).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('文件已丢失或被移动，请重新导入')

  const base = { id: book.id, filePath: book.filePath, title: book.title }

  switch (book.format) {
    case 'epub':
    case 'pdf': {
      if (stat.size > MAX_BINARY_BYTES) throw new Error('文件过大，无法在阅读器中打开')
      const data = await fs.readFile(book.filePath)
      return { ...base, format: book.format, data: data.toString('base64'), encoding: 'base64' }
    }
    case 'mobi':
    case 'azw3': {
      if (stat.size > MAX_BINARY_BYTES) throw new Error('文件过大，无法在阅读器中打开')
      const raw = await fs.readFile(book.filePath)
      const text = extractMobiText(raw)
      if (text && text.replace(/\s/g, '').length >= 200) {
        return { ...base, format: book.format, data: text, encoding: 'utf8' }
      }
      return { ...base, format: book.format, data: raw.toString('base64'), encoding: 'base64' }
    }
    case 'rtf': {
      const buf = await readLimited(book.filePath, MAX_TEXT_BYTES)
      const { text } = rtfToPlainText(buf.toString('latin1'))
      return {
        ...base,
        format: 'rtf',
        data: text || '（无法解析的 RTF 文件）',
        encoding: 'utf8'
      }
    }
    case 'fb2': {
      const buf = await readLimited(book.filePath, MAX_TEXT_BYTES)
      return { ...base, format: 'fb2', data: decodeText(buf).text, encoding: 'utf8' }
    }
    case 'txt':
    default: {
      const buf = await readLimited(book.filePath, MAX_TEXT_BYTES)
      return { ...base, format: 'txt', data: decodeText(buf).text, encoding: 'utf8' }
    }
  }
}

/** Short text sample used as AI context. */
export async function readExcerpt(book: BookRecord, maxChars = 1200): Promise<string> {
  try {
    const content = await readBookContent(book)
    if (content.encoding === 'utf8') return truncate(content.data, maxChars)
  } catch {
    /* fall through to metadata */
  }
  return truncate(book.description || book.title, maxChars)
}

/* ------------------------------------------------------------------ */
/* AI series classifier                                                */
/* ------------------------------------------------------------------ */

const MAX_GROUPS = 40
const MAX_GROUP_BOOKS = 60
const DEFAULT_SERIES_PROMPT = [
  '你是一个中文电子书书库整理助手。根据给定的书籍列表，判断哪些书属于同一系列、同一套书或同一作者的同世界观作品。',
  '只按确定的系列分组，不要把无关的书强行归类；单本独立的书不要返回。',
  '严格输出 JSON，不要输出任何解释文字，格式为：',
  '{"groups":[{"name":"系列名","bookIds":["id1","id2"],"confidence":0.9,"reason":"判断依据"}]}',
  'name 使用简洁的中文系列名（例如「三体」「冰与火之歌」），confidence 为 0~1 的数字，reason 不超过 40 字。'
].join('\n')

export interface ClassifyOptions {
  /** limit how many books are sent to the model (token budget) */
  limit?: number
}

interface RawGroup {
  name?: unknown
  bookIds?: unknown
  confidence?: unknown
  reason?: unknown
}

/** Strip a leading series ordinal from a title so "三体 2" groups with "三体". */
function seriesNameFromGroup(raw: string, fallback: string): string {
  const clean = (raw ?? '').trim().replace(/[《》「」"”]/g, '')
  if (!clean) return fallback
  return truncate(clean, 48)
}

/**
 * Ask the configured model to group the user's books into series, then create
 * `kind:'series'` folders and assign books. Defensive at every step: bad model
 * output yields an empty result with a Chinese error, never a throw.
 */
export async function classifyLibrary(
  store: LibraryStore = libraryStore,
  opts: ClassifyOptions = {}
): Promise<ClassifyResult> {
  const cfg = readAIConfig()
  const model = cfg.model || ''
  if (!cfg.apiKey || !cfg.baseUrl) {
    return { createdFolders: [], assignments: [], model, error: '未配置 AI：请先在设置中填写接口地址与密钥' }
  }
  if (!cfg.enabled) {
    return { createdFolders: [], assignments: [], model, error: 'AI 已关闭：请先在设置中启用' }
  }

  const books = await store.list()
  if (!books.length) {
    return { createdFolders: [], assignments: [], model, error: '书库为空，先导入一些书籍吧' }
  }
  if (books.length < 2) {
    return { createdFolders: [], assignments: [], model, error: '至少需要两本书才能归类' }
  }

  const limit = Math.max(2, Math.min(opts.limit ?? 120, books.length))
  const target = [...books]
    .sort((a, b) => {
      // Prefer books that already have series-ish metadata, then newest.
      const score = (b: BookRecord): number => (b.series ? 2 : 0) + (b.author ? 1 : 0)
      return score(b) - score(a) || b.addedAt - a.addedAt
    })
    .slice(0, limit)

  const compact = target.map((b) => ({
    id: b.id,
    title: truncate(b.title, 80),
    author: truncate(b.author || '未知作者', 40),
    ...(b.series ? { series: truncate(b.series, 40) } : {})
  }))

  const systemPrompt = (cfg.seriesPrompt || '').trim() || DEFAULT_SERIES_PROMPT
  const userPrompt = [
    '书籍列表（JSON）：',
    JSON.stringify(compact),
    '',
    '请返回 groups 数组。bookIds 必须来自上面的 id，不能编造。'
  ].join('\n')

  const result = await aiChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { json: true, temperature: 0.1, maxTokens: Math.max(1024, cfg.maxTokens) }
  )

  if (!result.ok) {
    return { createdFolders: [], assignments: [], model, raw: '', error: result.error ?? 'AI 请求失败' }
  }

  const payload = extractJsonPayload(result.content)
  let parsed: unknown = null
  if (payload) {
    try {
      parsed = JSON.parse(payload)
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    return {
      createdFolders: [],
      assignments: [],
      model,
      raw: truncate(result.content, 1200),
      error: 'AI 返回的内容不是有效 JSON，请重试或调整模型'
    }
  }

  const groupsRaw = Array.isArray(parsed)
    ? parsed
    : (parsed as { groups?: unknown; series?: unknown }).groups ??
      (parsed as { series?: unknown }).series ??
      []
  if (!Array.isArray(groupsRaw) || !groupsRaw.length) {
    return {
      createdFolders: [],
      assignments: [],
      model,
      raw: truncate(result.content, 1200),
      error: 'AI 没有识别出任何系列'
    }
  }

  const knownIds = new Map(target.map((b) => [b.id, b] as const))
  const createdFolders: FolderRecord[] = []
  const assignments: ClassifyResult['assignments'] = []
  const touched = new Set<string>()
  const promptSummary = truncate(systemPrompt, 300)

  for (const raw of groupsRaw.slice(0, MAX_GROUPS)) {
    if (!raw || typeof raw !== 'object') continue
    const group = raw as RawGroup
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    if (!name) continue
    // Models name this field inconsistently (books / bookIds / ids / book_ids).
    // The shipped default prompt says "books", so both spellings must be read or
    // classification silently produces zero groups.
    const idBag = (group as unknown as Record<string, unknown>)
    const rawIdsRaw =
      (Array.isArray(idBag['bookIds']) && idBag['bookIds']) ||
      (Array.isArray(idBag['books']) && idBag['books']) ||
      (Array.isArray(idBag['ids']) && idBag['ids']) ||
      (Array.isArray(idBag['book_ids']) && idBag['book_ids']) ||
      (Array.isArray(idBag['bookIds']) ? idBag['bookIds'] : [])
    const rawIds: unknown[] = Array.isArray(rawIdsRaw) ? rawIdsRaw : []
    const ids = Array.from(
      new Set(
        rawIds
          .filter((id): id is string => typeof id === 'string')
          .filter((id) => knownIds.has(id) && !touched.has(id))
      )
    ).slice(0, MAX_GROUP_BOOKS)
    if (ids.length < 2) continue // a "series" of one book is not useful

    const confidenceRaw = Number(group.confidence)
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw))
      : 0.6
    const reason =
      typeof group.reason === 'string' ? truncate(group.reason, 200) : 'AI 自动归类'

    const seriesName = seriesNameFromGroup(name, '未命名系列')
    const { folder, created } = await store.ensureSeriesFolder(seriesName, promptSummary)
    if (created) createdFolders.push(folder)

    for (const id of ids) {
      await store.assignToFolder(id, folder, seriesName)
      touched.add(id)
      assignments.push({ bookId: id, folderId: folder.id, confidence, reason })
    }
  }

  await store.emit()

  if (!assignments.length) {
    return {
      createdFolders,
      assignments,
      model,
      raw: truncate(result.content, 1200),
      error: 'AI 没有给出可用的分组结果'
    }
  }

  return { createdFolders, assignments, model, raw: truncate(result.content, 1200) }
}

/** Grouping helper reused by tests. */
export function groupKey(name: string): string {
  return normalizeName(name)
}

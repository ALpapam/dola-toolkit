// ---------------------------------------------------------------------------
// Dola Toolkit — persistent library store.
//
// `library.json` lives in the app data dir:
//   { schema: 1, books, folders, coverDir, bookDir }
// Writes are debounced + atomic (tmp file → rename) and every mutation emits
// `library:changed` to all windows.
// ---------------------------------------------------------------------------

import { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BookRecord,
  FolderRecord,
  ImportOutcome,
  LibraryState
} from '../../shared/types'
import { IPC } from '../../shared/channels'
import { normalizeName, uniquePath } from './scan'
import { getDataDir } from '../store'

export interface LibraryData {
  schema: 1
  books: BookRecord[]
  folders: FolderRecord[]
  coverDir: string
  bookDir: string
}

export interface BookPatch {
  title?: string
  author?: string
  progress?: number
  lastLocation?: string | null
  favorite?: boolean
  tags?: string[]
  folderIds?: string[]
  series?: string
  seriesKey?: string | null
  coverPath?: string | null
  coverColor?: string | null
  description?: string
  language?: string
  publisher?: string
}

export interface FolderPatch {
  name?: string
  parentId?: string | null
  kind?: FolderRecord['kind']
  color?: string | null
  order?: number
  prompt?: string
}

const SAVE_DEBOUNCE_MS = 250

/** Broadcast a payload to every open window; never throws. */
export function broadcast(channel: string, payload: unknown): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch {
    /* window teardown race — nothing to do */
  }
}

export class LibraryStore {
  private data: LibraryData | null = null
  private rootDir: string
  private saveTimer: NodeJS.Timeout | null = null
  private loading: Promise<LibraryData> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private importing: { total: number; done: number; current: string } | null = null
  private readonly rootProvider: () => string

  constructor(rootDir: string | (() => string)) {
    this.rootProvider = typeof rootDir === 'function' ? rootDir : () => rootDir
    this.rootDir = this.rootProvider()
  }

  /** Absolute library root (`<dataDir>/library`). */
  get root(): string {
    const next = this.rootProvider()
    if (next !== this.rootDir) {
      this.rootDir = next
      this.data = null
    }
    return this.rootDir
  }

  get indexFile(): string {
    return path.join(this.root, 'library.json')
  }

  get booksDir(): string {
    return path.join(this.root, 'books')
  }

  get coversDir(): string {
    return path.join(this.root, 'covers')
  }

  /* ---------------------------------------------------------------- */
  /* loading / saving                                                  */
  /* ---------------------------------------------------------------- */

  async load(): Promise<LibraryData> {
    if (this.data) return this.data
    if (this.loading) return this.loading
    this.loading = this.doLoad()
    try {
      this.data = await this.loading
      return this.data
    } finally {
      this.loading = null
    }
  }

  private async doLoad(): Promise<LibraryData> {
    const root = this.root
    const empty: LibraryData = {
      schema: 1,
      books: [],
      folders: [],
      coverDir: path.join(root, 'covers'),
      bookDir: path.join(root, 'books')
    }
    await fs.mkdir(empty.coverDir, { recursive: true }).catch(() => undefined)
    await fs.mkdir(empty.bookDir, { recursive: true }).catch(() => undefined)
    try {
      const raw = await fs.readFile(path.join(root, 'library.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<LibraryData>
      const books = Array.isArray(parsed.books) ? parsed.books.filter(isUsableBook).map(normalizeBook) : []
      const folders = Array.isArray(parsed.folders) ? parsed.folders.filter(isUsableFolder).map(normalizeFolder) : []
      return {
        schema: 1,
        books,
        folders,
        coverDir: typeof parsed.coverDir === 'string' && parsed.coverDir ? parsed.coverDir : empty.coverDir,
        bookDir: typeof parsed.bookDir === 'string' && parsed.bookDir ? parsed.bookDir : empty.bookDir
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Corrupt index: keep a backup so the user can recover manually.
        await fs
          .copyFile(path.join(root, 'library.json'), path.join(root, `library.corrupt-${Date.now()}.json`))
          .catch(() => undefined)
      }
      return empty
    }
  }

  /** Queue an atomic write; resolves once the data is on disk. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  /** Force a synchronous-ish flush (used on quit). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.saveNow()
  }

  private async saveNow(): Promise<void> {
    const snapshot = this.data
    if (!snapshot) return
    this.saveChain = this.saveChain.then(async () => {
      const root = this.root
      await fs.mkdir(root, { recursive: true }).catch(() => undefined)
      const target = path.join(root, 'library.json')
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      const payload = JSON.stringify(
        {
          schema: 1,
          books: snapshot.books,
          folders: snapshot.folders,
          coverDir: snapshot.coverDir,
          bookDir: snapshot.bookDir
        },
        null,
        0
      )
      try {
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, target)
      } catch {
        await fs.unlink(tmp).catch(() => undefined)
      }
    })
    await this.saveChain.catch(() => undefined)
  }

  /* ---------------------------------------------------------------- */
  /* state / broadcast                                                 */
  /* ---------------------------------------------------------------- */

  async state(): Promise<LibraryState> {
    const data = await this.load()
    return {
      books: [...data.books],
      folders: [...data.folders],
      rootDir: this.root,
      importing: this.importing
    }
  }

  /** Emit the current state to every window. */
  async emit(): Promise<void> {
    broadcast(IPC.libraryChanged, await this.state())
  }

  setImporting(progress: { total: number; done: number; current: string } | null): void {
    this.importing = progress
    broadcast(IPC.libraryProgress, progress ?? { done: 0, total: 0, current: '' })
  }

  get importingState(): { total: number; done: number; current: string } | null {
    return this.importing
  }

  /* ---------------------------------------------------------------- */
  /* books                                                             */
  /* ---------------------------------------------------------------- */

  async list(): Promise<BookRecord[]> {
    return [...(await this.load()).books]
  }

  async get(id: string): Promise<BookRecord | null> {
    const data = await this.load()
    return data.books.find((b) => b.id === id) ?? null
  }

  /**
   * Find a book by its managed path or by the original source path.
   * Used to skip re-importing a file that is already in the library.
   */
  async findByPath(sourcePath: string): Promise<BookRecord | null> {
    const data = await this.load()
    if (!sourcePath) return null
    const target = sourcePath.toLowerCase()
    return (
      data.books.find(
        (b) =>
          b.filePath.toLowerCase() === target ||
          (b.sourcePath ?? '').toLowerCase() === target
      ) ?? null
    )
  }

  async addBooks(records: BookRecord[]): Promise<BookRecord[]> {
    if (!records.length) return []
    const data = await this.load()
    const added: BookRecord[] = []
    for (const record of records) {
      const existing = data.books.find(
        (b) => b.filePath.toLowerCase() === record.filePath.toLowerCase()
      )
      if (existing) {
        existing.updatedAt = Date.now()
        existing.size = record.size || existing.size
        added.push(existing)
        continue
      }
      data.books.push(record)
      added.push(record)
    }
    this.scheduleSave()
    await this.emit()
    return added
  }

  async removeBooks(ids: string[]): Promise<LibraryState> {
    const data = await this.load()
    const wanted = new Set(ids)
    if (!wanted.size) return this.state()
    data.books = data.books.filter((b) => !wanted.has(b.id))
    this.scheduleSave()
    await this.emit()
    return this.state()
  }

  async updateBook(id: string, patch: BookPatch): Promise<BookRecord | null> {
    const data = await this.load()
    const book = data.books.find((b) => b.id === id)
    if (!book) return null
    if (typeof patch.title === 'string' && patch.title.trim()) book.title = patch.title.trim()
    if (typeof patch.author === 'string') book.author = patch.author.trim()
    if (typeof patch.progress === 'number' && Number.isFinite(patch.progress)) {
      book.progress = Math.min(1, Math.max(0, patch.progress))
    }
    if (patch.lastLocation !== undefined) book.lastLocation = patch.lastLocation
    if (typeof patch.favorite === 'boolean') book.favorite = patch.favorite
    if (Array.isArray(patch.tags)) {
      book.tags = Array.from(new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean)))
    }
    if (Array.isArray(patch.folderIds)) {
      book.folderIds = Array.from(new Set(patch.folderIds.filter(Boolean)))
    }
    if (typeof patch.series === 'string') book.series = patch.series.trim()
    if (patch.seriesKey !== undefined) book.seriesKey = patch.seriesKey
    if (patch.coverPath !== undefined) book.coverPath = patch.coverPath
    if (patch.coverColor !== undefined) book.coverColor = patch.coverColor
    if (typeof patch.description === 'string') book.description = patch.description
    if (typeof patch.language === 'string') book.language = patch.language
    if (typeof patch.publisher === 'string') book.publisher = patch.publisher
    // Sync relies on updatedAt to resolve last-write-wins.
    book.updatedAt = Date.now()
    this.scheduleSave()
    await this.emit()
    return book
  }

  /** Internal bulk update without per-record broadcast (sync/classify). */
  async applyBookPatch(id: string, patch: Partial<BookRecord>, opts?: { touch?: boolean }): Promise<BookRecord | null> {
    const data = await this.load()
    const book = data.books.find((b) => b.id === id)
    if (!book) return null
    Object.assign(book, patch, { id: book.id })
    if (opts?.touch !== false) book.updatedAt = Date.now()
    this.scheduleSave()
    return book
  }

  /** Add records coming from a remote sync merge (no deletes). */
  async mergeBooks(remote: BookRecord[]): Promise<number> {
    const data = await this.load()
    let changed = 0
    for (const incoming of remote) {
      if (!isUsableBook(incoming)) continue
      const local = data.books.find((b) => b.id === incoming.id)
      if (!local) {
        data.books.push(normalizeBook(incoming))
        changed++
        continue
      }
      if ((incoming.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
        const keepPath = local.filePath
        Object.assign(local, normalizeBook(incoming), { filePath: local.filePath || keepPath })
        changed++
      }
    }
    if (changed) {
      this.scheduleSave()
      await this.emit()
    }
    return changed
  }

  async search(query: string): Promise<BookRecord[]> {
    const data = await this.load()
    const q = query.trim().toLowerCase()
    if (!q) return [...data.books]
    return data.books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        b.series.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q))
    )
  }

  async markRead(id: string, location: string | null, progress: number): Promise<BookRecord | null> {
    return this.updateBook(id, { lastLocation: location, progress })
  }

  /* ---------------------------------------------------------------- */
  /* folders                                                           */
  /* ---------------------------------------------------------------- */

  async createFolder(name: string, parentId: string | null = null, kind: FolderRecord['kind'] = 'manual'): Promise<FolderRecord> {
    const data = await this.load()
    const cleanName = name.trim() || '新建文件夹'
    const folder: FolderRecord = {
      id: randomUUID(),
      name: cleanName,
      parentId: parentId && data.folders.some((f) => f.id === parentId) ? parentId : null,
      kind,
      color: null,
      order: data.folders.filter((f) => f.parentId === (parentId ?? null)).length,
      createdAt: Date.now()
    }
    data.folders.push(folder)
    this.scheduleSave()
    await this.emit()
    return folder
  }

  /** Find a folder by normalised name, optionally limited to one kind. */
  async findFolderByName(name: string, kind?: FolderRecord['kind']): Promise<FolderRecord | null> {
    const data = await this.load()
    const target = normalizeName(name)
    if (!target) return null
    return (
      data.folders.find((f) => normalizeName(f.name) === target && (!kind || f.kind === kind)) ??
      data.folders.find((f) => normalizeName(f.name) === target) ??
      null
    )
  }

  /** Create-or-return an existing series folder (used by the AI classifier). */
  async ensureSeriesFolder(name: string, prompt?: string): Promise<{ folder: FolderRecord; created: boolean }> {
    const data = await this.load()
    const existing = await this.findFolderByName(name)
    if (existing) {
      if (!existing.kind || existing.kind === 'manual') existing.kind = 'series'
      if (prompt) existing.prompt = prompt
      this.scheduleSave()
      return { folder: existing, created: false }
    }
    const folder: FolderRecord = {
      id: randomUUID(),
      name: name.trim() || '未命名系列',
      parentId: null,
      kind: 'series',
      color: null,
      order: data.folders.filter((f) => !f.parentId).length,
      createdAt: Date.now(),
      ...(prompt ? { prompt } : {})
    }
    data.folders.push(folder)
    this.scheduleSave()
    return { folder, created: true }
  }

  async updateFolder(id: string, patch: FolderPatch): Promise<FolderRecord | null> {
    const data = await this.load()
    const folder = data.folders.find((f) => f.id === id)
    if (!folder) return null
    if (typeof patch.name === 'string' && patch.name.trim()) folder.name = patch.name.trim()
    if (patch.parentId !== undefined) {
      folder.parentId = patch.parentId && patch.parentId !== id && data.folders.some((f) => f.id === patch.parentId)
        ? patch.parentId
        : null
    }
    if (patch.kind) folder.kind = patch.kind
    if (patch.color !== undefined) folder.color = patch.color
    if (typeof patch.order === 'number' && Number.isFinite(patch.order)) folder.order = patch.order
    if (typeof patch.prompt === 'string') folder.prompt = patch.prompt
    this.scheduleSave()
    await this.emit()
    return folder
  }

  async deleteFolder(id: string): Promise<LibraryState> {
    const data = await this.load()
    const removed = new Set<string>([id])
    // Re-parent children to the deleted folder's parent so nothing vanishes.
    const target = data.folders.find((f) => f.id === id)
    for (const folder of data.folders) {
      if (folder.parentId === id) folder.parentId = target?.parentId ?? null
    }
    data.folders = data.folders.filter((f) => !removed.has(f.id))
    for (const book of data.books) {
      if (book.folderIds.some((fid) => removed.has(fid))) {
        book.folderIds = book.folderIds.filter((fid) => !removed.has(fid))
        if (book.seriesKey && removed.has(book.seriesKey)) book.seriesKey = null
        book.updatedAt = Date.now()
      }
    }
    this.scheduleSave()
    await this.emit()
    return this.state()
  }

  /** Assign folders + series key to a book, deduped, without touching other folders. */
  async assignToFolder(
    bookId: string,
    folder: FolderRecord,
    seriesName: string
  ): Promise<void> {
    const data = await this.load()
    const book = data.books.find((b) => b.id === bookId)
    if (!book) return
    const next = new Set(book.folderIds.filter(Boolean))
    next.add(folder.id)
    book.folderIds = [...next]
    book.seriesKey = folder.id
    if (!book.series) book.series = seriesName || folder.name
    book.updatedAt = Date.now()
    this.scheduleSave()
  }

  /** Absolute path for a managed copy of `sourcePath`. */
  async managedPathFor(sourcePath: string): Promise<string> {
    const ext = path.extname(sourcePath).toLowerCase()
    const base = path.basename(sourcePath, path.extname(sourcePath))
    return uniquePath(this.booksDir, base, ext)
  }

  /** Read the persisted data (sync needs the raw arrays). */
  async snapshot(): Promise<LibraryData> {
    const data = await this.load()
    return {
      schema: 1,
      books: data.books.map((b) => ({ ...b })),
      folders: data.folders.map((f) => ({ ...f })),
      coverDir: data.coverDir,
      bookDir: data.bookDir
    }
  }

  /** Synchronous view of the loaded books (empty when not loaded yet). */
  cachedBooks(): BookRecord[] {
    return this.data ? this.data.books.map((b) => ({ ...b })) : []
  }

  /** Synchronous view of the loaded folders (empty when not loaded yet). */
  cachedFolders(): FolderRecord[] {
    return this.data ? this.data.folders.map((f) => ({ ...f })) : []
  }

  /** Replace folders wholesale (remote merge). */
  async mergeFolders(remote: FolderRecord[]): Promise<number> {
    const data = await this.load()
    let changed = 0
    for (const incoming of remote) {
      if (!isUsableFolder(incoming)) continue
      const local = data.folders.find((f) => f.id === incoming.id)
      if (!local) {
        data.folders.push(normalizeFolder(incoming))
        changed++
        continue
      }
      // Folders have no updatedAt; remote only wins for brand-new ids.
    }
    if (changed) {
      this.scheduleSave()
      await this.emit()
    }
    return changed
  }

  /** Drop the in-memory copy (tests / data dir change). */
  resetCache(): void {
    this.data = null
  }
}

/* ------------------------------------------------------------------ */
/* normalisation helpers                                               */
/* ------------------------------------------------------------------ */

function isUsableBook(value: unknown): value is BookRecord {
  if (!value || typeof value !== 'object') return false
  const rec = value as Partial<BookRecord>
  return typeof rec.id === 'string' && rec.id.length > 0 && typeof rec.title === 'string'
}

function isUsableFolder(value: unknown): value is FolderRecord {
  if (!value || typeof value !== 'object') return false
  const rec = value as Partial<FolderRecord>
  return typeof rec.id === 'string' && typeof rec.name === 'string'
}

const FORMATS = new Set(['epub', 'pdf', 'fb2', 'mobi', 'txt', 'rtf', 'azw3', 'unknown'])

export function normalizeBook(rec: BookRecord): BookRecord {
  const now = Date.now()
  return {
    id: String(rec.id),
    title: String(rec.title || '未命名书籍'),
    author: String(rec.author ?? ''),
    format: FORMATS.has(String(rec.format)) ? rec.format : 'unknown',
    filePath: String(rec.filePath ?? ''),
    size: Number.isFinite(rec.size) ? Number(rec.size) : 0,
    addedAt: Number.isFinite(rec.addedAt) ? Number(rec.addedAt) : now,
    updatedAt: Number.isFinite(rec.updatedAt) ? Number(rec.updatedAt) : now,
    coverPath: typeof rec.coverPath === 'string' ? rec.coverPath : null,
    coverColor: typeof rec.coverColor === 'string' ? rec.coverColor : null,
    description: String(rec.description ?? ''),
    language: String(rec.language ?? ''),
    publisher: String(rec.publisher ?? ''),
    series: String(rec.series ?? ''),
    progress: Number.isFinite(rec.progress) ? Math.min(1, Math.max(0, Number(rec.progress))) : 0,
    lastLocation: typeof rec.lastLocation === 'string' ? rec.lastLocation : null,
    folderIds: Array.isArray(rec.folderIds) ? rec.folderIds.filter((x): x is string => typeof x === 'string') : [],
    seriesKey: typeof rec.seriesKey === 'string' ? rec.seriesKey : null,
    favorite: Boolean(rec.favorite),
    tags: Array.isArray(rec.tags) ? rec.tags.filter((x): x is string => typeof x === 'string') : [],
    sourcePath: typeof rec.sourcePath === 'string' ? rec.sourcePath : null
  }
}

export function normalizeFolder(rec: FolderRecord): FolderRecord {
  const kind = rec.kind === 'series' || rec.kind === 'smart' ? rec.kind : 'manual'
  return {
    id: String(rec.id),
    name: String(rec.name || '未命名文件夹'),
    parentId: typeof rec.parentId === 'string' ? rec.parentId : null,
    kind,
    color: typeof rec.color === 'string' ? rec.color : null,
    order: Number.isFinite(rec.order) ? Number(rec.order) : 0,
    createdAt: Number.isFinite(rec.createdAt) ? Number(rec.createdAt) : Date.now(),
    ...(typeof rec.prompt === 'string' ? { prompt: rec.prompt } : {})
  }
}

/* ------------------------------------------------------------------ */
/* singleton                                                           */
/* ------------------------------------------------------------------ */

/**
 * The store is created lazily against `getDataDir()` from main-core. Import is
 * resolved at call time so a partially-initialised app can still load us.
 */
let singleton: LibraryStore | null = null

export function getLibraryStore(): LibraryStore {
  if (singleton) return singleton
  singleton = new LibraryStore(() => resolveLibraryRoot())
  return singleton
}

export function setLibraryStore(store: LibraryStore): void {
  singleton = store
}

/** `<dataDir>/library`, resolved through main-core's settings store. */
export function resolveLibraryRoot(): string {
  let base = ''
  try {
    // Static import — a runtime require cannot resolve inside the bundled main.
    base = getDataDir()
  } catch {
    /* main-core not ready (headless tests) */
  }
  if (!base) {
    base = process.env['DOLA_DATA_DIR'] ?? path.join(process.cwd(), '.dola-data')
  }
  return path.join(base, 'library')
}

export type { ImportOutcome }

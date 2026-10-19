// ---------------------------------------------------------------------------
// Dola Toolkit — library IPC.
//
// Registers every `library:*` channel from the frozen channel contract and
// lazily initialises the store so main-core does not have to call us first.
// ---------------------------------------------------------------------------

import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  BookContent,
  BookRecord,
  CatalogBook,
  CatalogQuery,
  CatalogResult,
  ClassifyResult,
  FolderRecord,
  ImportOutcome,
  LibraryState
} from '../../shared/types'
import { IPC } from '../../shared/channels'
import { getSettings } from '../store'
import { getLibraryStore, type LibraryStore } from '../library/store'
import { importPaths, importBuffer } from '../library/import'
import { DIALOG_FILTERS } from '../library/scan'
import { coverDataUrl, saveCover } from '../library/cover'
import { classifyLibrary, initLibrary, readBookContent } from '../library'
import { searchCatalog, downloadCatalogBook } from '../library/catalog'

let initialised = false
let registered = false

async function ready(): Promise<LibraryStore> {
  const store = getLibraryStore()
  if (!initialised) {
    initLibrary()
    await store.load().catch(() => undefined)
    initialised = true
  }
  return store
}

/** IPC-safe error payload: every handler returns JSON, never throws. */
function fail(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) }
}

async function readStore(): Promise<LibraryStore> {
  return ready()
}

/** Resolve the import mode from main-core settings (defaults to managed). */
function importMode(): 'managed' | 'reference' {
  try {
    const mode = getSettings().library?.importMode
    return mode === 'reference' ? 'reference' : 'managed'
  } catch {
    return 'managed'
  }
}

export function registerLibraryIpc(): void {
  // Electron throws on a duplicate ipcMain.handle — stay idempotent.
  if (registered) return
  registered = true
  initLibrary()

  /* ---------------------------------------------------------------- */
  /* state / import                                                    */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(IPC.libraryState, async (): Promise<LibraryState> => {
    try {
      const store = await readStore()
      return await store.state()
    } catch (err) {
      return { books: [], folders: [], rootDir: '', importing: null, ...fail(err) } as LibraryState
    }
  })

  ipcMain.handle(IPC.libraryImport, async (): Promise<ImportOutcome | { error: string }> => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: '导入书籍',
            properties: ['openFile', 'multiSelections'],
            filters: DIALOG_FILTERS
          })
        : await dialog.showOpenDialog({
            title: '导入书籍',
            properties: ['openFile', 'multiSelections'],
            filters: DIALOG_FILTERS
          })
      if (result.canceled || !result.filePaths.length) return { added: [], skipped: [] }
      const store = await readStore()
      const outcome = await importPaths(store, result.filePaths, { importMode: importMode() })
      await store.emit()
      return { added: outcome.added, skipped: outcome.skipped }
    } catch (err) {
      return { added: [], skipped: [], ...fail(err) }
    }
  })

  ipcMain.handle(
    IPC.libraryImportPaths,
    async (_e, paths: unknown): Promise<ImportOutcome | { error: string }> => {
      try {
        const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
        if (!list.length) return { added: [], skipped: [] }
        const store = await readStore()
        const outcome = await importPaths(store, list, { importMode: importMode() })
        await store.emit()
        return { added: outcome.added, skipped: outcome.skipped }
      } catch (err) {
        return { added: [], skipped: [], ...fail(err) }
      }
    }
  )

  /* ---------------------------------------------------------------- */
  /* books                                                             */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(IPC.libraryRemoveBooks, async (_e, ids: unknown): Promise<LibraryState> => {
    try {
      const store = await readStore()
      const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      return await store.removeBooks(list)
    } catch (err) {
      return { books: [], folders: [], rootDir: '', importing: null, ...fail(err) } as LibraryState
    }
  })

  ipcMain.handle(
    IPC.libraryUpdateBook,
    async (_e, id: unknown, patch: unknown): Promise<BookRecord | { error: string }> => {
      try {
        const store = await readStore()
        if (typeof id !== 'string') return { error: '无效的书籍 ID' }
        const book = await store.updateBook(id, sanitizeBookPatch(patch))
        if (!book) return { error: '书籍不存在' }
        return book
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IPC.librarySearch, async (_e, query: unknown): Promise<BookRecord[] | { error: string }> => {
    try {
      const store = await readStore()
      return await store.search(typeof query === 'string' ? query : '')
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  /* ---------------------------------------------------------------- */
  /* content / cover                                                   */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(IPC.libraryContent, async (_e, id: unknown): Promise<BookContent | { error: string }> => {
    try {
      const store = await readStore()
      if (typeof id !== 'string') return { error: '无效的书籍 ID' }
      const book = await store.get(id)
      if (!book) return { error: '书籍不存在' }
      return await readBookContent(book)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.libraryCover, async (_e, id: unknown): Promise<string | null> => {
    try {
      const store = await readStore()
      if (typeof id !== 'string') return null
      const book = await store.get(id)
      if (!book || !book.coverPath) return null
      return await coverDataUrl(book.coverPath, 320)
    } catch {
      return null
    }
  })

  /* ---------------------------------------------------------------- */
  /* folders                                                           */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(
    IPC.libraryCreateFolder,
    async (_e, name: unknown, parentId: unknown): Promise<FolderRecord | { error: string }> => {
      try {
        const store = await readStore()
        if (typeof name !== 'string' || !name.trim()) return { error: '文件夹名称不能为空' }
        return await store.createFolder(name, typeof parentId === 'string' ? parentId : null)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.libraryUpdateFolder,
    async (_e, id: unknown, patch: unknown): Promise<FolderRecord | { error: string }> => {
      try {
        const store = await readStore()
        if (typeof id !== 'string') return { error: '无效的文件夹 ID' }
        const record = sanitizeFolderPatch(patch)
        const folder = await store.updateFolder(id, record)
        if (!folder) return { error: '文件夹不存在' }
        return folder
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IPC.libraryDeleteFolder, async (_e, id: unknown): Promise<LibraryState> => {
    try {
      const store = await readStore()
      if (typeof id !== 'string') return await store.state()
      return await store.deleteFolder(id)
    } catch (err) {
      return { books: [], folders: [], rootDir: '', importing: null, ...fail(err) } as LibraryState
    }
  })

  /* ---------------------------------------------------------------- */
  /* AI classification                                                  */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(IPC.libraryClassify, async (): Promise<ClassifyResult> => {
    try {
      const store = await readStore()
      initialised = true
      return await classifyLibrary(store)
    } catch (err) {
      return {
        createdFolders: [],
        assignments: [],
        model: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  /* ---------------------------------------------------------------- */
  /* catalog                                                           */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(IPC.libraryCatalog, async (_e, query: unknown): Promise<CatalogResult> => {
    try {
      const q = sanitizeCatalogQuery(query)
      return await searchCatalog(q)
    } catch (err) {
      return { books: [], total: 0, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    IPC.libraryCatalogDownload,
    async (_e, book: unknown): Promise<BookRecord | { error: string }> => {
      try {
        const store = await readStore()
        const target = sanitizeCatalogBook(book)
        if (!target) return { error: '无效的书籍数据' }
        const download = await downloadCatalogBook(target)
        if (!download.ok) return { error: download.error ?? '下载失败' }
        const imported = await importBuffer(store, download.data, download.fileName, {
          importMode: importMode()
        })
        if (!imported.record) {
          return { error: imported.skipped?.reason ?? '下载的文件无法识别' }
        }
        // Prefer the catalog metadata when the file itself has none.
        const record = imported.record
        if (!record.coverPath && target.cover) {
          try {
            const res = await fetch(target.cover, { signal: AbortSignal.timeout(15_000) })
            if (res.ok) {
              const data = Buffer.from(await res.arrayBuffer())
              if (data.length > 512) {
                const saved = await saveCover(data, store.coversDir, record.title, 'jpg')
                if (saved) {
                  await store.updateBook(record.id, { coverPath: saved.path, coverColor: saved.color })
                }
              }
            }
          } catch {
            /* cover is optional */
          }
        }
        const fresh = (await store.get(record.id)) ?? record
        await store.emit()
        return fresh
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

/* ------------------------------------------------------------------ */
/* payload sanitisation                                               */
/* ------------------------------------------------------------------ */

function sanitizeBookPatch(raw: unknown): Parameters<LibraryStore['updateBook']>[1] {
  const patch: Parameters<LibraryStore['updateBook']>[1] = {}
  if (!raw || typeof raw !== 'object') return patch
  const input = raw as Record<string, unknown>
  if (typeof input['title'] === 'string') patch.title = input['title']
  if (typeof input['author'] === 'string') patch.author = input['author']
  if (typeof input['progress'] === 'number') patch.progress = input['progress']
  if (input['lastLocation'] === null || typeof input['lastLocation'] === 'string') {
    patch.lastLocation = input['lastLocation'] as string | null
  }
  if (typeof input['favorite'] === 'boolean') patch.favorite = input['favorite']
  if (Array.isArray(input['tags'])) {
    patch.tags = input['tags'].filter((t): t is string => typeof t === 'string')
  }
  if (Array.isArray(input['folderIds'])) {
    patch.folderIds = input['folderIds'].filter((t): t is string => typeof t === 'string')
  }
  if (typeof input['series'] === 'string') patch.series = input['series']
  if (input['seriesKey'] === null || typeof input['seriesKey'] === 'string') {
    patch.seriesKey = input['seriesKey'] as string | null
  }
  if (typeof input['description'] === 'string') patch.description = input['description']
  if (typeof input['language'] === 'string') patch.language = input['language']
  if (typeof input['publisher'] === 'string') patch.publisher = input['publisher']
  return patch
}

function sanitizeFolderPatch(raw: unknown): Parameters<LibraryStore['updateFolder']>[1] {
  const patch: Parameters<LibraryStore['updateFolder']>[1] = {}
  if (!raw || typeof raw !== 'object') return patch
  const input = raw as Record<string, unknown>
  if (typeof input['name'] === 'string') patch.name = input['name']
  if (input['parentId'] === null || typeof input['parentId'] === 'string') {
    patch.parentId = input['parentId'] as string | null
  }
  if (input['kind'] === 'manual' || input['kind'] === 'series' || input['kind'] === 'smart') {
    patch.kind = input['kind']
  }
  if (input['color'] === null || typeof input['color'] === 'string') {
    patch.color = input['color'] as string | null
  }
  if (typeof input['order'] === 'number') patch.order = input['order']
  if (typeof input['prompt'] === 'string') patch.prompt = input['prompt']
  return patch
}

function sanitizeCatalogQuery(raw: unknown): CatalogQuery {
  const input = (raw ?? {}) as Record<string, unknown>
  const source = input['source']
  const valid: CatalogBook['source'] =
    source === 'openlibrary' || source === 'standardebooks' ? source : 'gutendex'
  const page = Number(input['page'])
  return {
    source: valid,
    query: typeof input['query'] === 'string' ? input['query'] : '',
    page: Number.isFinite(page) && page > 0 ? Math.min(50, Math.floor(page)) : 1
  }
}

function sanitizeCatalogBook(raw: unknown): CatalogBook | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  if (typeof input['title'] !== 'string' || !input['title'].trim()) return null
  const formats = Array.isArray(input['formats'])
    ? input['formats']
        .filter((f): f is { mime: string; url: string } => {
          if (!f || typeof f !== 'object') return false
          const rec = f as Record<string, unknown>
          return typeof rec['mime'] === 'string' && typeof rec['url'] === 'string'
        })
        .map((f) => ({ mime: f.mime, url: f.url }))
    : []
  const source = input['source']
  return {
    source:
      source === 'openlibrary' || source === 'standardebooks' || source === 'gutendex'
        ? source
        : 'gutendex',
    id: typeof input['id'] === 'string' ? input['id'] : `catalog:${Date.now()}`,
    title: input['title'],
    author: typeof input['author'] === 'string' ? input['author'] : '',
    language: typeof input['language'] === 'string' ? input['language'] : '',
    cover: typeof input['cover'] === 'string' ? input['cover'] : null,
    formats,
    downloadUrl: typeof input['downloadUrl'] === 'string' ? input['downloadUrl'] : null,
    downloads: typeof input['downloads'] === 'number' ? input['downloads'] : 0
  }
}

export { importMode }


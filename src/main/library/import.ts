// ---------------------------------------------------------------------------
// Dola Toolkit — import pipeline.
//
// `importPaths` is the Electron-facing entry point (it broadcasts progress and
// mutates the library store). The heavy lifting lives in `importFile`, which is
// pure Node + injectable image ops, so tests can run the whole pipeline
// headlessly.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BookFormat, BookRecord, ImportOutcome } from '../../shared/types'
import { coverColorFromTitle, detectFormat, ensureDir, fileExists, formatBytes, safeFileName, titleFromFileName } from './scan'
import { extractMetadata, type ExtractedMeta } from './metadata'
import { saveCover } from './cover'
import type { LibraryStore } from './store'

export interface ImportOptions {
  /** absolute target directory for covers */
  coversDir: string
  /** absolute target directory for managed copies */
  booksDir: string
  /** managed = copy into booksDir; reference = keep the original path */
  importMode: 'managed' | 'reference'
  /** progress callback, called for each finished file */
  onProgress?: (done: number, total: number, current: string) => void
}

export interface ImportedFile {
  record: BookRecord | null
  skipped: { path: string; reason: string } | null
}

/** Human readable reason used when a file cannot be imported. */
export function skipReason(filePath: string, err?: unknown): string {
  if (err instanceof Error && err.message) return `${path.basename(filePath)}：${err.message}`
  return `${path.basename(filePath)}：无法识别的格式`
}

/** Guess a title from the file when metadata extraction found nothing useful. */
function fallbackTitle(meta: ExtractedMeta, filePath: string): string {
  const title = meta.title?.trim()
  if (title && title.length > 1) return title
  return titleFromFileName(filePath)
}

/**
 * Import one file. Returns `{ record }` on success or `{ skipped }` on failure;
 * never throws so a bad file cannot abort a batch.
 */
export async function importFile(filePath: string, options: ImportOptions): Promise<ImportedFile> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      return { record: null, skipped: { path: filePath, reason: '不是文件' } }
    }
    if (stat.size === 0) {
      return { record: null, skipped: { path: filePath, reason: '文件为空' } }
    }
    if (stat.size > 512 * 1024 * 1024) {
      return { record: null, skipped: { path: filePath, reason: '文件超过 512 MB' } }
    }

    const format: BookFormat = detectFormat(filePath)
    if (format === 'unknown') {
      return { record: null, skipped: { path: filePath, reason: `不支持的格式（${path.extname(filePath) || '无扩展名'}）` } }
    }

    const meta = await extractMetadata({ filePath, format, size: stat.size })

    // 1. Managed copy (or remember the source path in reference mode).
    const id = randomUUID()
    let storedPath = filePath
    let sourcePath: string | null = null
    if (options.importMode === 'managed') {
      await ensureDir(options.booksDir)
      const ext = path.extname(filePath).toLowerCase() || `.${format}`
      const baseName = path.basename(filePath, path.extname(filePath))
      storedPath = await uniqueManagedPath(options.booksDir, baseName, ext)
      await fs.copyFile(filePath, storedPath)
      sourcePath = filePath
    } else {
      sourcePath = filePath
    }

    // 2. Cover image.
    let coverPath: string | null = null
    let coverColor: string | null = null
    if (meta.cover && meta.cover.data.length) {
      const saved = await saveCover(
        meta.cover.data,
        options.coversDir,
        fallbackTitle(meta, filePath),
        meta.cover.ext
      )
      if (saved) {
        coverPath = saved.path
        coverColor = saved.color
      }
    }
    const title = fallbackTitle(meta, filePath)
    if (!coverColor) coverColor = coverColorFromTitle(`${title}${meta.author}`)

    const now = Date.now()
    const record: BookRecord = {
      id,
      title,
      author: meta.author.trim(),
      format,
      filePath: storedPath,
      size: stat.size,
      addedAt: now,
      updatedAt: now,
      coverPath,
      coverColor,
      description: meta.description.trim(),
      language: meta.language.trim(),
      publisher: meta.publisher.trim(),
      series: meta.series.trim(),
      progress: 0,
      lastLocation: null,
      folderIds: [],
      seriesKey: null,
      favorite: false,
      tags: [],
      sourcePath
    }
    return { record, skipped: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      record: null,
      skipped: { path: filePath, reason: `${path.basename(filePath)}：${message}` }
    }
  }
}

async function uniqueManagedPath(booksDir: string, base: string, ext: string): Promise<string> {
  const safe = safeFileName(base)
  let candidate = path.join(booksDir, `${safe}${ext}`)
  if (!(await fileExists(candidate))) return candidate
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(booksDir, `${safe}-${i}${ext}`)
    if (!(await fileExists(candidate))) return candidate
  }
  return path.join(booksDir, `${safe}-${Date.now()}${ext}`)
}

/* ------------------------------------------------------------------ */
/* Batch import bound to the library store                             */
/* ------------------------------------------------------------------ */

export interface BatchResult extends ImportOutcome {
  /** files that existed already, for a friendlier toast */
  duplicates: number
}

/**
 * Import a list of paths into the library. Progress is reported both through
 * the callback and (in Electron) the `library:progress` broadcast.
 */
export async function importPaths(
  store: LibraryStore,
  paths: string[],
  opts: { importMode?: 'managed' | 'reference' } = {}
): Promise<BatchResult> {
  const outcome: BatchResult = { added: [], skipped: [], duplicates: 0 }
  const unique = Array.from(new Set(paths.filter(Boolean)))
  if (!unique.length) return outcome

  const importMode = opts.importMode ?? 'managed'
  const options: ImportOptions = {
    coversDir: store.coversDir,
    booksDir: store.booksDir,
    importMode
  }
  store.setImporting({ total: unique.length, done: 0, current: path.basename(unique[0]) })

  for (let i = 0; i < unique.length; i++) {
    const filePath = unique[i]
    const current = path.basename(filePath)
    options.onProgress?.(i, unique.length, current)
    try {
      // Skip files already in the library (same managed or source path) so we
      // neither duplicate the row nor copy the bytes again.
      const existing = await store.findByPath(filePath)
      if (existing) {
        outcome.duplicates++
        store.setImporting({ total: unique.length, done: i + 1, current })
        continue
      }
      const result = await importFile(filePath, options)
      if (result.record) {
        const added = await store.addBooks([result.record])
        outcome.added.push(...added)
      } else if (result.skipped) {
        outcome.skipped.push(result.skipped)
      }
    } catch (err) {
      outcome.skipped.push({ path: filePath, reason: path.basename(filePath) + '：' + (err instanceof Error ? err.message : String(err)) })
    }
    store.setImporting({ total: unique.length, done: i + 1, current })
  }
  store.setImporting(null)
  return outcome
}

/**
 * Import a downloaded buffer (catalog). Writes to a temp file inside the
 * library, then runs the normal pipeline and removes the temp file.
 */
export async function importBuffer(
  store: LibraryStore,
  data: Buffer,
  fileName: string,
  opts: { importMode?: 'managed' | 'reference' } = {}
): Promise<ImportedFile> {
  const safeName = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim() || `download-${Date.now()}.epub`
  // Unique *directory* keeps the real file name intact, so the managed copy and
  // the derived title are not polluted by a timestamp prefix.
  const tmpDir = path.join(store.root, 'tmp', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await ensureDir(tmpDir)
  const tmpPath = path.join(tmpDir, safeName)
  try {
    await fs.writeFile(tmpPath, data)
    const result = await importFile(tmpPath, {
      coversDir: store.coversDir,
      booksDir: store.booksDir,
      importMode: opts.importMode ?? 'managed'
    })
    if (result.record) {
      await store.addBooks([result.record])
      store.emit().catch(() => undefined)
    }
    return result
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function describeImport(outcome: ImportOutcome): string {
  const parts: string[] = []
  if (outcome.added.length) parts.push(`导入 ${outcome.added.length} 本`)
  if (outcome.skipped.length) parts.push(`跳过 ${outcome.skipped.length} 个`)
  return parts.join('，') || '未导入任何文件'
}

export { formatBytes }

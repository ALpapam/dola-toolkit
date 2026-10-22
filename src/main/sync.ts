// ---------------------------------------------------------------------------
// Dola Toolkit — WebDAV sync service.
//
// Two-way, last-write-wins, never destructive locally. Credentials come from
// `settings.sync` (main-core's store); results are reported through
// `SyncStatus` and `sync:changed` broadcasts.
// ---------------------------------------------------------------------------

import type { BookRecord, FolderRecord, SyncStatus, WebDavSettings } from '../shared/types'
import { IPC } from '../shared/channels'
import { APP_VERSION } from '../shared/version'
import { getLibraryStore, broadcast, type LibraryStore } from './library/store'
import { getSettings, patchSettings } from './store'

const PROBE_TIMEOUT_MS = 10_000
const SYNC_TIMEOUT_MS = 60_000
const REMOTE_SETTINGS = 'dola-settings.json'
const REMOTE_LIBRARY = 'dola-library.json'

interface ResolvedSync {
  enabled: boolean
  url: string
  username: string
  password: string
  remoteDir: string
  lastSyncAt: string | null
  autoSync: boolean
  scope: WebDavSettings['scope']
}

export interface RemoteLibraryFile {
  schema: 1
  exportedAt: string
  books: BookRecord[]
  folders: FolderRecord[]
}

let running = false
let lastResult: { ok: boolean; message: string; at: number } | null = null

function readSyncConfig(): ResolvedSync {
  const fallback: ResolvedSync = {
    enabled: false,
    url: '',
    username: '',
    password: '',
    remoteDir: '',
    lastSyncAt: null,
    autoSync: false,
    scope: 'both'
  }
  try {
    // Static import — a runtime require cannot resolve inside the bundled main.
    const sync = getSettings().sync ?? {}
    return {
      enabled: sync.enabled ?? false,
      url: typeof sync.url === 'string' ? sync.url.trim() : '',
      username: typeof sync.username === 'string' ? sync.username : '',
      password: typeof sync.password === 'string' ? sync.password : '',
      remoteDir: typeof sync.remoteDir === 'string' ? sync.remoteDir.trim() : '',
      lastSyncAt: typeof sync.lastSyncAt === 'string' ? sync.lastSyncAt : null,
      autoSync: sync.autoSync ?? false,
      scope: sync.scope === 'settings' || sync.scope === 'library' ? sync.scope : 'both'
    }
  } catch {
    return fallback
  }
}

function authHeader(cfg: ResolvedSync): Record<string, string> {
  if (!cfg.username && !cfg.password) return {}
  const token = Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** Normalise a WebDAV base URL (must end with `/`). */
export function baseUrl(cfg: ResolvedSync): string {
  let url = cfg.url.trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.endsWith('/') ? url : `${url}/`
}

/** Full remote URL for a file inside the configured remote directory. */
export function remoteUrl(cfg: ResolvedSync, fileName: string): string {
  const base = baseUrl(cfg)
  if (!base) return ''
  const dir = cfg.remoteDir.replace(/^\/+|\/+$/g, '')
  return dir ? `${base}${encodeURI(dir)}/${encodeURI(fileName)}` : `${base}${encodeURI(fileName)}`
}

/** Directory URL (no trailing file). */
function remoteDirUrl(cfg: ResolvedSync): string {
  const base = baseUrl(cfg)
  if (!base) return ''
  const dir = cfg.remoteDir.replace(/^\/+|\/+$/g, '')
  return dir ? `${base}${encodeURI(dir)}/` : base
}

async function dav(
  url: string,
  method: string,
  cfg: ResolvedSync,
  opts: { body?: string; timeoutMs?: number; contentType?: string } = {}
): Promise<{ status: number; ok: boolean; text: string; headers: Headers; error?: string }> {
  try {
    const headers: Record<string, string> = {
      ...authHeader(cfg),
      'User-Agent': `Dola Toolkit/${APP_VERSION} (WebDAV sync)`
    }
    if (opts.contentType) headers['Content-Type'] = opts.contentType
    const res = await fetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_TIMEOUT_MS)
    })
    const text = res.status === 204 || res.status === 201 || res.status === 200 ? await res.text().catch(() => '') : ''
    return { status: res.status, ok: res.ok, text, headers: res.headers }
  } catch (err) {
    const name = (err as { name?: string }).name
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? '连接超时'
        : err instanceof Error
          ? err.message
          : String(err)
    return { status: 0, ok: false, text: '', headers: new Headers(), error: message }
  }
}

/** Validate the stored configuration without touching any data. */
export async function testSync(): Promise<{ ok: boolean; message: string }> {
  const cfg = readSyncConfig()
  if (!cfg.url) return { ok: false, message: '未填写 WebDAV 地址' }
  if (!cfg.enabled) return { ok: false, message: 'WebDAV 同步未启用' }
  const url = remoteDirUrl(cfg)
  // OPTIONS is cheap and widely supported; fall back to PROPFIND depth 0.
  let res = await dav(url, 'OPTIONS', cfg, { timeoutMs: PROBE_TIMEOUT_MS })
  if (res.status === 405 || res.status === 501 || res.status === 0) {
    res = await dav(url, 'PROPFIND', cfg, {
      timeoutMs: PROBE_TIMEOUT_MS,
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      contentType: 'application/xml; charset=utf-8'
    })
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `认证失败（HTTP ${res.status}），请检查用户名和密码` }
  }
  if (res.status === 404) {
    return { ok: false, message: '目录不存在（HTTP 404），同步时会自动创建' }
  }
  if (res.status >= 500) {
    return { ok: false, message: `服务器错误（HTTP ${res.status}）` }
  }
  if (!res.ok && res.status !== 404) {
    return { ok: false, message: `连接失败：${res.error ?? `HTTP ${res.status}`}` }
  }
  return { ok: true, message: `连接成功（HTTP ${res.status}）` }
}

/** Ensure the remote directory exists (MKCOL, ignores 405 “already exists”). */
async function ensureRemoteDir(cfg: ResolvedSync): Promise<boolean> {
  const dir = cfg.remoteDir.replace(/^\/+|\/+$/g, '')
  if (!dir) return true
  const segments = dir.split('/').filter(Boolean)
  let current = baseUrl(cfg)
  for (const segment of segments) {
    current = `${current}${encodeURI(segment)}/`
    const res = await dav(current, 'MKCOL', cfg, { timeoutMs: PROBE_TIMEOUT_MS })
    // 201 created, 405 already exists, 301/302 redirect — all acceptable.
    if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 302) {
      if (res.status === 401 || res.status === 403) return false
    }
  }
  return true
}

function parseRemoteTime(value: string | null): number {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

/** Download + merge the remote library (remote newer wins per book id). */
async function mergeRemoteLibrary(
  store: LibraryStore,
  cfg: ResolvedSync
): Promise<{ ok: boolean; message: string }> {
  const url = remoteUrl(cfg, REMOTE_LIBRARY)
  const res = await dav(url, 'GET', cfg)
  if (res.status === 404) return { ok: true, message: '远端暂无书库数据' }
  if (!res.ok) {
    return { ok: false, message: `下载远端书库失败：${res.error ?? `HTTP ${res.status}`}` }
  }
  let remote: Partial<RemoteLibraryFile> | null = null
  try {
    remote = JSON.parse(res.text) as Partial<RemoteLibraryFile>
  } catch {
    return { ok: false, message: '远端书库文件无法解析' }
  }
  const books = Array.isArray(remote?.books) ? remote.books : []
  const folders = Array.isArray(remote?.folders) ? remote.folders : []
  const mergedBooks = await store.mergeBooks(books)
  const mergedFolders = await store.mergeFolders(folders)
  return {
    ok: true,
    message: mergedBooks || mergedFolders ? `已合并 ${mergedBooks} 本书、${mergedFolders} 个文件夹` : '远端数据无需合并'
  }
}

/** Compare remote Last-Modified with our last sync before downloading. */
async function remoteIsNewer(cfg: ResolvedSync, fileName: string, since: number): Promise<boolean> {
  const res = await dav(remoteUrl(cfg, fileName), 'HEAD', cfg, { timeoutMs: PROBE_TIMEOUT_MS })
  if (!res.ok) return true
  const stamp = parseRemoteTime(res.headers.get('last-modified'))
  if (!stamp) return true
  return stamp > since
}

function buildLibraryExport(store: LibraryStore): RemoteLibraryFile {
  return {
    schema: 1,
    exportedAt: new Date().toISOString(),
    books: store.cachedBooks(),
    folders: store.cachedFolders()
  }
}

/** Full two-way sync. Never throws. */
export async function runSync(): Promise<SyncStatus> {
  if (running) return statusSync()
  const cfg = readSyncConfig()
  if (!cfg.url) return finish({ ok: false, message: '未填写 WebDAV 地址' })
  if (!cfg.enabled) return finish({ ok: false, message: 'WebDAV 同步未启用' })

  running = true
  broadcastStatus()
  let outcome: { ok: boolean; message: string }
  try {
    outcome = await performSync(cfg)
  } catch (err) {
    outcome = { ok: false, message: `同步异常：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    running = false
  }
  return finish(outcome)
}

/** The actual DAV conversation; returns an outcome instead of a status. */
async function performSync(cfg: ResolvedSync): Promise<{ ok: boolean; message: string }> {
  const store = getLibraryStore()
  await store.load()
  const dirOk = await ensureRemoteDir(cfg)
  if (!dirOk) return { ok: false, message: '无法创建远端目录（请检查权限）' }

  const since = parseRemoteTime(cfg.lastSyncAt)
  const messages: string[] = []

  if (cfg.scope === 'library' || cfg.scope === 'both') {
    if (await remoteIsNewer(cfg, REMOTE_LIBRARY, since)) {
      const merged = await mergeRemoteLibrary(store, cfg)
      messages.push(merged.message)
      if (!merged.ok) return { ok: false, message: merged.message }
    }
    const payload = JSON.stringify(buildLibraryExport(store))
    const put = await dav(remoteUrl(cfg, REMOTE_LIBRARY), 'PUT', cfg, {
      body: payload,
      contentType: 'application/json; charset=utf-8'
    })
    if (!put.ok) return { ok: false, message: `上传书库失败：${put.error ?? `HTTP ${put.status}`}` }
    messages.push('书库已上传')
  }

  if (cfg.scope === 'settings' || cfg.scope === 'both') {
    const settingsJson = readSettingsJson()
    if (settingsJson) {
      const put = await dav(remoteUrl(cfg, REMOTE_SETTINGS), 'PUT', cfg, {
        body: settingsJson,
        contentType: 'application/json; charset=utf-8'
      })
      if (!put.ok) return { ok: false, message: `上传设置失败：${put.error ?? `HTTP ${put.status}`}` }
      messages.push('设置已上传')
    }
  }

  patchLastSyncAt(new Date().toISOString())
  return { ok: true, message: messages.join('，') || '同步完成' }
}

function readSettingsJson(): string | null {
  try {
    const settings = getSettings()
    return settings ? JSON.stringify(settings) : null
  } catch {
    return null
  }
}

function patchLastSyncAt(at: string): void {
  try {
    patchSettings({ sync: { lastSyncAt: at } })
  } catch {
    /* settings store unavailable */
  }
}

function finish(result: { ok: boolean; message: string }): SyncStatus {
  lastResult = { ok: result.ok, message: result.message, at: Date.now() }
  broadcastStatus()
  return statusSync()
}

export function statusSync(): SyncStatus {
  const cfg = readSyncConfig()
  return {
    enabled: cfg.enabled,
    configured: Boolean(cfg.url && cfg.username),
    lastSyncAt: cfg.lastSyncAt,
    running,
    lastResult
  }
}

function broadcastStatus(): void {
  try {
    broadcast(IPC.syncChanged, statusSync())
  } catch {
    /* not in Electron */
  }
}

/** Auto-sync hook: only runs when enabled + autoSync + a URL is configured. */
export async function maybeAutoSync(): Promise<void> {
  const cfg = readSyncConfig()
  if (!cfg.enabled || !cfg.autoSync || !cfg.url) return
  await runSync()
}

export const syncService = {
  status: (): SyncStatus => statusSync(),
  run: (): Promise<SyncStatus> => runSync(),
  test: (): Promise<{ ok: boolean; message: string }> => testSync()
}

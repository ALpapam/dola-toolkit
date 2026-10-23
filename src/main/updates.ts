// ---------------------------------------------------------------------------
// Dola Toolkit — update checks
//
// Two kinds of update:
//   · the app itself (a new installer on GitHub Releases)
//   · the proxy cores (Xray / sing-box / Mihomo), which ship separately
//
// Network access is centralised here so the download-channel setting can pick
// between the authoritative GitHub API (newest, sometimes unreachable or slow in
// mainland China) and a mirror (jsDelivr for metadata, gh-proxy for the files —
// fast, but published a little later).
// ---------------------------------------------------------------------------

import { app, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { httpsGet } from './net'
import { APP_VERSION } from '@shared/version'
import type { AppUpdateInfo, CoreUpdateInfo, CoreId, DownloadChannel } from '@shared/types'
import { getSettings } from './store'
import { coreRoots, findCore, invalidateCoreVersion, runCoreVersion } from './proxy/binary'

const REPOS: Record<CoreId, { owner: string; repo: string; label: string; asset: RegExp; exe: string }> = {
  xray: {
    owner: 'XTLS',
    repo: 'Xray-core',
    label: 'Xray',
    asset: /^Xray-windows-64\.zip$/i,
    exe: 'xray.exe'
  },
  singbox: {
    owner: 'SagerNet',
    repo: 'sing-box',
    label: 'sing-box',
    asset: /sing-box-[\d.]+-windows-amd64\.zip$/i,
    exe: 'sing-box.exe'
  },
  mihomo: {
    owner: 'MetaCubeX',
    repo: 'mihomo',
    label: 'Mihomo',
    asset: /^mihomo-windows-amd64(-compatible)?(-v[\d.]+)?\.zip$/i,
    exe: 'mihomo.exe'
  }
}

const APP_REPO = { owner: 'ALpapam', repo: 'dola-toolkit' }
const MIRROR_PREFIX = 'https://gh-proxy.com/'
const JSDELIVR = 'https://cdn.jsdelivr.net/gh'
const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/gh'

// ---------------------------------------------------------------------------
// network helpers
// ---------------------------------------------------------------------------

function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, timeoutMs, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        if (body.length < 4_000_000) body += c
      })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T
}

/** Downloads to a file, reporting progress as a fraction of Content-Length. */
function downloadTo(
  url: string,
  target: string,
  onProgress: (got: number, total: number) => void,
  timeoutMs = 600_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const go = (current: string, redirects: number): void => {
      if (redirects > 6) return reject(new Error('重定向过多'))
      const req = httpsGet(current, timeoutMs, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          go(new URL(res.headers.location, current).toString(), redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0)
        let got = 0
        const out = createWriteStream(target)
        res.on('data', (c: Buffer) => {
          got += c.length
          onProgress(got, total)
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
        out.on('error', reject)
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    }
    go(url, 0)
  })
}

/** Wraps a release-asset URL for the mirror channel. */
function viaChannel(url: string, channel: DownloadChannel): string {
  return channel === 'mirror' ? `${MIRROR_PREFIX}${url}` : url
}

/**
 * Scratch directory for downloads and extracted archives.
 *
 * Under userData rather than %TEMP%: the packaged app can run with a profile that
 * is not allowed to create directories in the temp folder (mkdir → EPERM), and a
 * stable location also makes a half-finished download easy to find and clean.
 */
function updateWorkDir(kind: string): string {
  const dir = join(app.getPath('userData'), 'updates', kind)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// version comparison
// ---------------------------------------------------------------------------

/** Loose numeric comparison: "26.3.27" vs "v1.8.24" vs "1.19.32-alpha". */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((p) => parseInt(p.replace(/\D/g, ''), 10))
      .filter((n) => !Number.isNaN(n))
  const pa = norm(a)
  const pb = norm(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// ---------------------------------------------------------------------------
// GitHub release metadata
// ---------------------------------------------------------------------------

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  assets?: { name: string; browser_download_url: string; size: number }[]
}

async function githubRelease(owner: string, repo: string): Promise<GithubRelease | null> {
  try {
    return await fetchJson<GithubRelease>(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
  } catch {
    return null
  }
}

/**
 * Latest STABLE tag from jsDelivr — the mirror's metadata source.
 *
 * jsDelivr lists every tag in creation order, including sing-box's
 * `1.15.0-alpha.N` builds, so prereleases are filtered out: pushing a user onto
 * an alpha core just because they picked the mirror would be wrong.
 */
async function jsdelivrTag(owner: string, repo: string): Promise<string | null> {
  try {
    const data = await fetchJson<{ tags?: { latest?: string }; versions?: { version: string }[] }>(
      `${JSDELIVR_DATA}/${owner}/${repo}`
    )
    const tag = data.tags?.latest
    if (tag && !isPrerelease(tag)) return tag
    for (const v of data.versions ?? []) {
      if (!isPrerelease(v.version)) return v.version.startsWith('v') ? v.version : `v${v.version}`
    }
    // nothing stable published yet — fall back to the newest whatever it is
    const first = data.versions?.[0]?.version
    return first ? (first.startsWith('v') ? first : `v${first}`) : null
  } catch {
    return null
  }
}

function isPrerelease(tag: string): boolean {
  return /(alpha|beta|rc\d*|dev|preview|nightly)/i.test(tag)
}

/** Release-asset URL patterns, used when the GitHub API is unreachable. */
function fallbackAssetUrl(engine: CoreId, version: string): string | null {
  const v = version.replace(/^v/, '')
  switch (engine) {
    case 'xray':
      return `https://github.com/XTLS/Xray-core/releases/download/v${v}/Xray-windows-64.zip`
    case 'singbox':
      return `https://github.com/SagerNet/sing-box/releases/download/v${v}/sing-box-${v}-windows-amd64.zip`
    case 'mihomo':
      return `https://github.com/MetaCubeX/mihomo/releases/download/v${v}/mihomo-windows-amd64-v${v}.zip`
    default:
      return null
  }
}

function currentChannel(): DownloadChannel {
  try {
    return getSettings().general.downloadChannel === 'mirror' ? 'mirror' : 'github'
  } catch {
    return 'github'
  }
}

// ---------------------------------------------------------------------------
// app update
// ---------------------------------------------------------------------------

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const channel = currentChannel()
  const base: AppUpdateInfo = {
    current: APP_VERSION,
    latest: null,
    updateAvailable: false,
    channel,
    downloadUrl: null,
    notes: null,
    publishedAt: null,
    error: null
  }

  /*
   * Release metadata always comes from the API, even on the mirror channel: it is
   * the only source listing the real asset names. Only the DOWNLOAD goes through
   * the mirror. If the API is unreachable, the version falls back to jsDelivr and
   * the asset URL is rebuilt from the known naming scheme.
   */
  const rel = await githubRelease(APP_REPO.owner, APP_REPO.repo)
  let latest = rel?.tag_name ? rel.tag_name.replace(/^v/, '') : null

  if (!latest) {
    const tag = await jsdelivrTag(APP_REPO.owner, APP_REPO.repo)
    if (tag) latest = tag.replace(/^v/, '')
  }

  if (!latest) return { ...base, error: '无法获取最新版本信息，请检查网络或稍后重试' }

  const asset =
    rel?.assets?.find((a) => /-setup\.exe$/i.test(a.name)) ??
    rel?.assets?.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name))

  // installers are named after the numeric version, while the tag carries the
  // channel suffix (v0.0.2-beta → DolaToolkit-0.0.2-setup.exe)
  const numeric = latest.split('-')[0]
  const assetUrl =
    asset?.browser_download_url ??
    `https://github.com/${APP_REPO.owner}/${APP_REPO.repo}/releases/download/v${latest}/DolaToolkit-${numeric}-setup.exe`

  return {
    current: APP_VERSION,
    latest,
    updateAvailable: compareVersions(latest, APP_VERSION) > 0,
    channel,
    downloadUrl: assetUrl,
    notes: rel?.body ?? null,
    publishedAt: rel?.published_at ?? null,
    error: null
  }
}

let downloadCancel: { url: string } | null = null

/** Downloads the installer next to the temp dir and returns its path. */
export async function downloadAppUpdate(onProgress: (percent: number) => void): Promise<string> {
  const info = await checkAppUpdate()
  if (!info.downloadUrl) throw new Error(info.error ?? '没有可用的下载地址')
  const dir = updateWorkDir('installers')
  mkdirSync(dir, { recursive: true })
  const name = `DolaToolkit-${info.latest}-setup.exe`
  const target = join(dir, name)
  await unlink(target).catch(() => undefined)
  downloadCancel = { url: info.downloadUrl }
  try {
    await downloadTo(viaChannel(info.downloadUrl, info.channel), target, (got, total) => {
      if (total > 0) onProgress(Math.min(100, Math.round((got / total) * 100)))
    })
  } finally {
    downloadCancel = null
  }
  return target
}

/**
 * Runs the downloaded installer elevated and quits.
 *
 * `Start-Process -Verb RunAs` triggers the UAC prompt; the installer itself also
 * requests elevation, so users see a single confirmation. The app must release its
 * files first, hence the quit.
 */
export async function installAppUpdate(installerPath: string): Promise<void> {
  if (!existsSync(installerPath)) throw new Error('安装包不存在，请重新下载')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -Verb RunAs`
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`启动安装程序失败 (${code})`))))
  })
  // mark that the next start should confirm the update
  try {
    writeFileSync(join(app.getPath('userData'), 'update-pending.json'), JSON.stringify({ at: Date.now(), path: installerPath }))
  } catch {
    /* non-fatal */
  }
  app.quit()
}

// ---------------------------------------------------------------------------
// core updates
// ---------------------------------------------------------------------------

const ENGINE_KEYS: CoreId[] = ['xray', 'singbox', 'mihomo']

export async function checkCoreUpdates(): Promise<CoreUpdateInfo[]> {
  const channel = currentChannel()
  const out: CoreUpdateInfo[] = []
  for (const engine of ENGINE_KEYS) {
    const meta = REPOS[engine]
    const local = await currentCoreVersion(engine)
    let latest: string | null = null
    let asset: { name: string; url: string } | null = null

    const rel = channel === 'github' ? await githubRelease(meta.owner, meta.repo) : null
    if (rel?.tag_name) {
      latest = rel.tag_name.replace(/^v/, '')
      const hit = rel.assets?.find((a) => meta.asset.test(a.name))
      if (hit) asset = { name: hit.name, url: hit.browser_download_url }
    }
    if (!latest) {
      const tag = await jsdelivrTag(meta.owner, meta.repo)
      if (tag) latest = tag.replace(/^v/, '')
    }
    if (!latest) {
      const fallback = await githubRelease(meta.owner, meta.repo)
      if (fallback?.tag_name) {
        latest = fallback.tag_name.replace(/^v/, '')
        const hit = fallback.assets?.find((a) => meta.asset.test(a.name))
        if (hit) asset = { name: hit.name, url: hit.browser_download_url }
      }
    }
    // the mirror path never touches the API, so build the asset URL from the
    // known release naming when the API did not provide one
    if (!asset?.url && latest) {
      const url = fallbackAssetUrl(engine, latest)
      if (url) asset = { name: `${meta.label}-${latest}.zip`, url }
    }

    const missing = local === null
    out.push({
      engine,
      label: meta.label,
      local,
      latest,
      missing,
      updateAvailable: Boolean(latest) && (missing || compareVersions(latest!, local!) > 0),
      channel,
      assetUrl: asset?.url ?? null,
      error: latest ? null : '无法获取版本信息'
    })
  }
  return out
}

async function currentCoreVersion(engine: CoreId): Promise<string | null> {
  if (!findCore(engine)) return null
  try {
    const v = await runCoreVersion(engine)
    return v ?? null
  } catch {
    return null
  }
}

/** Downloads a core release archive, extracts the exe and replaces the local one. */
export async function updateCore(engine: CoreId, onProgress: (percent: number) => void): Promise<string> {
  const meta = REPOS[engine]
  const info = (await checkCoreUpdates()).find((c) => c.engine === engine)
  if (!info) throw new Error('未找到内核信息')
  if (!info.assetUrl) throw new Error(info.error ?? '没有可用的下载地址')

  const dir = updateWorkDir('core')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'core.zip')
  await downloadTo(viaChannel(info.assetUrl, info.channel), archive, (got, total) => {
    if (total > 0) onProgress(Math.min(100, Math.round((got / total) * 100)))
  })

  // Windows ships bsdtar, which reads zip archives.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', archive, '-C', dir], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败 (${code})`))))
  })

  // Mihomo ships its binary under a versioned name
  // (mihomo-windows-amd64-v1.19.33.exe) while the others use the plain name.
  const exe =
    findFile(dir, meta.exe) ??
    findFileMatch(dir, new RegExp(`^${engine}.*\.exe$`, 'i')) ??
    findFileMatch(dir, /^mihomo.*\.exe$/i)
  if (!exe) throw new Error(`压缩包中没有可用的内核可执行文件`)

  const targetRoot = coreRoots()[0]
  const targetDir = join(targetRoot, engine === 'singbox' ? 'singbox' : engine)
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, meta.exe)
  // a running core locks its exe; callers stop the core before this point
  if (existsSync(target)) renameSync(target, `${target}.bak`)
  renameSync(exe, target)
  // the version probe caches its result, so the UI would otherwise keep showing
  // the old version until the app restarted
  invalidateCoreVersion(engine)
  rmSync(dir, { recursive: true, force: true })
  return target
}

/** Case-insensitive search for any file whose name matches the pattern. */
function findFileMatch(dir: string, pattern: RegExp): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFileMatch(full, pattern)
      if (nested) return nested
    } else if (pattern.test(entry.name)) {
      return full
    }
  }
  return null
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, name)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// post-install confirmation
// ---------------------------------------------------------------------------

/** Returns the version we were updating TO when the previous session installed an update. */
export function takePendingUpdate(): { from: string } | null {
  const file = join(app.getPath('userData'), 'update-pending.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: number }
    rmSync(file, { force: true })
    return { from: APP_VERSION }
  } catch {
    return null
  }
}

export function openReleasesPage(): void {
  void shell.openExternal(`https://github.com/${APP_REPO.owner}/${APP_REPO.repo}/releases`)
}

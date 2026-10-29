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
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { httpsGet } from './net'
import { APP_VERSION } from '@shared/version'
import type { AppUpdateInfo, CoreUpdateInfo, CoreId, DownloadChannel } from '@shared/types'
import { getSettings } from './store'
import { logUpdate } from './updateLog'
import { proxyCall } from './modService'


const APP_REPO = { owner: 'ALpapam', repo: 'dola-toolkit' }
const MIRROR_PREFIX = 'https://gh-proxy.com/'
const JSDELIVR = 'https://cdn.jsdelivr.net/gh'
const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/gh'

// ---------------------------------------------------------------------------
// network helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const proxyPort = await activeProxyPort()
  return new Promise((resolve, reject) => {
    // metadata goes through the proxy too: the GitHub API is just as unreachable
    // as the release downloads when the direct route is bad
    const req = httpsGet(
      url,
      timeoutMs,
      (res) => {
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
      },
      { proxyPort }
    )
    req.on('error', reject)
    req.end()
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T
}

/**
 * Downloads to a file and refuses to report success on a short read.
 *
 * The length check is the important part: this is what silently broke in-app
 * updates. A truncated transfer (proxy drop, idle-timeout race, server closing the
 * connection early) left a partial .exe on disk, the download was reported as
 * successful, and running that half file did nothing at all — the app restarted and
 * stayed on the old version with no error anywhere.
 */
export function stageDownloadTo(url: string, target: string, onProgress: (got: number, total: number) => void): Promise<void> {
  return downloadTo(url, target, onProgress)
}

function downloadTo(
  url: string,
  target: string,
  onProgress: (got: number, total: number) => void,
  timeoutMs = 600_000
): Promise<void> {
  /*
   * The port is read once, before the transfer starts.
   *
   * It now lives in a mod service, so it is an async call — and doing it per redirect
   * would mean awaiting inside the request callback that decides where to redirect.
   * Reading it once is also what the user sees: the route is fixed for the whole file.
   */
  return (async () => {
    const proxyPort = await activeProxyPort()
    return new Promise<void>((resolve, reject) => {
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
        let settled = false
        const out = createWriteStream(target)
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(idle)
          out.destroy()
          rmSync(target, { force: true })
          reject(err)
        }
        /*
         * A stalled connection must not hang the update forever. GitHub release
         * downloads can sit at 0 bytes for minutes on a bad route, so the transfer
         * is aborted when nothing arrives for a while — the UI can then fall back to
         * the mirror or report a clear error.
         */
        let idle = setTimeout(() => {
          req.destroy(new Error('下载停滞，请尝试切换为国内镜像站'))
        }, 60_000)
        res.on('data', (c: Buffer) => {
          clearTimeout(idle)
          idle = setTimeout(() => req.destroy(new Error('下载停滞，请尝试切换为国内镜像站')), 60_000)
          got += c.length
          onProgress(got, total)
        })
        res.on('error', (e) => fail(e))
        res.pipe(out)
        out.on('error', (e) => fail(e))
        out.on('finish', () => {
          clearTimeout(idle)
          out.close(() => {
            if (settled) return
            // a short body means the file is unusable; say so instead of pretending
            if (total > 0 && got < total) {
              settled = true
              rmSync(target, { force: true })
              reject(new Error(`下载不完整（${Math.round((got / total) * 100)}%），请重试或切换下载渠道`))
              return
            }
            settled = true
            resolve()
          })
        })
      }, { proxyPort })
      req.on('error', (e) => reject(e))
      req.end()
    }
    go(url, 0)
    })
  })()
}

/** Wraps a release-asset URL for the mirror channel. */
export function viaUpdateChannel(url: string, channel: 'github' | 'mirror'): string {
  return viaChannel(url, channel)
}

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
  assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[]
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
/** Tags carrying a channel suffix are never offered as an app update. */
function isPrerelease(tag: string): boolean {
  return /-(alpha|beta|rc|dev)/i.test(tag)
}

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


/** Release-asset URL patterns, used when the GitHub API is unreachable. */

/**
 * Local mixed-port to tunnel update traffic through, or null for a direct route.
 *
 * Only used while a core is actually running: without it the tunnel target does not
 * exist, and falling back to direct keeps updates working when the proxy is off.
 */
async function activeProxyPort(): Promise<number | null> {
  try {
    const port = await proxyCall<number | null>('active-port')
    return typeof port === 'number' && port > 0 ? port : null
  } catch {
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

/** Downloads the installer and verifies it before returning its path. */
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
 * The installer's own manifest requests administrator rights, so handing it to the
 * shell raises the UAC prompt — no PowerShell wrapper is needed (spawning
 * `powershell.exe` by bare name failed with ENOENT here, because the main process can
 * run with a PATH that has no System32).
 *
 * The file is validated first. A truncated download used to be treated as success:
 * running the partial .exe did nothing, the app restarted on the old version, and
 * nothing anywhere said why. Anything that is not plausibly a full installer is
 * rejected here with an actionable message.
 */
/**
 * Launches the installer with elevation and reports whether it really started.
 *
 * This is the part that kept silently failing. `shell.openPath` cannot tell us if the
 * user dismissed UAC, and `spawn()` cannot elevate at all — CreateProcess refuses an
 * exe whose manifest asks for administrator with ERROR_ELEVATION_REQUIRED, and the
 * error was swallowed while the app quit anyway. That is why "安装并重启" closed the
 * window and nothing else happened.
 *
 * PowerShell is invoked by absolute path (a bare `powershell.exe` fails with ENOENT
 * when the main process PATH has no System32) and its exit code is the signal:
 * `Start-Process -Verb RunAs` returns non-zero when the UAC prompt is declined.
 */
function launchInstallerElevated(installerPath: string): Promise<void> {
  const powershell = join(
    process.env['SystemRoot'] || 'C:\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -Verb RunAs`
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      reject(new Error(`无法启动安装程序：${e.message}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else reject(new Error('安装程序未启动（多半是取消了管理员授权），请重试'))
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      resolve()
    }, 20000).unref?.()
  })
}

export async function installAppUpdate(installerPath: string, targetVersion?: string): Promise<void> {
  if (!existsSync(installerPath)) throw new Error('安装包不存在，请重新下载')

  const stat = statSync(installerPath)
  // every build so far is ~125 MB; anything far below that is a broken transfer
  const MIN_PLAUSIBLE = 60 * 1024 * 1024
  if (stat.size < MIN_PLAUSIBLE) {
    rmSync(installerPath, { force: true })
    throw new Error(
      `安装包不完整（${Math.round(stat.size / 1048576)} MB，正常约 127 MB），已删除。请重新下载更新`
    )
  }
  // an MZ header is the minimum proof that this is an executable at all
  const head = Buffer.alloc(2)
  const fd = openSync(installerPath, 'r')
  try {
    readSync(fd, head, 0, 2, 0)
  } finally {
    closeSync(fd)
  }
  if (head[0] !== 0x4d || head[1] !== 0x5a) {
    rmSync(installerPath, { force: true })
    throw new Error('下载的文件不是有效的安装程序，已删除。请重新下载更新')
  }

  /*
   * Launch FIRST, mark second, quit last.
   *
   * The marker drives the "did the update land?" check on the next start, so writing
   * it before a launch that then fails produced a bogus「更新未生效」report. And
   * quitting unconditionally turned a failed launch into "the window just closed".
   */
  try {
    await launchInstallerElevated(installerPath)
  } catch (e) {
    const message = e instanceof Error ? e.message : '无法启动安装程序'
    logUpdate('app.install.launch-fail', message)
    throw new Error(message)
  }

  try {
    writeFileSync(
      join(app.getPath('userData'), 'update-pending.json'),
      JSON.stringify({
        at: Date.now(),
        path: installerPath,
        // remembered so the next launch can verify the update actually landed
        from: APP_VERSION,
        to: targetVersion ?? APP_VERSION
      })
    )
  } catch {
    /* non-fatal: only used to confirm the update on the next start */
  }
  logUpdate('app.install.launched', `${installerPath} → ${targetVersion ?? '?'}`)

  // the installer needs this process gone to replace its files
  setTimeout(() => app.quit(), 1500)
}

// ---------------------------------------------------------------------------
// core updates
// ---------------------------------------------------------------------------

const ENGINE_KEYS: CoreId[] = ['xray', 'singbox', 'mihomo']



/** Downloads a core release archive, extracts the exe and replaces the local one. */
/**
 * Downloads a core release and swaps the binary in.
 *
 * Order matters and used to be wrong: the caller stopped the running proxy BEFORE
 * calling this, so the download went out over the direct route — slow, and with the
 * proxy button greyed out the whole time even though the tunnel was healthy. The
 * archive is fetched first (through the proxy when it is up), and only the swap
 * needs the exe released, so `prepare` is called right before the replace.
 */

/** Case-insensitive search for any file whose name matches the pattern. */


// ---------------------------------------------------------------------------
// post-install confirmation
// ---------------------------------------------------------------------------

/** Returns the version we were updating TO when the previous session installed an update. */
/**
 * Reports what the pending marker says about the last update attempt.
 *
 * It records the version we were running when the installer was launched, so the
 * next session can compare against the version actually loaded now. Returning that
 * pair is what lets the UI tell「已更新到最新版本」apart from「安装没成功，仍是旧版本」
 * — the previous version unconditionally claimed success, which is how a broken
 * installer download went unnoticed.
 */
export function takePendingUpdate(): { from: string; to: string; updated: boolean } | null {
  const file = join(app.getPath('userData'), 'update-pending.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: number; from?: string; to?: string }
    rmSync(file, { force: true })
    const from = typeof raw.from === 'string' ? raw.from : '0.0.0'
    const to = typeof raw.to === 'string' ? raw.to : from
    return { from, to, updated: compareVersions(APP_VERSION, from) > 0 }
  } catch {
    rmSync(file, { force: true })
    return null
  }
}

export function openReleasesPage(): void {
  void shell.openExternal(`https://github.com/${APP_REPO.owner}/${APP_REPO.repo}/releases`)
}

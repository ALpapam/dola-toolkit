// ---------------------------------------------------------------------------
// Dola Toolkit — staged core updates
//
// Replacing a core binary in place caused every reported problem: the proxy had to
// be stopped mid-download, a swap could fail while the app was still running, and a
// corrupt archive was only discovered at the very end (after the user had already
// been told to restart).
//
// The flow is now split in two:
//
//   download → verify SHA-256 → extract into a staging folder → report "ready"
//   [restart, now or later]    → apply staged binaries → proxy comes back
//
// Nothing is written over a live core, and an unverified download never reaches the
// "restart to finish" state at all.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { CoreId } from '@shared/types'
import { coresDirFor, findCore, invalidateCoreVersion } from './proxy/binary'

export interface StagedCore {
  engine: CoreId
  label: string
  version: string
  /** absolute path of the verified binary waiting to be applied */
  stagedPath: string
  /** where it will land on the next launch */
  targetPath: string
  size: number
  sha256: string
  at: number
}

const LABELS: Record<CoreId, string> = { xray: 'Xray', singbox: 'sing-box', mihomo: 'Mihomo' }

/** File name each engine's binary must end up with (what findCore looks for). */
function targetExeName(engine: CoreId): string {
  return engine === 'singbox' ? 'sing-box.exe' : `${engine}.exe`
}

/** Folder name each engine lives in under the cores root. */
function engineFolder(engine: CoreId): string {
  return engine === 'singbox' ? 'singbox' : engine
}

function stagingRoot(): string {
  const dir = join(app.getPath('userData'), 'updates', 'staged')
  mkdirSync(dir, { recursive: true })
  return dir
}

function manifestPath(): string {
  return join(app.getPath('userData'), 'updates', 'staged-cores.json')
}

export function writeStagedCores(list: StagedCore[]): void {
  try {
    if (list.length === 0) {
      rmSync(manifestPath(), { force: true })
      return
    }
    writeFileSync(manifestPath(), JSON.stringify(list, null, 2))
  } catch {
    /* non-fatal: staging simply looks empty next time */
  }
}

/** Reads the staged manifest, dropping entries whose file vanished. */
export function readStagedCores(): StagedCore[] {
  let parsed: StagedCore[]
  try {
    const raw = readFileSync(manifestPath(), 'utf8')
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    parsed = value as StagedCore[]
  } catch {
    return []
  }
  const alive = parsed.filter((s) => s && typeof s.stagedPath === 'string' && existsSync(s.stagedPath))
  if (alive.length !== parsed.length) writeStagedCores(alive)
  return alive
}

export function hasStagedCores(): boolean {
  return readStagedCores().length > 0
}

/** SHA-256 of a file as lowercase hex. */
function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
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

/**
 * Where this engine's binary actually lives.
 *
 * `coreRoots()[0]` is NOT the right answer: in a packaged build it is
 * `<resources>/cores`, which usually does not exist, while the real cores sit in a
 * `cores` folder next to the executable. Writing there created a second tree that
 * `findCore` then preferred, so the "update" never replaced the binary that was
 * actually being launched. The existing binary's own location wins when there is one,
 * and `coresDirFor` (which probes the same list findCore uses) decides otherwise.
 */
/**
 * Moves a file, falling back to copy+delete across volumes.
 *
 * The staging folder lives in userData (usually on C:) while the cores can sit on
 * another drive — `renameSync` throws EXDEV there, and that failure used to abort the
 * apply silently, leaving the old core in place after a "successful" update.
 */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function resolveTargetPath(engine: CoreId): string {
  // replace exactly the binary that is being launched
  const existing = findCore(engine)
  if (existing) return existing
  return join(coresDirFor(engine), engineFolder(engine), targetExeName(engine))
}

/** True when the file starts with an MZ header, i.e. it is a Windows executable. */
async function hasMzHeader(path: string): Promise<boolean> {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(2)
    await handle.read(buf, 0, 2, 0)
    return buf[0] === 0x4d && buf[1] === 0x5a
  } finally {
    await handle.close()
  }
}

export interface StageOptions {
  engine: CoreId
  version: string
  /** archive URL to fetch (already mirror-wrapped by the caller) */
  url: string
  /** SHA-256 from the release digest; null when the API did not publish one */
  expectedSha256: string | null
  onProgress: (percent: number) => void
  download: (url: string, target: string, onProgress: (got: number, total: number) => void) => Promise<void>
}

/**
 * Downloads, verifies and extracts one core release into the staging folder.
 *
 * Every rejection happens before anything is staged, so the caller can always turn a
 * throw into「请重新下载」rather than a restart prompt.
 */
export async function stageCore(options: StageOptions): Promise<StagedCore> {
  const { engine, version, url, expectedSha256, onProgress, download } = options
  const dir = join(stagingRoot(), `${engine}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'core.zip')

  const cleanup = (): void => rmSync(dir, { recursive: true, force: true })

  try {
    await download(url, archive, (got, total) => {
      if (total > 0) onProgress(Math.min(100, Math.round((got / total) * 100)))
    })

    if (!existsSync(archive)) throw new Error('下载未完成，请重新下载')
    const size = statSync(archive).size
    if (size < 1024 * 1024) {
      throw new Error(`下载的文件过小（${Math.round(size / 1024)} KB），可能已损坏，请重新下载`)
    }

    // the release digest describes the ARCHIVE, not the binary inside it
    const archiveSha = await fileSha256(archive)
    if (expectedSha256 && archiveSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `SHA-256 校验失败，下载的文件已损坏。\n期望：${expectedSha256.slice(0, 16)}…\n实际：${archiveSha.slice(0, 16)}…\n请重新下载`
      )
    }

    const tarExe = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarExe, ['-xf', archive, '-C', dir], { windowsHide: true, stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败 (${code})`))))
    })

    // Mihomo ships a versioned file name, the others a plain one.
    const exe =
      findFile(dir, targetExeName(engine)) ??
      findFileMatch(dir, new RegExp(`^${engine}.*\\.exe$`, 'i')) ??
      findFileMatch(dir, /^mihomo.*\.exe$/i)
    if (!exe) throw new Error('压缩包里没有内核实执行文件，请重新下载')

    if (!(await hasMzHeader(exe))) {
      throw new Error('解压出的文件不是有效的可执行文件，请重新下载')
    }

    const stagedPath = join(dir, targetExeName(engine))
    if (stagedPath !== exe) {
      rmSync(stagedPath, { force: true })
      renameSync(exe, stagedPath)
    }
    rmSync(archive, { force: true })

    /*
     * The recorded hash is the EXE's, not the archive's.
     *
     * applyStagedCores() re-hashes the staged binary before replacing anything; storing
     * the archive digest here made that check fail every time ("暂存文件校验失败"),
     * which is why a staged core was never applied.
     */
    const exeSha = await fileSha256(stagedPath)
    const record: StagedCore = {
      engine,
      label: LABELS[engine],
      version,
      stagedPath,
      targetPath: resolveTargetPath(engine),
      size: statSync(stagedPath).size,
      sha256: exeSha,
      at: Date.now()
    }

    // one entry per engine: an older attempt must not override a newer download
    const list = readStagedCores().filter((s) => s.engine !== engine)
    list.push(record)
    writeStagedCores(list)
    return record
  } catch (e) {
    cleanup()
    throw e
  }
}

/**
 * Applies every staged binary and clears the manifest.
 *
 * Runs on launch before any core can start, so no file is locked. The staged file is
 * re-hashed here too: it sat on disk between sessions and anything that damaged it
 * must be caught before it replaces a working core.
 */
export async function applyStagedCores(): Promise<{
  applied: string[]
  failed: { engine: string; error: string }[]
}> {
  const list = readStagedCores()
  const applied: string[] = []
  const failed: { engine: string; error: string }[] = []
  if (list.length === 0) return { applied, failed }
  /** entries that could not be applied but are still worth retrying */
  const keep: StagedCore[] = []

  for (const item of list) {
    try {
      if (!existsSync(item.stagedPath)) throw new Error('暂存文件已丢失')
      const actual = await fileSha256(item.stagedPath)
      if (actual.toLowerCase() !== item.sha256.toLowerCase()) throw new Error('暂存文件校验失败')
      if (!(await hasMzHeader(item.stagedPath))) throw new Error('暂存文件不是有效的可执行文件')

      /*
       * Re-resolve the destination here rather than trusting the path recorded at
       * stage time. The install layout can differ between sessions (portable vs
       * installed, a moved folder), and a stale path silently "succeeded" while
       * writing somewhere findCore never looks — the version then never changed.
       */
      const target = resolveTargetPath(item.engine)
      mkdirSync(join(target, '..'), { recursive: true })
      rmSync(`${target}.bak`, { force: true })
      // back-up through the same cross-volume helper: a plain rename can be refused
      // with EPERM here (observed), which aborted the apply
      if (existsSync(target)) moveFile(target, `${target}.bak`)
      moveFile(item.stagedPath, target)
      invalidateCoreVersion(item.engine)
      applied.push(`${item.label} ${item.version}`)
      rmSync(join(item.stagedPath, '..'), { recursive: true, force: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : '替换失败'
      failed.push({ engine: item.label, error: message })
      // a binary that failed its own checksum cannot be retried; a locked/failed
      // swap can, so keep the entry and let the next launch try again
      if (existsSync(item.stagedPath) && !/校验失败|不是有效/.test(message)) keep.push(item)
    }
  }

  writeStagedCores(keep)
  return { applied, failed }
}

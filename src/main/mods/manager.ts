// ---------------------------------------------------------------------------
// Dola Toolkit — mod manager
//
// Installed mods live in `<userData>/mods/<id>/`. Importing a zip is:
//
//   copy to a temp dir → extract → look for dola-mod.json
//     ├─ missing/invalid → delete everything, report「这似乎不是Dola Toolkit的插件呢~」
//     └─ valid           → refresh the target folder → remember order/first-run state
//
// The version is compared on re-import so a newer package replaces an older one and
// an older one is refused, which is the "update by comparing version numbers" part.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logUpdate } from '../updateLog'
import { ModFormatError, readManifestAt, type ModInfo } from './manifest'

export interface ModRecord {
  /** manifest snapshot, so the rail can render without touching the disk */
  id: string
  name: string
  version: string
  description: string
  icon: string
  settingsIcon: string
  settingsName: string
  createdAt: string
  entry: string
  /** path (relative to userData) this tool wants backed up, if any */
  backupFile: string
  /** description of that backup, shown in 同步内容 */
  backupLabel: string
  /** epoch ms of installation */
  installedAt: number
  /** true until the first-run guide has been shown once */
  firstRun: boolean
  enabled: boolean
}

interface ModStateFile {
  mods: ModRecord[]
}

export function modsRoot(): string {
  const dir = join(app.getPath('userData'), 'mods')
  mkdirSync(dir, { recursive: true })
  return dir
}

function statePath(): string {
  return join(modsRoot(), 'mods.json')
}

function readState(): ModStateFile {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as ModStateFile
    if (!parsed || !Array.isArray(parsed.mods)) return { mods: [] }
    return parsed
  } catch {
    return { mods: [] }
  }
}

function writeState(state: ModStateFile): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch (e) {
    logUpdate('mod.state.write-fail', e instanceof Error ? e.message : String(e))
  }
}

/** Installed mods, in rail order. */
export function listMods(): ModRecord[] {
  const state = readState()
  // drop entries whose folder disappeared (manually deleted, failed uninstall)
  const alive = state.mods.filter((m) => existsSync(join(modsRoot(), m.id)))
  if (alive.length !== state.mods.length) writeState({ mods: alive })
  return alive
}

export function saveMods(mods: ModRecord[]): void {
  writeState({ mods })
}

/** Absolute folder of an installed mod. */
export function modDir(id: string): string {
  return join(modsRoot(), id)
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Extracts a zip with Windows' bundled bsdtar (absolute path, see other spawn sites). */
function extractZip(zip: string, dest: string): Promise<void> {
  const tarExe = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(tarExe, ['-xf', zip, '-C', dest], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败 (${code})`))))
  })
}

export interface ImportResult {
  ok: boolean
  /** the mod as installed, when ok */
  mod?: ModRecord
  /** true when the same id already existed and was replaced */
  upgraded?: boolean
  error?: string
}

/**
 * Installs a mod from a zip.
 *
 * Every failure path removes the extracted copy, so a rejected package leaves nothing
 * behind — including the temp folder it was unpacked into.
 */
export async function importModFromZip(zipPath: string): Promise<ImportResult> {
  if (!existsSync(zipPath)) return { ok: false, error: '找不到该文件' }
  if (!/\.zip$/i.test(zipPath)) return { ok: false, error: '只支持 .zip 格式的插件包' }

  const temp = join(modsRoot(), `.import-${randomUUID()}`)
  mkdirSync(temp, { recursive: true })
  const cleanup = (): void => rmSync(temp, { recursive: true, force: true })

  try {
    await extractZip(zipPath, temp)
  } catch (e) {
    cleanup()
    return { ok: false, error: `解压失败：${e instanceof Error ? e.message : '未知错误'}` }
  }

  let info: ModInfo | null = null
  try {
    info = readManifestAt(temp)
  } catch (e) {
    cleanup()
    const message = e instanceof ModFormatError ? e.message : '插件清单无法读取'
    logUpdate('mod.import.bad-manifest', message)
    return { ok: false, error: message }
  }

  if (!info) {
    cleanup()
    logUpdate('mod.import.not-a-mod', zipPath)
    // the exact wording the user asked for
    return { ok: false, error: '这似乎不是Dola Toolkit的插件呢~' }
  }

  const entryPath = join(info.dir, info.entry)
  if (!existsSync(entryPath)) {
    cleanup()
    logUpdate('mod.import.no-entry', `${info.id}: ${info.entry}`)
    return { ok: false, error: `插件缺少入口文件 ${info.entry}` }
  }

  const state = readState()
  const previous = state.mods.find((m) => m.id === info!.id)
  if (previous && compareVersions(info.version, previous.version) < 0) {
    cleanup()
    return {
      ok: false,
      error: `已安装的 ${previous.name} 版本更新（${previous.version} > ${info.version}），未覆盖`
    }
  }

  const target = modDir(info.id)
  try {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    // copy the manifest's folder, so a nested root becomes the mod root
    cpSync(info.dir, target, { recursive: true })
  } catch (e) {
    cleanup()
    return { ok: false, error: `写入插件目录失败：${e instanceof Error ? e.message : '未知错误'}` }
  }
  cleanup()

  const record: ModRecord = {
    id: info.id,
    name: info.name,
    version: info.version,
    description: info.description,
    icon: info.icon,
    settingsIcon: info.settingsIcon,
    settingsName: info.settingsName,
    createdAt: info.createdAt,
    entry: info.entry,
    backupFile: info.backupFile,
    backupLabel: info.backupLabel,
    installedAt: previous?.installedAt ?? Date.now(),
    // an upgrade keeps the "already introduced" state so the guide is not shown again
    firstRun: previous ? previous.firstRun && compareVersions(info.version, previous.version) === 0 : true,
    enabled: previous?.enabled ?? true
  }
  const next = state.mods.filter((m) => m.id !== info!.id)
  next.push(record)
  writeState({ mods: next })

  logUpdate('mod.import.ok', `${record.id} ${record.version}${previous ? ` (was ${previous.version})` : ''}`)
  return { ok: true, mod: record, upgraded: Boolean(previous) }
}

/** Removes an installed mod and its state entry. */
export function uninstallMod(id: string): { ok: boolean; error?: string } {
  const state = readState()
  if (!state.mods.some((m) => m.id === id)) return { ok: false, error: '插件未安装' }
  try {
    rmSync(modDir(id), { recursive: true, force: true })
  } catch (e) {
    return { ok: false, error: `删除失败：${e instanceof Error ? e.message : '未知错误'}` }
  }
  writeState({ mods: state.mods.filter((m) => m.id !== id) })
  logUpdate('mod.uninstall', id)
  return { ok: true }
}

/** Marks the first-run guide as seen. */
export function markModIntroduced(id: string): void {
  const state = readState()
  const mod = state.mods.find((m) => m.id === id)
  if (!mod || !mod.firstRun) return
  mod.firstRun = false
  writeState(state)
}

/** Persists a new rail order for mods (built-in tools keep their own order). */
export function setModOrder(ids: string[]): void {
  const state = readState()
  const byId = new Map(state.mods.map((m) => [m.id, m]))
  const ordered: ModRecord[] = []
  for (const id of ids) {
    const mod = byId.get(id)
    if (mod) {
      ordered.push(mod)
      byId.delete(id)
    }
  }
  // anything the caller did not mention keeps its place at the end
  for (const mod of byId.values()) ordered.push(mod)
  writeState({ mods: ordered })
}

/** Reads a mod's manifest from disk (used after a manual edit). */
export function readInstalledManifest(id: string): ModInfo | null {
  try {
    return readManifestAt(modDir(id))
  } catch {
    return null
  }
}

/** Size on disk, for the settings list. */
export function modSize(id: string): number {
  const dir = modDir(id)
  let total = 0
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    walk(dir)
  } catch {
    /* ignore */
  }
  return total
}

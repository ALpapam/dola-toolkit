// ---------------------------------------------------------------------------
// Dola Toolkit — plugin (mod) format
//
// A mod is a zip whose root (anywhere inside) holds `dola-mod.json`:
//
//   {
//     "id": "library",                    // stable id, also the folder name
//     "name": "书库",                      // sidebar label
//     "version": "1.0.0",                 // compared on later imports
//     "settingsName": "书库设置",          // heading used by the settings page
//     "createdAt": "2026-10-28T00:00:00Z", // authoring time, informational
//     "description": "…",                 // shown once, as a first-run guide
//     "icon": "library",                  // sidebar icon name
//     "settingsIcon": "settings",         // icon used inside the settings page
//     "entry": "index.js"                 // bundle that registers the mod
//   }
//
// The manifest is the only thing that decides "is this a Dola Toolkit mod", so a zip
// without it is rejected with a friendly message and deleted.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Name of the file that identifies a Dola Toolkit mod. */
export const MANIFEST_NAME = 'dola-mod.json'

export interface ModManifest {
  id: string
  name: string
  version: string
  settingsName: string
  createdAt: string
  description: string
  icon: string
  settingsIcon: string
  /** bundle file, relative to the manifest's folder */
  entry: string
}

export interface ModInfo extends ModManifest {
  /** absolute folder the mod was installed into */
  dir: string
}

export class ModFormatError extends Error {}

function asString(value: unknown, field: string, required = true): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!required) return ''
  throw new ModFormatError(`插件清单缺少字段：${field}`)
}

/**
 * Parses and validates a manifest.
 *
 * Everything the UI relies on is checked here so a malformed mod fails at import
 * time with a specific reason, instead of crashing the rail later.
 */
export function parseManifest(raw: string, dir: string): ModInfo {
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ModFormatError('插件清单不是一个对象')
    }
    data = parsed as Record<string, unknown>
  } catch (e) {
    if (e instanceof ModFormatError) throw e
    throw new ModFormatError('插件清单不是合法的 JSON')
  }

  const id = asString(data.id, 'id')
  // the id doubles as a folder name, so keep it filesystem-safe
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new ModFormatError('插件 id 只能包含字母、数字、点、下划线和短横线')
  }

  const version = asString(data.version, 'version')
  if (!/^\d+(\.\d+)*/.test(version)) {
    throw new ModFormatError('插件 version 必须是形如 1.0.0 的版本号')
  }

  const entry = asString(data.entry, 'entry', false) || 'index.js'

  return {
    id,
    name: asString(data.name, 'name'),
    version,
    settingsName: asString(data.settingsName, 'settingsName', false) || `${asString(data.name, 'name')}设置`,
    createdAt: asString(data.createdAt, 'createdAt', false) || new Date().toISOString(),
    description: asString(data.description, 'description', false),
    icon: asString(data.icon, 'icon', false) || 'extension',
    settingsIcon: asString(data.settingsIcon, 'settingsIcon', false) || 'settings',
    entry,
    dir
  }
}

/** Locates the manifest inside an extracted folder, allowing one nested root. */
export function findManifest(dir: string, depth = 0): { manifestPath: string; root: string } | null {
  const direct = join(dir, MANIFEST_NAME)
  if (existsSync(direct)) return { manifestPath: direct, root: dir }
  if (depth >= 2) return null
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null
  }
  for (const name of entries) {
    const found = findManifest(join(dir, name), depth + 1)
    if (found) return found
  }
  return null
}

/** Reads a manifest from an extracted folder, or null when this is not a mod. */
export function readManifestAt(dir: string): ModInfo | null {
  const found = findManifest(dir)
  if (!found) return null
  const raw = readFileSync(found.manifestPath, 'utf8')
  return parseManifest(raw, found.root)
}

// ---------------------------------------------------------------------------
// Dola Toolkit — proxy core binary resolution
// Dev:  <projectRoot>/cores  →  D:\桌面\server\tool
// Prod: <resourcesPath>/cores
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { CoreId, EngineCapability, NodeProtocol } from '@shared/types'

export const FALLBACK_TOOL_DIR = 'D:\\桌面\\server\\tool'

const EXE_NAMES: Record<CoreId, string[]> = {
  xray: ['xray.exe', 'xray'],
  singbox: ['sing-box.exe', 'sing-box'],
  mihomo: ['mihomo.exe', 'mihomo']
}

const SUBDIRS: Record<CoreId, string> = {
  xray: 'xray',
  singbox: 'singbox',
  mihomo: 'mihomo'
}

export const CORE_LABELS: Record<CoreId, string> = {
  xray: 'Xray',
  mihomo: 'Mihomo',
  singbox: 'sing-box'
}

const CAPABILITIES: Record<CoreId, NodeProtocol[]> = {
  xray: ['vmess', 'vless', 'trojan', 'shadowsocks', 'socks', 'http'],
  singbox: [
    'vmess',
    'vless',
    'trojan',
    'shadowsocks',
    'socks',
    'http',
    'hysteria2',
    'tuic',
    'anytls'
  ],
  mihomo: [
    'vmess',
    'vless',
    'trojan',
    'shadowsocks',
    'socks',
    'http',
    'hysteria2',
    'tuic',
    'anytls',
    'wireguard'
  ]
}

const BLURBS: Record<CoreId, string> = {
  xray: 'VLESS / VMess / REALITY — 兼容性最好，适合分流与伪装',
  singbox: 'sing-box 1.14 — 支持 Hysteria2 / TUIC / AnyTLS 等新协议',
  mihomo: 'Clash Meta 内核 — 协议最全，支持 WireGuard 与规则集'
}

const PROTOCOL_LABELS: Record<NodeProtocol, string> = {
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  shadowsocks: 'Shadowsocks',
  socks: 'SOCKS5',
  http: 'HTTP',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  anytls: 'AnyTLS',
  wireguard: 'WireGuard'
}

export function protocolLabel(p: NodeProtocol): string {
  return PROTOCOL_LABELS[p] ?? p
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

let cachedRoot: string | null = null

/** Candidate `cores` directories, most specific first. */
export function coreRoots(): string[] {
  const roots: string[] = []
  if (app.isPackaged) {
    roots.push(join(process.resourcesPath, 'cores'))

    // Portable exe: shipping ~200 MB of cores inside the archive would be
    // unpacked to a temp dir on every launch, so the build keeps them OUT and
    // the app looks for a `cores` folder next to the executable instead.
    try {
      const exeDir = dirname(app.getPath('exe'))
      roots.push(join(exeDir, 'cores'))
      roots.push(join(exeDir, '..', 'cores'))
      roots.push(join(exeDir, 'resources', 'cores'))
    } catch {
      /* app.getPath('exe') can fail in odd packaging modes */
    }
    // Last resort for this machine: the shared tool folder the user already
    // keeps the cores in.
    roots.push(FALLBACK_TOOL_DIR)
  } else {
    const appPath = safeAppPath()
    if (appPath) {
      roots.push(join(appPath, 'cores'))
      // electron-vite may run from out/main — also try the parent chain.
      roots.push(join(appPath, '..', 'cores'))
      roots.push(join(appPath, '..', '..', 'cores'))
    }
    roots.push(join(process.cwd(), 'cores'))
    // The Lead stages binaries here before they are copied into the project.
    roots.push(FALLBACK_TOOL_DIR)
  }
  return [...new Set(roots.map((r) => normalize(r)))]
}

function safeAppPath(): string | null {
  try {
    return app.getAppPath()
  } catch {
    return null
  }
}

function normalize(p: string): string {
  // do not resolve() — keeps paths readable in logs and works for missing dirs
  return p.replace(/[\\/]+$/, '')
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function dirHasEngine(dir: string, engine: CoreId): boolean {
  const sub = join(dir, SUBDIRS[engine])
  const names = EXE_NAMES[engine]
  for (const n of names) {
    if (isFile(join(sub, n))) return true
    if (isFile(join(dir, n))) return true
  }
  return false
}

/** Locate a `cores` dir that actually contains this engine (or fall back to the first). */
export function coresDirFor(engine: CoreId): string {
  const roots = coreRoots()
  for (const root of roots) {
    if (dirHasEngine(root, engine)) return root
  }
  if (cachedRoot) return cachedRoot
  return roots[0] ?? join(process.cwd(), 'cores')
}

/** Absolute exe path for an engine, or null when no binary can be found. */
export function findCore(engine: CoreId): string | null {
  const roots = coreRoots()
  const sub = SUBDIRS[engine]
  for (const root of roots) {
    for (const name of EXE_NAMES[engine]) {
      const nested = join(root, sub, name)
      if (isFile(nested)) return nested
      const flat = join(root, name)
      if (isFile(flat)) return flat
    }
  }
  return null
}

export interface GeoPaths {
  dir: string
  geoip: string | null
  geosite: string | null
}

/** Directory where geoip.dat / geosite.dat live (may not exist yet). */
export function geoDir(): string {
  const root = coresDirFor('xray')
  return join(root, 'geofiles')
}

export function findGeo(): GeoPaths {
  const roots = coreRoots()
  for (const root of roots) {
    for (const dir of [join(root, 'geofiles'), root]) {
      const geoip = join(dir, 'geoip.dat')
      const geosite = join(dir, 'geosite.dat')
      if (isFile(geoip) || isFile(geosite)) {
        return {
          dir,
          geoip: isFile(geoip) ? geoip : null,
          geosite: isFile(geosite) ? geosite : null
        }
      }
    }
  }
  // Nothing staged: prefer the writable project location for imports/downloads.
  return { dir: geoDir(), geoip: null, geosite: null }
}

export function geoFileInfo(file: string | null): { path: string; size: number; updatedAt: number | null } | null {
  if (!file || !existsSync(file)) return null
  try {
    const st = statSync(file)
    return { path: file, size: st.size, updatedAt: st.mtimeMs }
  } catch {
    return null
  }
}

/** Cores that actually have a binary on disk. */
export function availableEngines(): CoreId[] {
  return (Object.keys(EXE_NAMES) as CoreId[]).filter((e) => findCore(e) !== null)
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

const VERSION_ARGS: Record<CoreId, string[]> = {
  xray: ['--version'],
  singbox: ['version'],
  mihomo: ['-v']
}

const versionCache = new Map<CoreId, string | null>()

function extractVersion(engine: CoreId, raw: string): string | null {
  const patterns: Record<CoreId, RegExp[]> = {
    xray: [/Xray\s+([vV]?\d+(?:\.\d+)+)/i],
    singbox: [/sing-box\s+version\s+([vV]?\d+(?:\.\d+)+)/i, /version\s+([vV]?\d+(?:\.\d+)+)/i],
    mihomo: [/Mihomo\s+Meta\s+([vV]?\d+(?:\.\d+)+)/i, /([vV]?\d+(?:\.\d+)+)/]
  }
  for (const re of patterns[engine]) {
    const m = re.exec(raw)
    if (m?.[1]) return m[1].replace(/^v/i, '')
  }
  return null
}

/** Runs `<core> --version` once (3 s cap) and caches the parsed version string. */
export function runCoreVersion(engine: CoreId): Promise<string | null> {
  if (versionCache.has(engine)) return Promise.resolve(versionCache.get(engine) ?? null)
  const bin = findCore(engine)
  if (!bin) {
    versionCache.set(engine, null)
    return Promise.resolve(null)
  }
  return new Promise<string | null>((resolve) => {
    let settled = false
    const done = (v: string | null): void => {
      if (settled) return
      settled = true
      versionCache.set(engine, v)
      resolve(v)
    }
    try {
      const child = execFile(
        bin,
        VERSION_ARGS[engine],
        { windowsHide: true, timeout: 3000, encoding: 'utf8', maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          const raw = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
          // Some cores exit non-zero for version flags; trust the output first.
          const v = extractVersion(engine, raw)
          if (v) return done(v)
          if (err && !raw) return done(null)
          done(null)
        }
      )
      child.on('error', () => done(null))
      setTimeout(() => done(null), 3200).unref?.()
    } catch {
      done(null)
    }
  })
}

export async function versionOf(engine: CoreId): Promise<string | null> {
  return runCoreVersion(engine)
}

export async function listEngines(): Promise<EngineCapability[]> {
  const engines: CoreId[] = ['xray', 'singbox', 'mihomo']
  const out: EngineCapability[] = []
  for (const engine of engines) {
    const bin = findCore(engine)
    const version = bin ? await runCoreVersion(engine) : null
    out.push({
      engine,
      label: CORE_LABELS[engine],
      blurb: BLURBS[engine],
      protocols: CAPABILITIES[engine],
      version,
      available: bin !== null,
      binary: bin ?? ''
    })
  }
  return out
}

/** Forget cached versions (used after the Lead copies cores into place). */
export function clearBinaryCache(): void {
  versionCache.clear()
  cachedRoot = null
}

export function coreConfigDir(engine: CoreId, dataDir: string): string {
  return join(dataDir, 'proxy', engine)
}

export function parentOf(file: string): string {
  return dirname(file)
}

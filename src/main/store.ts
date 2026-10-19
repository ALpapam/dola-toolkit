// ---------------------------------------------------------------------------
// Dola Toolkit — settings + proxy persistence (main process)
// Atomic JSON writes, deep-merged defaults, debounced flush, change events.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreId, DeepPartial, ProxyNode, Settings, SettingsPatch } from '@shared/types'
import { DEFAULT_PRESET, presetById } from '@shared/presets'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  '你是 Dola Toolkit 内置的阅读助理，熟悉中文与英文书籍，擅长总结、答疑与人物关系梳理。',
  '请严格依据用户提供的书籍内容或上下文作答：可以概括、解释术语、梳理人物与线索，但不得编造书中不存在的情节或引文。',
  '如果信息不足，请直接说明缺什么，并给出可行的下一步。',
  '回答使用与用户提问相同的语言；默认简洁、分点、可读，避免冗长复述。'
].join('')

const SERIES_PROMPT = [
  '你是 Dola Toolkit 的书籍整理助手。下面会给出一个书单，每本书包含 id、书名、作者、简介等字段。',
  '请判断哪些书属于同一系列、同一作品的不同卷/不同版本/同一作者的同一套书，并把它们分组。',
  '只输出严格 JSON，不要输出任何解释文字或 Markdown 代码块，格式为：',
  '{"groups":[{"name":"系列名","bookIds":["书籍id1","书籍id2"]}]}',
  '同一系列的书必须使用同一个 name；不同系列分别建组；无法归入任何系列的独立书籍不要出现在结果中。'
].join('')

export const DEFAULT_SETTINGS: Settings = {
  schema: 1,
  appearance: {
    themeMode: 'system',
    // Presets are the default so the app looks good out of the box; wallpaper
    // Monet sampling stays available as an opt-in "跟随壁纸" source.
    monet: false,
    seedSource: 'custom',
    preset: DEFAULT_PRESET.id,
    customSeed: DEFAULT_PRESET.seed,
    contrast: 0,
    roundness: 16,
    reduceMotion: false
  },
  ai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: SYSTEM_PROMPT,
    seriesPrompt: SERIES_PROMPT,
    timeoutMs: 60000
  },
  sync: {
    enabled: false,
    url: '',
    username: '',
    password: '',
    remoteDir: '/DolaToolkit',
    lastSyncAt: null,
    autoSync: false,
    scope: 'both'
  },
  proxy: {
    defaultEngine: 'xray',
    mixedPort: 7897,
    allowLan: false,
    remoteDns: true,
    logLevel: 'info',
    autoStart: false,
    systemProxy: true,
    sniffing: true,
    ipv6: false,
    bypass: 'localhost;127.*;10.*;172.16.*;192.168.*;*.local',
    autoRestart: true
  },
  library: {
    defaultView: 'grid',
    spreadMode: 'auto',
    flipMode: 'both',
    aiAutoClassify: false,
    importMode: 'managed',
    defaultSort: 'added',
    coverWidth: 170
  },
  general: {
    language: 'zh',
    zoom: 1,
    closeToTray: false,
    launchAtLogin: false,
    checkUpdates: true
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let dataDir = ''
let logsDir = ''
let settings: Settings = clone(DEFAULT_SETTINGS)
let loaded = false
let flushTimer: NodeJS.Timeout | null = null
const settingsListeners = new Set<(s: Settings) => void>()
const proxyListeners = new Set<(p: ProxyStore) => void>()

export interface ProxyStore {
  nodes: ProxyNode[]
  selectedNodeId: string | null
  activeEngine: CoreId
  systemProxy: boolean
}

const DEFAULT_PROXY_STORE: ProxyStore = {
  nodes: [],
  selectedNodeId: null,
  activeEngine: 'xray',
  systemProxy: false
}

let proxyStore: ProxyStore = clone(DEFAULT_PROXY_STORE)

function settingsFile(): string {
  return join(dataDir, 'settings.json')
}
function proxyFile(): string {
  return join(dataDir, 'proxy.json')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge `patch` onto `base`; arrays and primitives replace wholesale. */
function deepMerge<T>(base: T, patch: unknown): T {
  // A missing/!object patch never replaces the base — this is what makes
  // "load a file that does not exist yet" and "reset without arguments" safe.
  if (patch === undefined || patch === null) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const cur = (base as Record<string, unknown>)[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out as T
}

function readJson(file: string): unknown {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return null
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    try {
      writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    } catch {
      /* disk full / permission — keep running with in-memory copy */
    }
  }
}

function emitSettings(): void {
  const snapshot = clone(settings)
  for (const cb of settingsListeners) {
    try {
      cb(snapshot)
    } catch {
      /* listener must not break persistence */
    }
  }
}

function emitProxy(): void {
  const snapshot = clone(proxyStore)
  for (const cb of proxyListeners) {
    try {
      cb(snapshot)
    } catch {
      /* ignore */
    }
  }
}

function scheduleSettingsFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    writeJsonAtomic(settingsFile(), settings)
  }, 250)
  flushTimer.unref?.()
}

export function flushStore(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dataDir) writeJsonAtomic(settingsFile(), settings)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initStore(dir: string): void {
  dataDir = dir
  logsDir = join(dir, 'logs')
  for (const d of [dataDir, logsDir, join(dir, 'proxy'), join(dir, 'library'), join(dir, 'covers')]) {
    try {
      mkdirSync(d, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  // Only a plain object is a valid settings document. Anything else (array,
  // string, number, corrupt JSON) falls back to defaults.
  const stored = readJson(settingsFile())
  const storedSettings = isPlainObject(stored) ? stored : null
  // Deep-merge so keys added by future versions never break existing files.
  settings = deepMerge(clone(DEFAULT_SETTINGS), storedSettings)
  settings.schema = 1
  normalizeSettings()

  const storedProxyRaw = readJson(proxyFile())
  const storedProxy = isPlainObject(storedProxyRaw) ? storedProxyRaw : null
  const mergedProxy = deepMerge(clone(DEFAULT_PROXY_STORE), storedProxy)
  proxyStore = {
    nodes: Array.isArray(mergedProxy.nodes)
      ? (mergedProxy.nodes.filter((n) => isPlainObject(n)) as ProxyNode[])
      : [],
    selectedNodeId:
      typeof mergedProxy.selectedNodeId === 'string' ? mergedProxy.selectedNodeId : null,
    activeEngine: isEngine(mergedProxy.activeEngine) ? mergedProxy.activeEngine : 'xray',
    systemProxy: mergedProxy.systemProxy === true
  }
  if (
    proxyStore.selectedNodeId &&
    !proxyStore.nodes.some((n) => n.id === proxyStore.selectedNodeId)
  ) {
    proxyStore.selectedNodeId = null
  }

  loaded = true
  // Persist the normalized/merged result once so the file self-heals.
  writeJsonAtomic(settingsFile(), settings)
  if (!existsSync(proxyFile())) writeJsonAtomic(proxyFile(), proxyStore)
}

function isEngine(v: unknown): v is CoreId {
  return v === 'xray' || v === 'mihomo' || v === 'singbox'
}

/** Clamp / coerce values that can arrive from a stale or hand-edited file. */
function normalizeSettings(): void {
  const a = settings.appearance
  const modes = ['system', 'light', 'dark']
  if (!modes.includes(a.themeMode)) a.themeMode = 'system'
  const seeds = ['auto', 'wallpaper', 'accent', 'custom']
  if (!seeds.includes(a.seedSource)) a.seedSource = 'auto'
  // A preset drives the palette: resolve it into customSeed so the Monet
  // engine stays a pure "seed -> scheme" function.
  if (typeof a.preset !== 'string') a.preset = DEFAULT_PRESET.id
  const chosen = presetById(a.preset)
  if (!chosen) {
    a.preset = DEFAULT_PRESET.id
  } else if (a.seedSource === 'custom') {
    a.customSeed = chosen.seed
  }
  if (typeof a.customSeed !== 'string' || !/^#[0-9a-fA-F]{6,8}$/.test(a.customSeed)) {
    a.customSeed = DEFAULT_PRESET.seed
  }
  a.contrast = clampNum(a.contrast, -1, 1, 0)
  a.roundness = clampNum(a.roundness, 0, 28, 16)
  if (typeof a.monet !== 'boolean') a.monet = false
  if (typeof a.reduceMotion !== 'boolean') a.reduceMotion = false

  const ai = settings.ai
  ai.temperature = clampNum(ai.temperature, 0, 2, 0.7)
  ai.maxTokens = Math.round(clampNum(ai.maxTokens, 16, 32768, 1024))
  ai.timeoutMs = Math.round(clampNum(ai.timeoutMs, 1000, 600000, 60000))
  if (typeof ai.systemPrompt !== 'string' || !ai.systemPrompt) ai.systemPrompt = SYSTEM_PROMPT
  if (typeof ai.seriesPrompt !== 'string' || !ai.seriesPrompt) ai.seriesPrompt = SERIES_PROMPT
  if (typeof ai.enabled !== 'boolean') ai.enabled = false

  const p = settings.proxy
  if (!isEngine(p.defaultEngine)) p.defaultEngine = 'xray'
  p.mixedPort = Math.round(clampNum(p.mixedPort, 1, 65535, 7897))
  const levels = ['error', 'warn', 'info', 'debug']
  if (!levels.includes(p.logLevel)) p.logLevel = 'info'
  for (const k of [
    'allowLan',
    'remoteDns',
    'autoStart',
    'systemProxy',
    'sniffing',
    'ipv6',
    'autoRestart'
  ] as const) {
    if (typeof p[k] !== 'boolean') p[k] = DEFAULT_SETTINGS.proxy[k]
  }
  if (typeof p.bypass !== 'string') p.bypass = DEFAULT_SETTINGS.proxy.bypass

  const g = settings.general
  g.zoom = clampNum(g.zoom, 0.5, 3, 1)
  if (g.language !== 'zh' && g.language !== 'en') g.language = 'zh'
  for (const k of ['closeToTray', 'launchAtLogin', 'checkUpdates'] as const) {
    if (typeof g[k] !== 'boolean') g[k] = DEFAULT_SETTINGS.general[k]
  }

  const lib = settings.library
  if (lib.defaultView !== 'grid' && lib.defaultView !== 'list') lib.defaultView = 'grid'
  if (!['auto', 'always', 'never'].includes(lib.spreadMode)) lib.spreadMode = 'auto'
  if (!['button', 'zone', 'both'].includes(lib.flipMode)) lib.flipMode = 'both'
  if (lib.importMode !== 'managed' && lib.importMode !== 'reference') lib.importMode = 'managed'
  if (!['added', 'title', 'author', 'recent'].includes(lib.defaultSort)) lib.defaultSort = 'added'
  lib.coverWidth = Math.round(clampNum(lib.coverWidth, 80, 400, 170))

  const s = settings.sync
  if (typeof s.enabled !== 'boolean') s.enabled = false
  if (typeof s.autoSync !== 'boolean') s.autoSync = false
  if (!['settings', 'library', 'both'].includes(s.scope)) s.scope = 'both'
  if (typeof s.remoteDir !== 'string' || !s.remoteDir) s.remoteDir = '/DolaToolkit'
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function getSettings(): Settings {
  if (!loaded) throw new Error('initStore() must be called before getSettings()')
  return clone(settings)
}

export function patchSettings(patch: SettingsPatch): Settings {
  if (!loaded) throw new Error('initStore() must be called before patchSettings()')
  const next = deepMerge(settings, patch ?? {}) as Settings
  next.schema = 1
  settings = next
  normalizeSettings()
  scheduleSettingsFlush()
  emitSettings()
  return clone(settings)
}

export function resetSettings(): Settings {
  if (!loaded) throw new Error('initStore() must be called before resetSettings()')
  settings = clone(DEFAULT_SETTINGS)
  normalizeSettings()
  flushStore()
  emitSettings()
  return clone(settings)
}

export function getDataDir(): string {
  if (!dataDir) throw new Error('initStore() must be called before getDataDir()')
  return dataDir
}

export function getLogsDir(): string {
  if (!logsDir) throw new Error('initStore() must be called before getLogsDir()')
  return logsDir
}

export function onSettingsChange(cb: (s: Settings) => void): () => void {
  settingsListeners.add(cb)
  return () => settingsListeners.delete(cb)
}

// ---------------------------------------------------------------------------
// Proxy persistence (nodes / selection / system-proxy flag)
// ---------------------------------------------------------------------------

export function getProxyStore(): ProxyStore {
  return clone(proxyStore)
}

export function patchProxyStore(patch: DeepPartial<ProxyStore>): ProxyStore {
  const next = deepMerge(proxyStore, patch ?? {}) as ProxyStore
  proxyStore = {
    nodes: Array.isArray(next.nodes) ? next.nodes : [],
    selectedNodeId:
      typeof next.selectedNodeId === 'string' || next.selectedNodeId === null
        ? next.selectedNodeId
        : null,
    activeEngine: isEngine(next.activeEngine) ? next.activeEngine : 'xray',
    systemProxy: next.systemProxy === true
  }
  if (dataDir) writeJsonAtomic(proxyFile(), proxyStore)
  emitProxy()
  return clone(proxyStore)
}

export function onProxyStoreChange(cb: (p: ProxyStore) => void): () => void {
  proxyListeners.add(cb)
  return () => proxyListeners.delete(cb)
}

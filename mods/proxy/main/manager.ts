// ---------------------------------------------------------------------------
// Dola Toolkit — proxy manager: lifecycle, node store, share-link import,
// system proxy (Windows registry), latency tests, geo assets.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { app, dialog } from 'electron'
import type {
  CoreId,
  CoreLogEvent,
  CoreStatus,
  EngineCapability,
  GeoState,
  ImportLinksResult,
  NodeDraft,
  NodeProtocol,
  NodeTestResult,
  ProxyNode,
  ProxySettings,
  ProxyState
} from '@shared/types'
import {
  buildCoreConfig,
  configFileName,
  startArgs,
  testArgs,
  validateMihomoYaml,
  xrayGeoEnv
} from './config'
import type { ModHostApi } from '../../../src/main/modService'

/**
 * Host services, injected by the mod entry before the manager is used.
 *
 * The manager used to import `../store` and `./binary` directly, which tied the proxy
 * feature to the application core. Everything it needs now arrives through this handle,
 * so the app carries no proxy knowledge at all.
 */
let host: ModHostApi = null as unknown as ModHostApi

export function setProxyHost(api: ModHostApi): void {
  host = api
}

/** The host handle, for the IPC layer that lives beside this file. */
export function getProxyHost(): ModHostApi {
  return host
}

const LOG_LIMIT = 400
/**
 * Absolute path to reg.exe.
 *
 * The Electron main process can inherit a PATH without System32 (portable exe,
 * launched from a minimal shell), in which case spawn('reg.exe') fails with
 * ENOENT and the system proxy silently never gets applied.
 */
function regExe(): string {
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  const abs = join(root, 'System32', 'reg.exe')
  return existsSync(abs) ? abs : 'reg.exe'
}

const REG_INTERNET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const TEST_TIMEOUT = 8000
const HEALTH_TIMEOUT = 8000

interface RunningCore {
  child: ChildProcess | null
  pid: number | null
  startedAt: number | null
  nodeId: string | null
  error: string | null
  restarting: boolean
  restartCount: number
  configPath: string | null
}

function emptyRunning(): RunningCore {
  return {
    child: null,
    pid: null,
    startedAt: null,
    nodeId: null,
    error: null,
    restarting: false,
    restartCount: 0,
    configPath: null
  }
}

function now(): number {
  return Date.now()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ProxyManager {
  private nodes: ProxyNode[] = []
  private selectedNodeId: string | null = null
  private activeEngine: CoreId = 'xray'
  private systemProxyOn = false
  private readonly running = new Map<CoreId, RunningCore>()
  private readonly logs = new Map<CoreId, string[]>()
  private readonly versions = new Map<CoreId, string | null>()
  private readonly listeners = new Set<(s: ProxyState) => void>()
  private readonly logListeners = new Set<(e: CoreLogEvent) => void>()
  private broadcastTimer: NodeJS.Timeout | null = null
  private stopping = false
  /** engines we are deliberately shutting down (see stopEngine) */
  private readonly intentionalStop = new Set<CoreId>()
  /** set when the last start failed because the port was already taken */
  private recentPortClash = false
  /** log count at the start of the last node test, per engine */
  private logCursor = new Map<CoreId, number>()
  private testPortCursor = 18080
  /** user's own proxy settings, captured before we enable ours */
  private previousProxy: { enable: boolean; server: string | null; override: string | null } | null = null

  constructor() {
    this.reload()
    for (const engine of ['xray', 'singbox', 'mihomo'] as CoreId[]) {
      this.running.set(engine, emptyRunning())
      this.logs.set(engine, [])
    }
  }

  // -------------------------------------------------------------------------
  // persistence
  // -------------------------------------------------------------------------

  reload(): void {
    const stored = host.store.get() as ProxyStore
    this.nodes = stored.nodes
    this.selectedNodeId = stored.selectedNodeId
    this.activeEngine = stored.activeEngine
    this.systemProxyOn = stored.systemProxy
  }

  private persist(): void {
    host.store.patch({
      nodes: this.nodes,
      selectedNodeId: this.selectedNodeId,
      activeEngine: this.activeEngine,
      systemProxy: this.systemProxyOn
    })
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  onState(cb: (s: ProxyState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onLog(cb: (e: CoreLogEvent) => void): () => void {
    this.logListeners.add(cb)
    return () => this.logListeners.delete(cb)
  }

  /** Throttled state broadcast — cores can emit hundreds of lines per second. */
  emitState(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      let snapshot: ProxyState
      try {
        snapshot = this.state()
      } catch {
        return
      }
      for (const cb of this.listeners) {
        try {
          cb(snapshot)
        } catch {
          /* ignore */
        }
      }
    }, 120)
    this.broadcastTimer.unref?.()
  }

  private emitLog(event: CoreLogEvent): void {
    for (const cb of this.logListeners) {
      try {
        cb(event)
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------

  settings(): ProxySettings {
    return host.settings.get().proxy
  }

  state(): ProxyState {
    return {
      nodes: this.nodes.map((n) => ({ ...n })),
      selectedNodeId: this.selectedNodeId,
      engines: (['xray', 'singbox', 'mihomo'] as CoreId[]).map((e) => this.statusOf(e)),
      activeEngine: this.activeEngine,
      systemProxy: this.systemProxyOn,
      geo: this.geoState(),
      settings: this.settings()
    }
  }

  statusOf(engine: CoreId): CoreStatus {
    const run = this.running.get(engine) ?? emptyRunning()
    const bin = host.cores.find(engine)
    return {
      engine,
      available: bin !== null,
      version: this.versions.get(engine) ?? null,
      running: run.child !== null,
      pid: run.pid,
      nodeId: run.nodeId,
      startedAt: run.startedAt,
      error: run.error,
      mixedPort: this.settings().mixedPort,
      logs: [...(this.logs.get(engine) ?? [])]
    }
  }

  async engines(): Promise<EngineCapability[]> {
    const list = await host.cores.engines()
    for (const e of list) this.versions.set(e.engine, e.version)
    return list
  }

  private appendLog(engine: CoreId, line: string): void {
    const clean = line.replace(/\r$/, '')
    if (!clean.trim()) return
    const buf = this.logs.get(engine) ?? []
    buf.push(clean)
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT)
    this.logs.set(engine, buf)
    this.emitLog({ engine, line: clean, level: this.levelOf(clean), at: now() })
  }

  private levelOf(line: string): CoreLogEvent['level'] {
    if (/\b(fatal|error|err|failed|exception)\b/i.test(line)) return 'error'
    if (/\b(warn|warning|deprecated)\b/i.test(line)) return 'warn'
    return 'info'
  }

  clearLogs(engine: CoreId): void {
    this.logs.set(engine, [])
    this.emitState()
  }

  // -------------------------------------------------------------------------
  // nodes
  // -------------------------------------------------------------------------

  nodeById(id: string | null): ProxyNode | null {
    if (!id) return null
    return this.nodes.find((n) => n.id === id) ?? null
  }

  saveNode(draft: Partial<ProxyNode> & { id?: string }): ProxyNode {
    const ts = now()
    const engineDefault = this.settings().defaultEngine
    const existing = draft.id ? this.nodeById(draft.id) : null
    if (existing) {
      const updated: ProxyNode = {
        ...existing,
        ...sanitizeDraft(draft),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: ts
      }
      this.nodes = this.nodes.map((n) => (n.id === existing.id ? updated : n))
      this.persist()
      this.emitState()
      return updated
    }
    const created: ProxyNode = {
      ...baseNode(),
      ...sanitizeDraft(draft),
      id: randomUUID(),
      engine: isEngine(draft.engine) ? draft.engine : engineDefault,
      createdAt: ts,
      updatedAt: ts
    }
    this.nodes = [...this.nodes, created]
    if (!this.selectedNodeId) this.selectedNodeId = created.id
    this.persist()
    this.emitState()
    return created
  }

  deleteNode(id: string): void {
    const existed = this.nodes.some((n) => n.id === id)
    if (!existed) return
    this.nodes = this.nodes.filter((n) => n.id !== id)
    if (this.selectedNodeId === id) {
      this.selectedNodeId = this.nodes[0]?.id ?? null
      if (this.isRunning()) {
        void this.restartForNodeChange()
      }
    }
    this.persist()
    this.emitState()
  }

  selectNode(id: string | null): ProxyState {
    if (id !== null && !this.nodeById(id)) {
      this.emitState()
      return this.state()
    }
    const changed = id !== this.selectedNodeId
    this.selectedNodeId = id
    const node = this.nodeById(id)
    if (node && isEngine(node.engine)) this.activeEngine = node.engine
    this.persist()
    if (changed && this.isRunning()) void this.restartForNodeChange()
    this.emitState()
    return this.state()
  }

  private async restartForNodeChange(): Promise<void> {
    if (!this.isRunning()) return
    // Restart just the core. Calling stop() here would also clear the Windows
    // system proxy and start() would re-enable it — a visible on/off flicker
    // every time the user switches nodes. The OS proxy keeps pointing at the
    // same local mixed port, which stays valid across the restart.
    const keepSystemProxy = this.systemProxyOn
    this.stopping = true
    try {
      for (const e of ['xray', 'singbox', 'mihomo'] as CoreId[]) await this.stopEngine(e)
    } finally {
      this.stopping = false
    }
    await delay(150)
    // Preserve the proxy flag across the restart.
    this.systemProxyOn = keepSystemProxy
    await this.start()
    if (keepSystemProxy && !this.systemProxyOn) await this.setSystemProxy(true)
  }

  isRunning(): boolean {
    for (const run of this.running.values()) if (run.child) return true
    return false
  }

  /**
   * React to a settings write that affects the proxy.
   *
   * Previously nothing notified the manager, so toggling 允许局域网 (allowLan)
   * changed the stored value but the running core kept its old listen address:
   * only whichever mode the core had been started with actually worked, and
   * flipping the other switch appeared to break proxying.
   */
  async applySettingsChange(prev: ProxySettings, next: ProxySettings): Promise<void> {
    const inboundChanged =
      prev.allowLan !== next.allowLan ||
      prev.mixedPort !== next.mixedPort ||
      prev.sniffing !== next.sniffing ||
      prev.ipv6 !== next.ipv6 ||
      prev.logLevel !== next.logLevel ||
      prev.remoteDns !== next.remoteDns ||
      prev.bypass !== next.bypass

    if (inboundChanged && this.isRunning()) {
      // The core must be rebuilt to honour the new inbound settings.
      await this.restartForNodeChange()
    }

    // Keep the OS proxy consistent with the user's intent, but only when the
    // core is actually up — otherwise Windows would point at a dead port.
    if (prev.systemProxy !== next.systemProxy) {
      if (next.systemProxy && this.isRunning()) {
        await this.setSystemProxy(true)
      } else if (!next.systemProxy && this.systemProxyOn) {
        await this.setSystemProxy(false)
      }
    }
  }

  // -------------------------------------------------------------------------
  // share-link import
  // -------------------------------------------------------------------------

  importLinks(text: string): ImportLinksResult {
    const result: ImportLinksResult = { added: [], failed: [] }
    if (typeof text !== 'string' || !text.trim()) return result
    const lines = text.split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('//')) continue
      try {
        const parsed = parseShareLink(line)
        if (!parsed) {
          result.failed.push({ link: truncate(line), reason: '无法识别的链接格式' })
          continue
        }
        const node = this.saveNode(parsed)
        result.added.push(node)
      } catch (e) {
        result.failed.push({
          link: truncate(line),
          reason: e instanceof Error ? e.message : '解析失败'
        })
      }
    }
    return result
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<CoreStatus> {
    this.stopping = false
    this.recentPortClash = false
    const node = this.nodeById(this.selectedNodeId) ?? this.nodes[0] ?? null
    if (!node) {
      this.fail('xray', '请先添加或选择一个节点')
      const engine = this.activeEngine
      return this.statusOf(engine)
    }
    if (!node.enabled) {
      this.fail(node.engine, '该节点已被禁用')
      return this.statusOf(node.engine)
    }

    const engine: CoreId = isEngine(node.engine) ? node.engine : this.settings().defaultEngine
    if (this.selectedNodeId !== node.id) this.selectedNodeId = node.id
    this.activeEngine = engine

    /*
     * Refuse a node this engine cannot actually run.
     *
     * Xray has no Hysteria2 / TUIC support, yet start() used to build a config with a
     * fallback outbound and report "running": the proxy looked healthy while nothing
     * went through it. Reporting the mismatch (and naming a core that does work) is far
     * better than a silent black hole.
     */
    if (!host.cores.supports(engine, node.protocol)) {
      const alternatives = host.cores.enginesFor(node.protocol).filter((e) => host.cores.find(e) !== null)
      const suggest = alternatives.length
        ? `请把该节点的内核改为 ${alternatives.map((e) => host.cores.labels[e]).join(' 或 ')}`
        : '当前没有可用的内核支持该协议'
      const msg = `${host.cores.labels[engine]} 不支持 ${node.protocol.toUpperCase()} 节点，${suggest}`
      this.fail(engine, msg)
      return this.statusOf(engine)
    }

    // only one core at a time
    for (const other of ['xray', 'singbox', 'mihomo'] as CoreId[]) {
      if (other !== engine && this.running.get(other)?.child) await this.stopEngine(other)
    }

    /*
     * Clear an orphaned core before binding.
     *
     * If this app was killed (crash, task manager, the previous relaunch bug) its
     * core kept running and still owns the mixed port, so every start afterwards
     * fails with「核心退出 code=1」and the proxy appears permanently broken. Only
     * processes whose image is one of OUR cores AND whose path lives under our
     * cores directory are touched — an unrelated app listening on the same port is
     * left alone for the user to see in the error message.
     */
    await this.killOrphanedCores(this.settings().mixedPort)

    const run = this.running.get(engine) ?? emptyRunning()
    /*
     * Starting twice is not harmless: the second core cannot bind the mixed port,
     * exits with code 1, and the manager then records "核心退出 code=1" for an
     * engine whose first instance is perfectly healthy — indistinguishable from a
     * real crash, and it makes the proxy look like it keeps dropping. When the
     * same node is already running, just report the current status.
     */
    if (run.child && run.nodeId === node.id && (await this.waitForPort(this.settings().mixedPort, 400))) {
      this.emitState()
      return this.statusOf(engine)
    }
    this.running.set(engine, run)
    run.error = null
    run.nodeId = node.id

    const bin = host.cores.find(engine)
    if (!bin) {
      this.running.set(engine, { ...emptyRunning(), nodeId: node.id, error: `未找到 ${host.cores.labels[engine]} 核心文件` })
      this.emitState()
      return this.statusOf(engine)
    }

    const settings = this.settings()
    let configText: string
    try {
      configText = buildCoreConfig(engine, node, settings, host.cores.ruleSets())
    } catch (e) {
      const msg = e instanceof Error ? e.message : '配置生成失败'
      this.running.set(engine, { ...emptyRunning(), nodeId: node.id, error: msg })
      this.emitState()
      return this.statusOf(engine)
    }

    if (engine === 'mihomo') {
      const problems = validateMihomoYaml(configText)
      if (problems.length) {
        this.appendLog(engine, `配置自检警告: ${problems.join('; ')}`)
      }
    }

    const dir = join(host.dataDir, 'proxy', engine)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    const cfgPath = join(dir, configFileName(engine))
    try {
      writeFileSync(cfgPath, configText, 'utf8')
    } catch (e) {
      const msg = `无法写入配置文件: ${e instanceof Error ? e.message : String(e)}`
      this.running.set(engine, { ...emptyRunning(), nodeId: node.id, error: msg })
      this.emitState()
      return this.statusOf(engine)
    }
    run.configPath = cfgPath

    // pre-flight: let the core validate the config before we spawn it for real
    // mihomo needs its .dat assets for `-t` too; without them it downloads (and times
    // out) during validation, before it ever gets to start
    this.bootstrapGeo(engine, dir)
    const check = await this.validateConfig(engine, cfgPath)
    if (!check.ok) {
      const msg = check.message || '配置校验失败'
      this.appendLog(engine, `配置校验失败: ${msg}`)
      this.running.set(engine, { ...emptyRunning(), nodeId: node.id, error: msg, configPath: cfgPath })
      this.emitState()
      return this.statusOf(engine)
    }

    const args = startArgs(engine, cfgPath, dir)
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (engine === 'xray') {
      const geo = host.cores.geo()
      Object.assign(env, xrayGeoEnv(geo.dir))
    }

    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        cwd: engine === 'mihomo' ? dir : join(bin, '..'),
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '核心启动失败'
      this.running.set(engine, { ...emptyRunning(), nodeId: node.id, error: msg, configPath: cfgPath })
      this.emitState()
      return this.statusOf(engine)
    }

    this.running.set(engine, {
      child,
      pid: child.pid ?? null,
      startedAt: now(),
      nodeId: node.id,
      error: null,
      restarting: false,
      restartCount: 0,
      configPath: cfgPath
    })
    this.appendLog(
      engine,
      `[dola] 启动 ${host.cores.labels[engine]} pid=${child.pid ?? '?'} port=${settings.mixedPort}`
    )

    child.stdout?.on('data', (buf: Buffer) => this.onCoreData(engine, buf))
    child.stderr?.on('data', (buf: Buffer) => this.onCoreData(engine, buf))
    child.on('error', (err) => {
      this.appendLog(engine, `[dola] 进程错误: ${err.message}`)
      this.markError(engine, err.message)
    })
    child.on('exit', (code, signal) => {
      void this.onCoreExit(engine, code, signal)
    })

    this.emitState()

    // health check: is the mixed port accepting connections?
    const healthy = await this.waitForPort(settings.mixedPort, HEALTH_TIMEOUT)
    if (!healthy) {
      const run2 = this.running.get(engine)
      if (run2?.child) {
        run2.error = `核心已启动但 ${settings.mixedPort} 端口未就绪`
        this.appendLog(engine, `[dola] ${run2.error}`)
      }
    } else if (engine === 'xray' || engine === 'singbox') {
      const run2 = this.running.get(engine)
      if (run2) run2.error = null
    }

    if (settings.systemProxy) {
      const ok = await this.setSystemProxy(true)
      if (!ok) this.appendLog(engine, '[dola] 系统代理设置失败，请检查权限')
    }
    this.emitState()
    return this.statusOf(engine)
  }

  private onCoreData(engine: CoreId, buf: Buffer): void {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      // Remember bind failures so onCoreExit can stop retrying a hopeless start.
      if (/Only one usage of each socket address|address already in use|failed to listen/i.test(line)) {
        this.recentPortClash = true
      }
      this.appendLog(engine, line)
    }
    this.emitState()
  }

  private markError(engine: CoreId, message: string): void {
    const run = this.running.get(engine)
    if (run) run.error = message
    this.emitState()
  }

  private async onCoreExit(
    engine: CoreId,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const run = this.running.get(engine)
    if (!run) return
    const wasIntentional = this.intentionalStop.has(engine) || this.stopping
    this.intentionalStop.delete(engine)
    run.child = null
    run.pid = null
    this.appendLog(engine, `[dola] 核心已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    this.emitState()

    // A stop we asked for is not a crash: never restart, never touch the OS proxy.
    if (wasIntentional) return

    const settings = this.settings()
    // Windows reports 4294967295 (== -1 as unsigned) for a force-killed process.
    // Treat it as a clean, deliberate termination rather than a crash.
    const forcedKill = code === 4294967295 || code === -1
    const crashed = code !== 0 && !forcedKill
    // A port clash is permanent until the other process goes away; retrying only
    // makes things worse (and used to toggle the system proxy on every attempt).
    const portClash = this.recentPortClash
    const willRetry = settings.autoRestart && crashed && !portClash && run.restartCount < 3 && run.nodeId

    // Only clear the OS proxy when we are giving up for good — never between
    // retries, which is what made the Windows proxy flap.
    if (!willRetry && this.systemProxyOn && settings.systemProxy) {
      await this.setSystemProxy(false)
    }
    if (portClash) {
      run.error = `端口 ${settings.mixedPort} 已被占用，请关闭占用该端口的程序或改用其他端口`
      this.appendLog(engine, `[dola] ${run.error}`)
      this.recentPortClash = false
    }

    if (willRetry) {
      run.restartCount += 1
      run.error = `核心异常退出（code=${code ?? '?'}），正在第 ${run.restartCount} 次自动重启…`
      this.emitState()
      this.appendLog(engine, `[dola] ${run.error}`)
      await delay(2000)
      if (this.stopping) return
      void this.start()
      return
    }

    run.error = code === 0 || code === null ? null : `核心退出 code=${code}`
    run.nodeId = null
    this.emitState()
  }

  async stop(): Promise<CoreStatus> {
    this.stopping = true
    const engine = this.activeEngine
    try {
      for (const e of ['xray', 'singbox', 'mihomo'] as CoreId[]) {
        await this.stopEngine(e)
      }
      // Only touch the OS proxy if we actually installed ours.
      if (this.systemProxyOn) await this.setSystemProxy(false)
    } finally {
      this.stopping = false
    }
    this.emitState()
    return this.statusOf(engine)
  }

  /**
   * Kills cores left behind by a previous (crashed or force-killed) run.
   *
   * Only the three core image names are considered, and only when nothing of ours
   * is currently tracked — a healthy run is never disturbed. The path check is
   * deliberately permissive: an orphan can live in any folder this app has shipped
   * cores from (the project `cores` tree, a previous install under the deploy
   * folder, a temp unpack of the portable build), and refusing to clean it leaves
   * the mixed port owned forever, so every start fails with「核心退出 code=1」.
   * If a *different* program owns the port it is not one of these images, and the
   * normal error message still reports it to the user.
   */
  private async killOrphanedCores(port: number): Promise<void> {
    if (process.platform !== 'win32') return
    const tracked = (['xray', 'singbox', 'mihomo'] as CoreId[]).some((e) => this.running.get(e)?.child)
    if (tracked) return
    const occupied = await this.portIsListening(port)
    if (!occupied) return
    const ps = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const image of ['xray.exe', 'sing-box.exe', 'mihomo.exe']) {
      await new Promise<void>((resolve) => {
        const script = `Get-Process -Name '${image.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`
        const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          stdio: 'ignore'
        })
        child.on('error', () => resolve())
        child.on('exit', () => resolve())
        setTimeout(resolve, 6000).unref?.()
      })
    }
    // let Windows release the socket before we bind
    await delay(700)
  }

  /** True when something is already listening on the port. */
  private portIsListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      let done = false
      const finish = (v: boolean): void => {
        if (done) return
        done = true
        socket.destroy()
        resolve(v)
      }
      socket.on('connect', () => finish(true))
      socket.on('error', () => finish(false))
      setTimeout(() => finish(false), 800).unref?.()
    })
  }

  private async stopEngine(engine: CoreId): Promise<void> {
    const run = this.running.get(engine)
    if (!run) return
    const child = run.child
    const pid = run.pid ?? child?.pid ?? null
    // Mark this engine as deliberately stopping BEFORE the kill, so the exit
    // handler knows not to auto-restart and not to clear the system proxy.
    this.intentionalStop.add(engine)
    run.restartCount = 0
    run.error = null
    run.nodeId = null
    run.child = null
    run.pid = null
    run.startedAt = null
    if (!child && !pid) {
      this.intentionalStop.delete(engine)
      return
    }

    this.appendLog(engine, `[dola] 停止 ${host.cores.labels[engine]} pid=${pid ?? '?'}`)
    if (pid && process.platform === 'win32') {
      // kill the whole tree: core may spawn helper processes
      await new Promise<void>((resolve) => {
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          })
          killer.on('exit', () => resolve())
          killer.on('error', () => resolve())
        } catch {
          resolve()
        }
      })
    }
    try {
      child?.kill()
    } catch {
      /* already gone */
    }
    // Wait for the listening socket to be released before returning, so an
    // immediate restart cannot hit "address already in use".
    await this.waitForPortReleased(this.settings().mixedPort, 4000)
    await delay(80)
    this.intentionalStop.delete(engine)
    this.emitState()
  }

  private fail(engine: CoreId, message: string): void {
    const run = this.running.get(engine) ?? emptyRunning()
    run.error = message
    this.running.set(engine, run)
    this.appendLog(engine, `[dola] ${message}`)
    this.emitState()
  }

  /** Run `-test` / `check` and report the first meaningful error line. */
  private validateConfig(engine: CoreId, cfgPath: string): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const bin = host.cores.find(engine)
      if (!bin) return resolve({ ok: false, message: '核心文件缺失' })
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (engine === 'xray') Object.assign(env, xrayGeoEnv(host.cores.geo().dir))
      const homeDir = dirname(cfgPath)
      let out = ''
      let settled = false
      const done = (ok: boolean, message = ''): void => {
        if (settled) return
        settled = true
        resolve({ ok, message })
      }
      try {
        const child = spawn(bin, testArgs(engine, cfgPath, homeDir), {
          cwd: join(bin, '..'),
          windowsHide: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.on('error', (e) => done(false, e.message))
        child.on('exit', (code) => {
          if (code === 0) return done(true)
          const lines = out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !/^Xray \d|^A unified platform|^sing-box version|^Environment:|^Mihomo Meta/i.test(l))
          done(false, lines.slice(-2).join(' ') || `exit code ${code}`)
        })
        setTimeout(() => done(false, '配置校验超时'), 20000).unref?.()
      } catch (e) {
        done(false, e instanceof Error ? e.message : '校验失败')
      }
    })
  }

  /** Make sure mihomo finds its .dat assets in its working directory. */
  private bootstrapGeo(engine: CoreId, dir: string): void {
    if (engine !== 'mihomo') return
    try {
      const geo = host.cores.geo()
      for (const name of ['geoip.dat', 'geosite.dat'] as const) {
        const target = join(dir, name)
        const from = name === 'geoip.dat' ? geo.geoip : geo.geosite
        if (!from || !existsSync(from)) continue
        // a half-downloaded file from an earlier failed start would otherwise be kept
        // forever and make mihomo try to fetch it again
        const existing = existsSync(target) ? statSync(target).size : 0
        const real = statSync(from).size
        if (existing >= real) continue
        writeFileSync(target, readFileSync(from))
      }
    } catch {
      /* mihomo will download or warn; not fatal */
    }
  }

  /** Resolve once nothing is listening on `port` (or the timeout elapses). */
  private waitForPortReleased(port: number, timeoutMs: number): Promise<void> {
    const deadline = now() + timeoutMs
    return new Promise((resolve) => {
      const attempt = (): void => {
        const socket = connect({ host: '127.0.0.1', port })
        let done = false
        const finish = (inUse: boolean): void => {
          if (done) return
          done = true
          socket.destroy()
          if (!inUse) return resolve()
          if (now() > deadline) return resolve()
          setTimeout(attempt, 150)
        }
        socket.setTimeout(600, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      }
      attempt()
    })
  }

  private waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs
    return new Promise((resolve) => {
      const attempt = (): void => {
        const socket = connect({ host: '127.0.0.1', port })
        let done = false
        const finish = (ok: boolean): void => {
          if (done) return
          done = true
          socket.destroy()
          if (ok) return resolve(true)
          if (now() > deadline) return resolve(false)
          setTimeout(attempt, 200)
        }
        socket.setTimeout(1200, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      }
      attempt()
    })
  }

  // -------------------------------------------------------------------------
  // system proxy (Windows registry)
  // -------------------------------------------------------------------------

  getSystemProxy(): boolean {
    return this.systemProxyOn
  }

  /**
   * Turn the Windows system proxy on/off. When enabling, the user's existing
   * settings are snapshotted first and restored on disable, so Dola Toolkit never
   * destroys a proxy configuration it did not create. Idempotent: the snapshot
   * is taken exactly once per enable cycle.
   */
  async setSystemProxy(on: boolean): Promise<boolean> {
    if (process.platform !== 'win32') {
      // registry is Windows-only; keep the flag coherent elsewhere
      this.systemProxyOn = on
      this.persist()
      this.emitState()
      return on
    }
    const settings = this.settings()
    const port = settings.mixedPort
    const key = REG_INTERNET

    let ok: boolean
    if (on) {
      // Only snapshot when we are transitioning from off → on.
      if (!this.systemProxyOn) {
        this.previousProxy = await this.readProxySnapshot()
      }
      ok = await this.regWrite(key, 'ProxyEnable', 'REG_DWORD', '1')
      if (ok) {
        await this.regWrite(key, 'ProxyServer', 'REG_SZ', `127.0.0.1:${port}`)
        const bypass = normalizeBypass(settings.bypass)
        if (bypass) await this.regWrite(key, 'ProxyOverride', 'REG_SZ', bypass)
      }
    } else {
      // Only tear down what we installed. If the registry no longer points at
      // our port (user changed it, another app took over, or we were never on),
      // leave it untouched — "off" must be safe to call at any time, repeatedly.
      const current = await this.readProxySnapshot()
      const ours = current?.server === `127.0.0.1:${port}` || this.systemProxyOn
      if (!ours) {
        this.systemProxyOn = false
        this.persist()
        this.emitState()
        return true
      }
      ok = await this.regWrite(key, 'ProxyEnable', 'REG_DWORD', '0')
      if (!this.previousProxy) {
        // no snapshot to restore: make sure we are not still pointing at our port
        const after = await this.readProxySnapshot()
        if (after?.enable && after.server === `127.0.0.1:${port}`) {
          await this.regWrite(key, 'ProxyEnable', 'REG_DWORD', '0')
        }
      }
      if (ok && this.previousProxy) {
        // put the user's original proxy back exactly as it was
        await this.regWrite(key, 'ProxyEnable', 'REG_DWORD', this.previousProxy.enable ? '1' : '0')
        if (this.previousProxy.server) {
          await this.regWrite(key, 'ProxyServer', 'REG_SZ', this.previousProxy.server)
        }
        if (this.previousProxy.override !== null) {
          await this.regWrite(key, 'ProxyOverride', 'REG_SZ', this.previousProxy.override)
        }
        this.previousProxy = null
        /*
         * Safety net.
         *
         * If the restore above left the machine still pointing at OUR port while
         * enabled (snapshot incomplete, or a partial write), turning the proxy
         * off must not leave the user without internet. Only our own port is
         * forced off — a proxy the user configured themselves is left alone.
         */
        const after = await this.readProxySnapshot()
        if (after?.enable && after.server === `127.0.0.1:${port}`) {
          await this.regWrite(key, 'ProxyEnable', 'REG_DWORD', '0')
        }
      }
    }
    if (ok) await notifyInternetSettingsChanged()
    // Only remember a state we actually achieved — otherwise the UI claims the
    // system proxy is on while the registry still points somewhere else.
    this.systemProxyOn = ok ? on : this.systemProxyOn
    this.persist()
    this.emitState()
    return ok
  }

  /** Read the three registry values we touch, so they can be restored later. */
  private readProxySnapshot(): Promise<{
    enable: boolean
    server: string | null
    override: string | null
  } | null> {
    return new Promise((resolve) => {
      try {
        const child = spawn(regExe(), ['query', REG_INTERNET], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        let out = ''
        child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.on('error', () => resolve(null))
        child.on('exit', () => {
          const parse = (name: string): string | null => {
            const re = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'im')
            const m = re.exec(out)
            return m ? m[1].trim() : null
          }
          const enableRaw = parse('ProxyEnable')
          const server = parse('ProxyServer')
          const override = parse('ProxyOverride')
          resolve({
            enable: enableRaw === '0x1' || enableRaw === '1',
            server: server && server !== '<none>' ? server : null,
            override: override && override !== '<none>' ? override : null
          })
        })
        setTimeout(() => resolve(null), 5000).unref?.()
      } catch {
        resolve(null)
      }
    })
  }

  private regWrite(
    key: string,
    name: string,
    type: 'REG_DWORD' | 'REG_SZ',
    value: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = spawn(regExe(), ['add', key, '/v', name, '/t', type, '/d', value, '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        child.on('exit', (code) => resolve(code === 0))
        child.on('error', () => resolve(false))
        setTimeout(() => resolve(false), 6000).unref?.()
      } catch {
        resolve(false)
      }
    })
  }

  // -------------------------------------------------------------------------
  // latency / exit-IP test
  // -------------------------------------------------------------------------

  async testNode(id: string): Promise<NodeTestResult> {
    const node = this.nodeById(id)
    const base: NodeTestResult = {
      nodeId: id,
      ok: false,
      delayMs: null,
      exitIp: null,
      country: null,
      error: null
    }
    if (!node) return { ...base, error: '节点不存在' }
    const engine: CoreId = isEngine(node.engine) ? node.engine : this.settings().defaultEngine
    const bin = host.cores.find(engine)
    if (!bin) return { ...base, error: `未找到 ${host.cores.labels[engine]} 核心` }

    const settings = { ...this.settings() }
    const run = this.running.get(engine)
    const alreadyRunning = run?.child != null && run.nodeId === node.id

    let port = settings.mixedPort
    let tempChild: ChildProcess | null = null
    let tempDir: string | null = null

    if (!alreadyRunning) {
      port = await this.freePort()
      // remember where this run's logs begin, so diagnose() can never report a
      // stale error left over from an earlier attempt
      this.logCursor.set(engine, (this.logs.get(engine) ?? []).length)
      const testSettings: ProxySettings = { ...settings, mixedPort: port, allowLan: false, systemProxy: false }
      let cfg: string
      try {
        cfg = buildCoreConfig(engine, node, testSettings, host.cores.ruleSets())
      } catch (e) {
        return { ...base, error: e instanceof Error ? e.message : '配置生成失败' }
      }
      tempDir = join(app.getPath('temp'), `dola-test-${randomUUID()}`)
      try {
        mkdirSync(tempDir, { recursive: true })
      } catch {
        return { ...base, error: '无法创建临时目录' }
      }
      const cfgPath = join(tempDir, configFileName(engine))
      try {
        writeFileSync(cfgPath, cfg, 'utf8')
      } catch (e) {
        await removeDir(tempDir)
        return { ...base, error: e instanceof Error ? e.message : '无法写入临时配置' }
      }
      if (engine === 'mihomo') this.bootstrapGeo(engine, tempDir)
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (engine === 'xray') Object.assign(env, xrayGeoEnv(host.cores.geo().dir))
      try {
        tempChild = spawn(bin, startArgs(engine, cfgPath, tempDir), {
          cwd: engine === 'mihomo' ? tempDir : join(bin, '..'),
          windowsHide: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (e) {
        await removeDir(tempDir)
        return { ...base, error: e instanceof Error ? e.message : '临时核心启动失败' }
      }
      tempChild.stdout?.on('data', (b: Buffer) => this.onCoreData(engine, b))
      tempChild.stderr?.on('data', (b: Buffer) => this.onCoreData(engine, b))
      const ready = await this.waitForPort(port, HEALTH_TIMEOUT)
      if (!ready) {
        await killTree(tempChild)
        await removeDir(tempDir)
        return { ...base, error: '测试用核心启动超时' }
      }
    }

    try {
      const delayMs = await this.measureDelay(port)
      const exit = await this.probeExit(port)
      return {
        nodeId: id,
        ok: delayMs !== null,
        delayMs,
        exitIp: exit?.ip ?? null,
        country: exit?.country ?? null,
        error: delayMs === null ? this.diagnose(engine, node) : null
      }
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : '测试失败' }
    } finally {
      if (tempChild) await killTree(tempChild)
      if (tempDir) await removeDir(tempDir)
    }
  }

  /**
   * Turns the core's own stderr into an explanation the user can act on.
   *
   * "无法通过该节点访问网络" alone is useless when the real reason is a
   * certificate pin mismatch — which is exactly what happens with a Hysteria2
   * link whose pinSHA256 no longer matches the server's public key.
   */
  private diagnose(engine: CoreId, node: ProxyNode): string {
    const lines = this.logs.get(engine) ?? []
    const from = this.logCursor.get(engine) ?? Math.max(0, lines.length - 40)
    const tail = lines.slice(from).slice(-60)
    const has = (re: RegExp): string | undefined => {
      for (let i = tail.length - 1; i >= 0; i--) {
        if (re.test(tail[i])) return tail[i]
      }
      return undefined
    }
    const pin = has(/unrecognized remote public key|certificate_public_key|pin/i)
    if (pin) {
      return `证书公钥不匹配：服务器当前公钥与链接里的 pinSHA256 不一致（服务器可能更换了证书）。可在节点设置中开启「跳过证书校验」后重试`
    }
    if (has(/certificate|tls:|x509/i)) {
      return 'TLS 握手失败：证书校验未通过。可尝试开启「跳过证书校验」，或检查 SNI 是否正确'
    }
    if (has(/i\/o timeout|timeout|deadline exceeded/i)) {
      return '连接超时：节点可能离线，或当前网络阻断了该端口'
    }
    if (has(/connection refused|no route|network is unreachable/i)) {
      return '无法建立连接：节点地址或端口不可达'
    }
    if (node.protocol === 'hysteria2' || node.protocol === 'tuic') {
      return '节点不可用：Hysteria2/TUIC 使用 UDP，请确认网络允许 UDP 且节点在线'
    }
    const last = has(/ERROR|FATAL|error/i)
    return last ? `节点不可用：${last.replace(/^.*?(ERROR|FATAL)\s*/i, '').slice(0, 160)}` : '无法通过该节点访问网络'
  }

  /**
   * Measures latency through the local proxy.
   *
   * Several endpoints are tried in order, because a single hard-coded one is not a
   * measurement of the NODE: `www.gstatic.com` is reset outright on some routes
   * (observed: ECONNRESET on every attempt through a Hysteria2 node that served
   * youtube fine), so the old implementation reported "测速失败" for a perfectly
   * healthy node. Endpoints that answer give a real number; only when none do is the
   * node actually unusable.
   *
   * The 204 endpoints are used with plain HTTP on purpose: no TLS handshake, so the
   * number reflects the tunnel rather than a session-cache warm-up.
   */
  private async measureDelay(port: number): Promise<number | null> {
    const endpoints = [
      { host: 'www.google.com', path: 'http://www.google.com/generate_204' },
      { host: 'cp.cloudflare.com', path: 'http://cp.cloudflare.com/generate_204' },
      { host: 'www.gstatic.com', path: 'http://www.gstatic.com/generate_204' },
      { host: 'www.bing.com', path: 'http://www.bing.com/generate_204' }
    ]
    const results: number[] = []
    for (const ep of endpoints) {
      const ms = await this.timeOnce(port, ep.host, ep.path)
      if (ms !== null) {
        results.push(ms)
        // two independent answers are enough to trust the number and stay fast
        if (results.length >= 2) break
      }
    }
    if (results.length === 0) return null
    // lowest of the samples: the median is skewed by the first, cold connection
    return Math.min(...results)
  }

  /** One timed request through the proxy; null when it did not get through. */
  private timeOnce(port: number, host: string, path: string): Promise<number | null> {
    return new Promise((resolve) => {
      const started = now()
      let settled = false
      const done = (v: number | null): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      try {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { Host: host, 'User-Agent': 'Dola Toolkit/1.0', Connection: 'close' },
          timeout: TEST_TIMEOUT
        })
        req.on('response', (res) => {
          res.resume()
          res.on('end', () => done(Math.max(1, now() - started)))
          res.on('error', () => done(null))
        })
        req.on('timeout', () => {
          req.destroy()
          done(null)
        })
        req.on('error', () => done(null))
        req.end()
        setTimeout(() => {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          done(null)
        }, TEST_TIMEOUT).unref?.()
      } catch {
        done(null)
      }
    })
  }

  /**
   * Looks up the exit IP / country through the node.
   *
   * Several plain-HTTP endpoints are tried in turn: some nodes (or the networks
   * they exit through) block one of them, and a single hard-coded endpoint made
   * the result flip between an IP and "unknown" for no visible reason.
   */
  private async probeExit(port: number): Promise<{ ip: string | null; country: string | null } | null> {
    const probes: {
      path: string
      host: string
      read: (j: Record<string, unknown>) => { ip: string | null; country: string | null } | null
    }[] = [
      {
        path: 'http://ip-api.com/json?fields=status,country,query',
        host: 'ip-api.com',
        read: (j) => ({
          ip: typeof j.query === 'string' ? j.query : null,
          country: typeof j.country === 'string' ? j.country : null
        })
      },
      {
        path: 'http://ipinfo.io/json',
        host: 'ipinfo.io',
        read: (j) => ({
          ip: typeof j.ip === 'string' ? j.ip : null,
          country: typeof j.country === 'string' ? j.country : null
        })
      },
      {
        path: 'http://api.ipify.org/?format=json',
        host: 'api.ipify.org',
        read: (j) => ({ ip: typeof j.ip === 'string' ? j.ip : null, country: null })
      }
    ]

    for (const probe of probes) {
      const got = await this.getJson(port, probe.path, probe.host)
      if (!got) continue
      const parsed = probe.read(got)
      if (parsed?.ip) return parsed
    }
    return null
  }

  /** Tiny HTTP GET through the local proxy port, JSON-decoded. */
  private getJson(port: number, path: string, host: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (v: Record<string, unknown> | null): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      try {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { Host: host, 'User-Agent': 'Dola Toolkit/1.0', Accept: 'application/json' },
          timeout: 6000
        })
        req.on('response', (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => {
            if (body.length < 8192) body += c
          })
          res.on('end', () => {
            try {
              done(JSON.parse(body) as Record<string, unknown>)
            } catch {
              done(null)
            }
          })
        })
        req.on('timeout', () => {
          req.destroy()
          done(null)
        })
        req.on('error', () => done(null))
        req.end()
        setTimeout(() => {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          done(null)
        }, 6000).unref?.()
      } catch {
        done(null)
      }
    })
  }

  private freePort(): Promise<number> {
    const tryOnce = (candidate: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const srv = createServer()
        srv.once('error', () => reject(new Error('busy')))
        srv.listen(candidate, '127.0.0.1', () => {
          const addr = srv.address()
          const port = typeof addr === 'object' && addr ? addr.port : candidate
          srv.close(() => resolve(port))
        })
      })
    return (async () => {
      for (let i = 0; i < 24; i++) {
        const candidate = this.testPortCursor
        this.testPortCursor = this.testPortCursor >= 18980 ? 18080 : this.testPortCursor + 7
        try {
          return await tryOnce(candidate)
        } catch {
          /* next */
        }
      }
      return tryOnce(0)
    })()
  }

  // -------------------------------------------------------------------------
  // geo assets
  // -------------------------------------------------------------------------

  geoState(): GeoState {
    const geo = host.cores.geo()
    return {
      geoip: host.cores.geoInfo(geo.geoip),
      geosite: host.cores.geoInfo(geo.geosite),
      dir: geo.dir
    }
  }

  async importGeo(): Promise<ProxyState> {
    const targetDir = host.cores.geoDir()
    try {
      mkdirSync(targetDir, { recursive: true })
    } catch {
      /* ignore */
    }
    const picked = await dialog.showOpenDialog({
      title: '选择 geoip.dat / geosite.dat',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Geo 数据', extensions: ['dat'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return this.state()
    for (const file of picked.filePaths) {
      const name = basename(file).toLowerCase()
      if (name !== 'geoip.dat' && name !== 'geosite.dat') continue
      try {
        copyAtomic(file, join(targetDir, name))
      } catch (e) {
        this.appendLog(
          this.activeEngine,
          `[dola] 导入 ${name} 失败: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    host.cores.clearVersionCache()
    this.emitState()
    return this.state()
  }

  async updateGeo(): Promise<ProxyState> {
    const targetDir = host.cores.geoDir()
    try {
      mkdirSync(targetDir, { recursive: true })
    } catch {
      /* ignore */
    }
    const sources = [
      'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/latest',
      'https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release'
    ]
    const names = ['geoip.dat', 'geosite.dat'] as const
    let okCount = 0
    for (const name of names) {
      let succeeded = false
      for (const base of sources) {
        try {
          const buf = await download(`${base}/${name}`)
          if (buf.length < 1024) throw new Error('下载内容异常')
          copyAtomicBuffer(buf, join(targetDir, name))
          succeeded = true
          okCount++
          this.appendLog(this.activeEngine, `[dola] ${name} 已更新 (${fmtSize(buf.length)})`)
          break
        } catch (e) {
          this.appendLog(
            this.activeEngine,
            `[dola] 从 ${hostOf(base)} 下载 ${name} 失败: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      }
      if (!succeeded) {
        this.appendLog(this.activeEngine, `[dola] ${name} 更新失败，保留旧文件`)
      }
    }
    if (okCount > 0) host.cores.clearVersionCache()
    this.emitState()
    return this.state()
  }
}

// ---------------------------------------------------------------------------
// helpers (module level)
// ---------------------------------------------------------------------------

function isEngine(v: unknown): v is CoreId {
  return v === 'xray' || v === 'singbox' || v === 'mihomo'
}

function baseNode(): ProxyNode {
  return {
    id: '',
    name: '',
    protocol: 'vmess',
    engine: 'xray',
    server: '',
    port: 443,
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }
}

const PROTOCOLS: NodeProtocol[] = [
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

function sanitizeDraft(draft: Partial<ProxyNode>): Partial<ProxyNode> {
  const out: Partial<ProxyNode> = {}
  if (typeof draft.name === 'string') out.name = draft.name.trim().slice(0, 120)
  if (draft.protocol && PROTOCOLS.includes(draft.protocol)) out.protocol = draft.protocol
  if (isEngine(draft.engine)) out.engine = draft.engine
  if (typeof draft.server === 'string') out.server = draft.server.trim()
  const portNum = Number(draft.port)
  if (Number.isFinite(portNum) && portNum > 0 && portNum < 65536) out.port = Math.round(portNum)
  for (const key of [
    'uuid',
    'password',
    'method',
    'flow',
    'sni',
    'alpn',
    'fingerprint',
    'pinSHA256',
    'publicKey',
    'shortId',
    'spiderX',
    'path',
    'host',
    'serviceName',
    'obfs',
    'obfsParam',
    'extra',
    'remark',
    'group'
  ] as const) {
    const v = draft[key]
    if (typeof v === 'string') out[key] = v
  }
  if (draft.security) {
    const sec = draft.security
    if (sec === 'none' || sec === 'tls' || sec === 'reality' || sec === 'auto') out.security = sec
  }
  // per-node TLS trust override (Hysteria2 self-signed servers, stale pins…)
  if (typeof draft.allowInsecure === 'boolean') out.allowInsecure = draft.allowInsecure
  if (draft.network) {
    const nw = draft.network
    if (['tcp', 'ws', 'grpc', 'http', 'h2', 'quic'].includes(nw)) out.network = nw
  }
  const alterId = Number(draft.alterId)
  if (Number.isFinite(alterId)) out.alterId = Math.max(0, Math.round(alterId))
  for (const key of ['upMbps', 'downMbps'] as const) {
    const v = Number(draft[key])
    if (Number.isFinite(v) && v >= 0) out[key] = Math.round(v)
  }
  if (typeof draft.enabled === 'boolean') out.enabled = draft.enabled
  if (!out.name && out.server) out.name = `${out.server}`
  return out
}

function truncate(s: string): string {
  return s.length > 160 ? `${s.slice(0, 157)}…` : s
}

function fmtSize(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Windows wants `<local>` first and semicolon separators. */
export function normalizeBypass(raw: string): string {
  const parts = String(raw || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.some((p) => p === '<local>')) parts.unshift('<local>')
  return parts.join(';')
}

/**
 * Tell Windows the WinINET settings changed.
 *
 * Writing ProxyEnable/ProxyServer to the registry is NOT enough: WinINET caches
 * the configuration per process and only reloads it when an app calls
 * InternetSetOption(INTERNET_OPTION_SETTINGS_CHANGED / _REFRESH). Without that
 * call the UI can show "系统代理已开启" while every app keeps using the old
 * (or no) proxy — exactly the "UI 是亮的但无法代理" symptom.
 *
 * We therefore do it in-process via a tiny PowerShell shim, but resolve the
 * interpreter explicitly: `powershell.exe` is frequently absent from PATH (this
 * machine only has PowerShell 7, whose binary is `pwsh.exe`), and the old code
 * silently swallowed that spawn failure.
 */
async function notifyInternetSettingsChanged(): Promise<void> {
  if (process.platform !== 'win32') return

  // 1) Preferred: call wininet from a resolved PowerShell host.
  for (const exe of resolvePowerShellCandidates()) {
    const ok = await runPowerShell(exe)
    if (ok) return
  }

  // 2) Fallback: ask the shell to re-read per-user system parameters.
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      const child = spawn('rundll32.exe', ['user32.dll,UpdatePerUserSystemParameters'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.on('exit', done)
      child.on('error', done)
    } catch {
      done()
    }
    setTimeout(done, 4000).unref?.()
  })
}

/** Every PowerShell we can plausibly launch, most-preferred first. */
function resolvePowerShellCandidates(): string[] {
  const win = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  const out: string[] = []
  const legacy = join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(legacy)) out.push(legacy)
  // PowerShell 7 (pwsh) is fully capable of the same Add-Type call.
  out.push('pwsh.exe', 'powershell.exe')
  return out
}

/** Run the InternetSetOption shim in one interpreter; true when it executed. */
function runPowerShell(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const script = [
      '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\'',
      '$t = Add-Type -MemberDefinition $sig -Name WinINet -Namespace Dola Toolkit -PassThru',
      'foreach ($o in 39,37) { [void]$t::InternetSetOption([IntPtr]::Zero, $o, [IntPtr]::Zero, 0) }'
    ].join('; ')
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.on('exit', (code) => done(code === 0))
      child.on('error', () => done(false))
      setTimeout(() => done(false), 8000).unref?.()
    } catch {
      done(false)
    }
  })
}

function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('exit', () => resolve())
        killer.on('error', () => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          resolve()
        })
      } catch {
        resolve()
      }
      return
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    resolve()
  })
}

async function removeDir(dir: string): Promise<void> {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    await delay(50)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp dir, leaks are harmless */
    }
  }
}

function copyAtomicBuffer(buf: Buffer, target: string): void {
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, buf)
  renameSync(tmp, target)
}

function copyAtomic(from: string, to: string): void {
  copyAtomicBuffer(readFileSync(from), to)
}

function download(url: string, timeoutMs = 45000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const go = (target: string, redirects: number): void => {
      if (redirects > 5) return reject(new Error('重定向过多'))
      const req = httpsGet(target, timeoutMs, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, target).toString()
          return go(next, redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 256 * 1024 * 1024) {
            req.destroy()
            return reject(new Error('文件过大'))
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    }
    go(url, 0)
  })
}

function httpsGet(
  url: string,
  timeoutMs: number,
  onResponse: (res: import('node:http').IncomingMessage) => void
): import('node:http').ClientRequest {
  const isHttps = url.startsWith('https:')
  const mod = isHttps ? require('node:https') : require('node:http')
  const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Dola Toolkit/1.0' } }, onResponse) as import('node:http').ClientRequest
  req.on('timeout', () => req.destroy(new Error('请求超时')))
  return req
}

// ---------------------------------------------------------------------------
// Share link parsing
// ---------------------------------------------------------------------------

export function parseShareLink(line: string): NodeDraft | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) return parseJsonNode(trimmed)
  const m = /^([a-zA-Z0-9+]+):\/\/(.*)$/s.exec(trimmed)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const rest = m[2]
  switch (scheme) {
    case 'vmess':
      return parseVmess(rest)
    case 'vless':
      return parseVless(rest)
    case 'trojan':
      return parseTrojan(rest)
    case 'ss':
      return parseShadowsocks(rest)
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(rest)
    case 'tuic':
      return parseTuic(rest)
    case 'socks':
    case 'socks5':
    case 'socks4':
      return parseUserPass(rest, 'socks', 'SOCKS')
    case 'http':
    case 'https':
      return parseUserPass(rest, 'http', 'HTTP')
    default:
      return null
  }
}

function b64decode(s: string): string {
  const cleaned = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
  return Buffer.from(cleaned, 'base64').toString('utf8')
}

function urlParts(rest: string): { url: URL; name: string } {
  const hashIndex = rest.indexOf('#')
  const beforeHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest
  const rawName = hashIndex >= 0 ? rest.slice(hashIndex + 1) : ''
  const url = new URL(`scheme://${beforeHash}`)
  return { url, name: safeDecode(rawName) }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function parseJsonNode(text: string): NodeDraft | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const protocol = typeof obj.protocol === 'string' ? obj.protocol : 'vmess'
  if (!PROTOCOLS.includes(protocol as NodeProtocol)) return null
  return {
    name: typeof obj.name === 'string' ? obj.name : '导入节点',
    protocol: protocol as NodeProtocol,
    engine: isEngine(obj.engine) ? obj.engine : defaultEngineFor(protocol as NodeProtocol),
    server: typeof obj.server === 'string' ? obj.server : '',
    port: Number(obj.port) || 443,
    uuid: typeof obj.uuid === 'string' ? obj.uuid : undefined,
    password: typeof obj.password === 'string' ? obj.password : undefined,
    method: typeof obj.method === 'string' ? obj.method : undefined,
    security: normalizeSecurity(obj.security),
    sni: typeof obj.sni === 'string' ? obj.sni : typeof obj.servername === 'string' ? obj.servername : undefined,
    network: normalizeNet(obj.network),
    path: typeof obj.path === 'string' ? obj.path : undefined,
    host: typeof obj.host === 'string' ? obj.host : undefined,
    flow: typeof obj.flow === 'string' ? obj.flow : undefined
  }
}

function normalizeSecurity(v: unknown): NodeDraft['security'] {
  return v === 'tls' || v === 'reality' || v === 'none' ? v : undefined
}

function normalizeNet(v: unknown): NodeDraft['network'] {
  if (typeof v !== 'string') return undefined
  const nw = v.toLowerCase()
  if (nw === 'tcp' || nw === 'ws' || nw === 'grpc' || nw === 'http' || nw === 'h2' || nw === 'quic') return nw
  return undefined
}

function defaultEngineFor(p: NodeProtocol): CoreId {
  if (p === 'hysteria2' || p === 'tuic' || p === 'anytls') return 'singbox'
  if (p === 'wireguard') return 'mihomo'
  return 'xray'
}

function parseVmess(rest: string): NodeDraft | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(b64decode(rest)) as Record<string, unknown>
  } catch {
    return null
  }
  const host = strOf(raw.add) || strOf(raw.address)
  const port = Number(raw.port)
  if (!host || !Number.isFinite(port)) return null
  const tls = strOf(raw.tls)
  const net = normalizeNet(raw.net)
  const streamHost = strOf(raw.host)
  const tlsField = tls === 'tls' || tls === 'reality'
  return {
    name: strOf(raw.ps) || `${host}:${port}`,
    protocol: 'vmess',
    engine: 'xray',
    server: host,
    port,
    uuid: strOf(raw.id),
    alterId: Number(raw.aid) || 0,
    security: tlsField ? (tls === 'reality' ? 'reality' : 'tls') : 'none',
    sni: strOf(raw.sni) || streamHost || undefined,
    alpn: strOf(raw.alpn) || undefined,
    fingerprint: strOf(raw.fp) || undefined,
    publicKey: strOf(raw.pbk) || undefined,
    shortId: strOf(raw.sid) || undefined,
    spiderX: strOf(raw.spx) || undefined,
    network: net,
    path: strOf(raw.path) || undefined,
    host: streamHost || undefined,
    serviceName: strOf(raw.serviceName) || undefined,
  }
}

function parseVlessV2(rest: string): NodeDraft | null {
  const { url, name } = urlParts(rest)
  const uuid = url.username ? safeDecode(url.username) : ''
  const port = Number(url.port)
  if (!url.hostname || !uuid || !Number.isFinite(port)) return null
  const q = url.searchParams
  const security = normalizeSecurity(q.get('security'))
  return {
    name: name || `${url.hostname}:${port}`,
    protocol: 'vless',
    engine: 'xray',
    server: url.hostname,
    port,
    uuid,
    flow: q.get('flow') ?? undefined,
    security: security ?? 'none',
    sni: q.get('sni') ?? q.get('peer') ?? undefined,
    alpn: q.get('alpn') ?? undefined,
    fingerprint: q.get('fp') ?? undefined,
    publicKey: q.get('pbk') ?? undefined,
    shortId: q.get('sid') ?? undefined,
    spiderX: q.get('spx') ?? undefined,
    network: normalizeNet(q.get('type')),
    path: q.get('path') ?? undefined,
    host: q.get('host') ?? undefined,
    serviceName: q.get('serviceName') ?? undefined,
  }
}

function parseVless(rest: string): NodeDraft | null {
  return parseVlessV2(rest)
}

function parseTrojan(rest: string): NodeDraft | null {
  const { url, name } = urlParts(rest)
  const port = Number(url.port)
  if (!url.hostname || !Number.isFinite(port)) return null
  const q = url.searchParams
  return {
    name: name || `${url.hostname}:${port}`,
    protocol: 'trojan',
    engine: 'xray',
    server: url.hostname,
    port,
    password: safeDecode(url.password || url.username || ''),
    security: 'tls',
    sni: q.get('sni') ?? q.get('peer') ?? undefined,
    alpn: q.get('alpn') ?? undefined,
    fingerprint: q.get('fp') ?? undefined,
    network: normalizeNet(q.get('type')),
    path: q.get('path') ?? undefined,
    host: q.get('host') ?? undefined,
    serviceName: q.get('serviceName') ?? undefined
  }
}

function parseShadowsocks(rest: string): NodeDraft | null {
  // two dialects:
  //   ss://base64(method:password)@host:port#name
  //   ss://base64(method:password@host:port)#name
  const hashIndex = rest.indexOf('#')
  const beforeHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest
  const name = hashIndex >= 0 ? safeDecode(rest.slice(hashIndex + 1)) : ''
  const atIndex = beforeHash.lastIndexOf('@')
  let method = ''
  let password = ''
  let host = ''
  let port = 0
  let query = ''

  if (atIndex > 0) {
    const credPart = beforeHash.slice(0, atIndex)
    const cred = credPart.includes(':') ? safeDecode(credPart) : b64decode(credPart)
    const sep = cred.indexOf(':')
    if (sep <= 0) return null
    method = cred.slice(0, sep)
    password = cred.slice(sep + 1)
    const hostPart = beforeHash.slice(atIndex + 1)
    const qIdx = hostPart.indexOf('?')
    query = qIdx >= 0 ? hostPart.slice(qIdx + 1) : ''
    const hp = qIdx >= 0 ? hostPart.slice(0, qIdx) : hostPart
    const lastColon = hp.lastIndexOf(':')
    if (lastColon <= 0) return null
    host = hp.slice(0, lastColon).replace(/^\[|\]$/g, '')
    port = Number(hp.slice(lastColon + 1))
  } else {
    const decoded = b64decode(beforeHash)
    const at = decoded.lastIndexOf('@')
    if (at <= 0) return null
    const cred = decoded.slice(0, at)
    const hp = decoded.slice(at + 1)
    const sep = cred.indexOf(':')
    if (sep <= 0) return null
    method = cred.slice(0, sep)
    password = cred.slice(sep + 1)
    const qIdx = hp.indexOf('?')
    query = qIdx >= 0 ? hp.slice(qIdx + 1) : ''
    const hostPort = qIdx >= 0 ? hp.slice(0, qIdx) : hp
    const lastColon = hostPort.lastIndexOf(':')
    if (lastColon <= 0) return null
    host = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, '')
    port = Number(hostPort.slice(lastColon + 1))
  }
  if (!host || !Number.isFinite(port) || port <= 0) return null
  const params = new URLSearchParams(query)
  const plugin = params.get('plugin') ?? ''
  const pluginParts = plugin.split(';')
  const obfs = pluginParts[0] && /obfs/i.test(pluginParts[0]) ? 'http' : undefined
  return {
    name: name || `${host}:${port}`,
    protocol: 'shadowsocks',
    engine: 'xray',
    server: host,
    port,
    method,
    password,
    security: 'none',
    obfs,
    obfsParam: obfs ? pluginParts.slice(1).find((p) => p.startsWith('host='))?.slice(5) : undefined
  }
}

/** Hysteria2 pinSHA256 is hex; accept it with or without separators/case. */
function normalizePin(raw: string | null): string | undefined {
  if (!raw) return undefined
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  return hex.length === 64 ? hex : undefined
}

function parseHysteria2(rest: string): NodeDraft | null {
  const { url, name } = urlParts(rest)
  const port = Number(url.port)
  if (!url.hostname || !Number.isFinite(port)) return null
  const q = url.searchParams
  const password = safeDecode(url.password || url.username || '') || (q.get('auth') ?? '')
  return {
    name: name || `${url.hostname}:${port}`,
    protocol: 'hysteria2',
    engine: 'singbox',
    server: url.hostname,
    port,
    password,
    security: 'tls',
    sni: q.get('sni') ?? undefined,
    alpn: q.get('alpn') ?? undefined,
    allowInsecure: /^(1|true|yes)$/i.test(q.get('insecure') ?? q.get('allowInsecure') ?? q.get('skip-cert-verify') ?? ''),
    pinSHA256: normalizePin(q.get('pinSHA256') ?? q.get('pin') ?? q.get('pinsha256')),
    obfs: q.get('obfs') ?? undefined,
    obfsParam: q.get('obfs-password') ?? undefined,
    upMbps: q.get('up') ? Number(q.get('up')) / 1_000_000 : undefined,
    downMbps: q.get('down') ? Number(q.get('down')) / 1_000_000 : undefined
  }
}

function parseTuic(rest: string): NodeDraft | null {
  const { url, name } = urlParts(rest)
  const port = Number(url.port)
  if (!url.hostname || !Number.isFinite(port)) return null
  const q = url.searchParams
  return {
    name: name || `${url.hostname}:${port}`,
    protocol: 'tuic',
    engine: 'singbox',
    server: url.hostname,
    port,
    uuid: url.username ? safeDecode(url.username) : undefined,
    password: url.password ? safeDecode(url.password) : (q.get('password') ?? undefined),
    security: 'tls',
    sni: q.get('sni') ?? undefined,
    alpn: q.get('alpn') ?? 'h3'
  }
}

function parseUserPass(rest: string, protocol: NodeProtocol, label: string): NodeDraft | null {
  const { url, name } = urlParts(rest)
  const port = Number(url.port)
  if (!url.hostname || !Number.isFinite(port)) return null
  return {
    name: name || `${label} ${url.hostname}:${port}`,
    protocol,
    engine: 'xray',
    server: url.hostname,
    port,
    uuid: url.username ? safeDecode(url.username) : undefined,
    password: url.password ? safeDecode(url.password) : undefined,
    security: 'none'
  }
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let managerInstance: ProxyManager | null = null

/** The shared manager; created on first use, after the host was injected. */
export function proxyManagerRef(): ProxyManager {
  if (!managerInstance) managerInstance = new ProxyManager()
  return managerInstance
}

export { ProxyManager }

export function isProxyManagerReady(): boolean {
  try {
    return Boolean(proxyManager.state())
  } catch {
    return false
  }
}


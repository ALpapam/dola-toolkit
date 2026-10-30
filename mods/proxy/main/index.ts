// ---------------------------------------------------------------------------
// Dola Toolkit — proxy IPC
// ---------------------------------------------------------------------------

import type { ModHostApi } from '../../../src/main/modService'
import { IPC } from '@shared/channels'
import type {
  CoreId,
  CoreLogEvent,
  CoreStatus,
  EngineCapability,
  GeoState,
  ImportLinksResult,
  NodeTestResult,
  ProxyNode,
  ProxySettings,
  ProxyState
} from '@shared/types'
import { proxyManagerRef, setProxyHost, type ProxyManager } from './manager'
import {
  applyStagedCores,
  checkCoreUpdates,
  setUpdateChannel,
  hasStagedCores,
  readStagedCores,
  stageCoreUpdate,
  writeStagedCores
} from './coreUpdate'
import type { CoreId, StagedCoreInfo } from '@shared/types'

/**
 * The shared manager.
 *
 * Resolved inside register() once the host has been injected — taking the function
 * reference here would leave `proxyManager.onState` undefined.
 */
let proxyManager: ProxyManager

/** the mixed port while a core is running (updates tunnel through it) */
function activePort(): number | null {
  const state = proxyManagerRef().state()
  return state.engines.some((e) => e.running) ? state.settings.mixedPort : null
}

/** staged record → the shape the UI consumes */
function toStagedInfo(s: {
  engine: CoreId
  label: string
  version: string
  size: number
  sha256: string
  targetPath: string
}): StagedCoreInfo {
  return {
    engine: s.engine,
    label: s.label,
    version: s.version,
    size: s.size,
    sha256: s.sha256,
    targetPath: s.targetPath
  }
}

let wired = false

/** Wire manager events to the renderer exactly once. */
function wireEvents(host: ModHostApi): void {
  if (wired) return
  wired = true
  proxyManager.onState((state: ProxyState) => host.ipc.broadcast('state-changed', state))
  proxyManager.onLog((event: CoreLogEvent) => host.ipc.broadcast('log', event))
}

function asCoreId(v: unknown): CoreId | null {
  return v === 'xray' || v === 'singbox' || v === 'mihomo' ? v : null
}

export function register(dola: ModHostApi): void {
  const host = dola
  // honour the app's 下载渠道 setting: GitHub direct is unusable on many networks
  const channel = dola.settings.get().general?.downloadChannel
  setUpdateChannel(channel === 'mirror' ? 'mirror' : 'github')
  setProxyHost(dola)
  proxyManager = proxyManagerRef()
  wireEvents(dola)

  host.ipc.handle('state', (): ProxyState => proxyManager.state())

  host.ipc.handle('engines', async (): Promise<EngineCapability[]> => {
    try {
      return await proxyManager.engines()
    } catch {
      return []
    }
  })

  host.ipc.handle('save-node', (draft: unknown): ProxyNode | null => {
    if (typeof draft !== 'object' || draft === null) return null
    const d = draft as Partial<ProxyNode> & { id?: string }
    try {
      return proxyManager.saveNode(d)
    } catch (e) {
      host.log('error', `save-node: ${e instanceof Error ? e.stack : String(e)}`)
      return null
    }
  })

  host.ipc.handle('delete-node', (id: unknown): void => {
    if (typeof id !== 'string' || !id) return
    try {
      proxyManager.deleteNode(id)
    } catch {
      /* ignore */
    }
  })

  host.ipc.handle('import-links', (text: unknown): ImportLinksResult => {
    if (typeof text !== 'string') return { added: [], failed: [] }
    try {
      return proxyManager.importLinks(text)
    } catch (e) {
      host.log('error', `import-links: ${e instanceof Error ? e.stack : String(e)}`)
      return { added: [], failed: [{ link: '', reason: '导入失败' }] }
    }
  })

  host.ipc.handle('select-node', (id: unknown): ProxyState => {
    const nodeId = typeof id === 'string' && id ? id : null
    try {
      return proxyManager.selectNode(nodeId)
    } catch {
      return proxyManager.state()
    }
  })

  host.ipc.handle('start', async (): Promise<CoreStatus> => {
    try {
      return await proxyManager.start()
    } catch (e) {
      return {
        engine: dola.settings.get().proxy.defaultEngine,
        available: false,
        version: null,
        running: false,
        pid: null,
        nodeId: null,
        startedAt: null,
        error: e instanceof Error ? e.message : '启动失败',
        mixedPort: dola.settings.get().proxy.mixedPort,
        logs: []
      }
    }
  })

  host.ipc.handle('stop', async (): Promise<CoreStatus> => {
    try {
      return await proxyManager.stop()
    } catch (e) {
      return {
        engine: proxyManager.state().activeEngine,
        available: false,
        version: null,
        running: false,
        pid: null,
        nodeId: null,
        startedAt: null,
        error: e instanceof Error ? e.message : '停止失败',
        mixedPort: dola.settings.get().proxy.mixedPort,
        logs: []
      }
    }
  })

  host.ipc.handle('test-node', async (id: unknown): Promise<NodeTestResult> => {
    const nodeId = typeof id === 'string' ? id : ''
    if (!nodeId) {
      return { nodeId: '', ok: false, delayMs: null, exitIp: null, country: null, error: '缺少节点 id' }
    }
    try {
      return await proxyManager.testNode(nodeId)
    } catch (e) {
      return {
        nodeId,
        ok: false,
        delayMs: null,
        exitIp: null,
        country: null,
        error: e instanceof Error ? e.message : '测试失败'
      }
    }
  })

  host.ipc.handle('system-proxy', async (on: unknown): Promise<boolean> => {
    try {
      return await proxyManager.setSystemProxy(on === true)
    } catch {
      return false
    }
  })

  host.ipc.handle('import-geo', async (): Promise<ProxyState> => {
    try {
      return await proxyManager.importGeo()
    } catch {
      return proxyManager.state()
    }
  })

  host.ipc.handle('update-geo', async (): Promise<ProxyState> => {
    try {
      dola.cores.clearVersionCache()
      return await proxyManager.updateGeo()
    } catch {
      return proxyManager.state()
    }
  })

  host.ipc.handle('clear-logs', (engine: unknown): void => {
    const id = asCoreId(engine)
    if (!id) return
    try {
      proxyManager.clearLogs(id)
    } catch {
      /* ignore */
    }
  })

  // Extra (not in the frozen channel list): surfaces the current geo state
  // without a full proxy:state round-trip. Kept out of the preload contract.
  host.ipc.handle('geo-state', (): GeoState => proxyManager.geoState())

  /* ---- handlers the application core calls (tray, quit, settings, updates) ---- */

  host.ipc.handle('toggle', async (): Promise<CoreStatus> => {
    const running = proxyManager.state().engines.some((e) => e.running)
    return running ? proxyManager.stop() : proxyManager.start()
  })

  /** Mixed port while a core is running, else null. Used to route update downloads. */
  host.ipc.handle('active-port', (): number | null => {
    const state = proxyManager.state()
    const running = state.engines.some((e) => e.running)
    return running ? state.settings.mixedPort : null
  })

  host.ipc.handle('apply-settings', async (before: unknown, next: unknown): Promise<void> => {
    void before
    if (next && typeof next === 'object') await onProxySettingsChanged(next as ProxySettings)
  })

  /** Re-read the node store after the settings window replaced it. */
  host.ipc.handle('reload', (): void => proxyManager.reload())

  /* ---- core updates (this feature owns them now) ---- */

  host.ipc.handle('check-core-updates', async () => {
    try {
      return await checkCoreUpdates(activePort())
    } catch {
      return []
    }
  })

  host.ipc.handle('stage-core', async (engine: unknown, channel: unknown) => {
    const id = engine as CoreId
    if (!['xray', 'singbox', 'mihomo'].includes(id)) return { ok: false, error: '未知内核' }
    void channel
    try {
      const { staged } = await stageCoreUpdate(id, (percent) => host.ipc.broadcast('update-progress', { kind: 'core', engine: id, percent, state: 'downloading' }), activePort())
      host.ipc.broadcast('update-progress', { kind: 'core', engine: id, percent: 100, state: 'done' })
      return { ok: true, staged: toStagedInfo(staged), needsRestart: true }
    } catch (e) {
      const message = e instanceof Error ? ((e.stack ?? e.message) || '下载失败') : '下载失败'
      host.ipc.broadcast('update-progress', { kind: 'core', engine: id, percent: 0, state: 'error', message })
      return { ok: false, error: message }
    }
  })

  host.ipc.handle('stage-all-cores', async () => {
    const staged: StagedCoreInfo[] = []
    const failed: { engine: string; error: string }[] = []
    try {
      const list = await checkCoreUpdates(activePort())
      for (const item of list.filter((c) => c.updateAvailable && c.assetUrl)) {
        try {
          const { staged: one } = await stageCoreUpdate(
            item.engine,
            (percent) =>
              host.ipc.broadcast('update-progress', { kind: 'core', engine: item.engine, percent, state: 'downloading' }),
            activePort()
          )
          staged.push(toStagedInfo(one))
        } catch (e) {
          const message = e instanceof Error ? e.message : '下载失败'
          host.ipc.broadcast('update-progress', { kind: 'core', engine: item.engine, percent: 0, state: 'error', message })
          failed.push({ engine: item.label, error: message })
        }
      }
    } catch (e) {
      failed.push({ engine: '检查', error: e instanceof Error ? e.message : '检查失败' })
    }
    return { ok: failed.length === 0, staged, failed, needsRestart: staged.length > 0 }
  })

  host.ipc.handle('staged-cores', (): StagedCoreInfo[] => readStagedCores().map(toStagedInfo))

  host.ipc.handle('clear-staged', () => {
    for (const item of readStagedCores()) {
      try {
        host.fs.rm(item.stagedPath, { force: true })
        host.fs.rm(join(item.stagedPath, '..'), { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    writeStagedCores([])
    return { ok: true }
  })

  host.ipc.handle('apply-staged', () => {
    if (!hasStagedCores()) return { ok: false, error: '没有待应用的内核' }
    // the swap happens on the next launch: stop the core and restart the app
    const wasRunning = proxyManager.state().engines.some((e) => e.running)
    host.app.relaunch(wasRunning ? 'proxy' : null, async () => {
      await proxyManager.stop()
      await proxyManager.setSystemProxy(false)
    })
    return { ok: true }
  })

  host.ipc.handle('has-staged', () => hasStagedCores())

  /* ---- lifecycle ---- */

  // auto-start, and resume after an in-app update, now live with the feature
  dola.on('boot', async () => {
    /*
     * Apply staged core binaries before any core can start.
     *
     * This is the second half of the staged update: the download, checksum and
     * extraction happened in the previous session, so this is only a file move with
     * nothing locked. It used to live in the app's boot sequence; the feature owns it now.
     */
    try {
      const result = await applyStagedCores()
      if (result.applied.length > 0) host.log('info', `内核已更新：${result.applied.join(', ')}`)
      if (result.failed.length > 0) {
        host.log('error', `内核替换失败：${result.failed.map((f) => `${f.engine}: ${f.error}`).join('; ')}`)
      }
    } catch (e) {
      host.log('error', `内核替换异常：${e instanceof Error ? e.message : String(e)}`)
    }

    const resume = resumeRequested()
    const settings = dola.settings.get()
    if (resume || settings.proxy.autoStart) {
      try {
        await proxyManager.start()
      } catch {
        /* surfaced through state broadcasts */
      }
    }
  })

  dola.on('quit', async () => {
    try {
      await proxyManager.stop()
      await proxyManager.setSystemProxy(false)
    } catch {
      /* nothing useful to do while quitting */
    }
  })
}

/**
 * Whether the app asked for a post-update resume.
 *
 * The marker is written by the update flow before it restarts the app; the host exposes
 * it per mod id so no feature-specific flag lives in the core.
 */
function resumeRequested(): boolean {
  return (globalThis as { __DOLA_RESUME_MODS__?: string[] }).__DOLA_RESUME_MODS__?.includes('proxy') ?? false
}

/**
 * Called by the settings IPC when proxy settings change so that a running core
 * can pick up a new port / log level without a manual restart.
 */
export async function onProxySettingsChanged(next: ProxySettings): Promise<void> {
  const state = proxyManager.state()
  const running = state.engines.some((e) => e.running)
  if (!running) return
  if (next.mixedPort !== state.settings.mixedPort) {
    try {
      await proxyManager.stop()
      await proxyManager.start()
    } catch {
      /* surfaced through state */
    }
  }
}

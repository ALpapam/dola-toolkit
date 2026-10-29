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
import { proxyManagerRef, setProxyHost } from './manager'

/** the shared manager, resolved after the host was injected */
const proxyManager = proxyManagerRef

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
  setProxyHost(dola)
  wireEvents(dola)

  host.ipc.handle('state', (): ProxyState => proxyManager.state())

  host.ipc.handle('engines', async (): Promise<EngineCapability[]> => {
    try {
      return await proxyManager.engines()
    } catch {
      return []
    }
  })

  host.ipc.handle('save-node', (_e, draft: unknown): ProxyNode | null => {
    if (typeof draft !== 'object' || draft === null) return null
    const d = draft as Partial<ProxyNode> & { id?: string }
    try {
      return proxyManager.saveNode(d)
    } catch {
      return null
    }
  })

  host.ipc.handle('delete-node', (_e, id: unknown): void => {
    if (typeof id !== 'string' || !id) return
    try {
      proxyManager.deleteNode(id)
    } catch {
      /* ignore */
    }
  })

  host.ipc.handle('import-links', (_e, text: unknown): ImportLinksResult => {
    if (typeof text !== 'string') return { added: [], failed: [] }
    try {
      return proxyManager.importLinks(text)
    } catch {
      return { added: [], failed: [{ link: '', reason: '导入失败' }] }
    }
  })

  host.ipc.handle('select-node', (_e, id: unknown): ProxyState => {
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

  host.ipc.handle('test-node', async (_e, id: unknown): Promise<NodeTestResult> => {
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

  host.ipc.handle('system-proxy', async (_e, on: unknown): Promise<boolean> => {
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

  host.ipc.handle('clear-logs', (_e, engine: unknown): void => {
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

  host.ipc.handle('apply-settings', async (_e, before: unknown, next: unknown): Promise<void> => {
    void before
    if (next && typeof next === 'object') await onProxySettingsChanged(next as ProxySettings)
  })

  /** Re-read the node store after the settings window replaced it. */
  host.ipc.handle('reload', (): void => proxyManager.reload())

  /* ---- lifecycle ---- */

  // auto-start, and resume after an in-app update, now live with the feature
  dola.on('boot', async () => {
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

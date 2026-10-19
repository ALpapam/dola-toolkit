// ---------------------------------------------------------------------------
// Dola Toolkit — proxy IPC
// ---------------------------------------------------------------------------

import { ipcMain } from 'electron'
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
import { broadcast } from '../window'
import { getSettings } from '../store'
import { proxyManager } from '../proxy/manager'
import { clearBinaryCache } from '../proxy/binary'

let wired = false

/** Wire manager events to the renderer exactly once. */
function wireEvents(): void {
  if (wired) return
  wired = true
  proxyManager.onState((state: ProxyState) => broadcast(IPC.proxyStateChanged, state))
  proxyManager.onLog((event: CoreLogEvent) => broadcast(IPC.proxyLog, event))
}

function asCoreId(v: unknown): CoreId | null {
  return v === 'xray' || v === 'singbox' || v === 'mihomo' ? v : null
}

export function registerProxyIpc(): void {
  wireEvents()

  ipcMain.handle(IPC.proxyState, (): ProxyState => proxyManager.state())

  ipcMain.handle(IPC.proxyEngines, async (): Promise<EngineCapability[]> => {
    try {
      return await proxyManager.engines()
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.proxySaveNode, (_e, draft: unknown): ProxyNode | null => {
    if (typeof draft !== 'object' || draft === null) return null
    const d = draft as Partial<ProxyNode> & { id?: string }
    try {
      return proxyManager.saveNode(d)
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.proxyDeleteNode, (_e, id: unknown): void => {
    if (typeof id !== 'string' || !id) return
    try {
      proxyManager.deleteNode(id)
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle(IPC.proxyImportLinks, (_e, text: unknown): ImportLinksResult => {
    if (typeof text !== 'string') return { added: [], failed: [] }
    try {
      return proxyManager.importLinks(text)
    } catch {
      return { added: [], failed: [{ link: '', reason: '导入失败' }] }
    }
  })

  ipcMain.handle(IPC.proxySelectNode, (_e, id: unknown): ProxyState => {
    const nodeId = typeof id === 'string' && id ? id : null
    try {
      return proxyManager.selectNode(nodeId)
    } catch {
      return proxyManager.state()
    }
  })

  ipcMain.handle(IPC.proxyStart, async (): Promise<CoreStatus> => {
    try {
      return await proxyManager.start()
    } catch (e) {
      return {
        engine: getSettings().proxy.defaultEngine,
        available: false,
        version: null,
        running: false,
        pid: null,
        nodeId: null,
        startedAt: null,
        error: e instanceof Error ? e.message : '启动失败',
        mixedPort: getSettings().proxy.mixedPort,
        logs: []
      }
    }
  })

  ipcMain.handle(IPC.proxyStop, async (): Promise<CoreStatus> => {
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
        mixedPort: getSettings().proxy.mixedPort,
        logs: []
      }
    }
  })

  ipcMain.handle(IPC.proxyTestNode, async (_e, id: unknown): Promise<NodeTestResult> => {
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

  ipcMain.handle(IPC.proxySystemProxy, async (_e, on: unknown): Promise<boolean> => {
    try {
      return await proxyManager.setSystemProxy(on === true)
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.proxyImportGeo, async (): Promise<ProxyState> => {
    try {
      return await proxyManager.importGeo()
    } catch {
      return proxyManager.state()
    }
  })

  ipcMain.handle(IPC.proxyUpdateGeo, async (): Promise<ProxyState> => {
    try {
      clearBinaryCache()
      return await proxyManager.updateGeo()
    } catch {
      return proxyManager.state()
    }
  })

  ipcMain.handle(IPC.proxyClearLogs, (_e, engine: unknown): void => {
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
  ipcMain.handle('proxy:geo-state', (): GeoState => proxyManager.geoState())
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

// ---------------------------------------------------------------------------
// Dola Toolkit — update IPC
// ---------------------------------------------------------------------------

import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import type { AppUpdateInfo, CoreId, CoreUpdateInfo, UpdateProgress } from '@shared/types'
import {
  checkAppUpdate,
  checkCoreUpdates,
  downloadAppUpdate,
  installAppUpdate,
  openReleasesPage,
  takePendingUpdate,
  updateCore
} from '../updates'
import { proxyManager } from '../proxy/manager'
import { markResumeProxyAfterRestart, relaunchApp } from '../resume'

/**
 * Restarts shortly after the reply reaches the renderer, so the UI can show the
 * "已更新，正在重启" state instead of the window vanishing mid-toast.
 */
let relaunchTimer: NodeJS.Timeout | null = null
function scheduleRelaunch(delayMs = 1500): void {
  if (relaunchTimer) return
  relaunchTimer = setTimeout(() => {
    relaunchTimer = null
    const port = ((): number => {
      try {
        return proxyManager.state().settings.mixedPort
      } catch {
        return 7897
      }
    })()
    // cores must be gone before the new process starts, or it cannot bind the port
    void relaunchApp(async () => {
      await proxyManager.stop()
    }, port)
  }, delayMs)
}

function emit(progress: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateProgress, progress)
  }
}

/**
 * Stops a core only when it is the one whose executable is about to be replaced.
 *
 * The previous version stopped the proxy unconditionally, so updating Xray while
 * the user was browsing through sing-box tore down a working connection for no
 * reason — the two cores do not share files.
 */
async function stopCoreIfRunning(engine: CoreId): Promise<boolean> {
  try {
    const running = proxyManager.state().engines.find((e) => e.engine === engine && e.running)
    if (!running) return false
    await proxyManager.stop()
    return true
  } catch {
    return false
  }
}

export function registerUpdatesIpc(): void {
  ipcMain.handle(IPC.updateCheckApp, async (): Promise<AppUpdateInfo> => {
    try {
      return await checkAppUpdate()
    } catch (e) {
      return {
        current: app.getVersion(),
        latest: null,
        updateAvailable: false,
        channel: 'github',
        downloadUrl: null,
        notes: null,
        publishedAt: null,
        error: e instanceof Error ? e.message : '检查失败'
      }
    }
  })

  ipcMain.handle(IPC.updateCheckCores, async (): Promise<CoreUpdateInfo[]> => {
    try {
      return await checkCoreUpdates()
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.updateDownloadApp, async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      let last = -1
      const path = await downloadAppUpdate((percent) => {
        if (percent !== last) {
          last = percent
          emit({ kind: 'app', percent, state: 'downloading' })
        }
      })
      emit({ kind: 'app', percent: 100, state: 'done' })
      return { ok: true, path }
    } catch (e) {
      const message = e instanceof Error ? e.message : '下载失败'
      emit({ kind: 'app', percent: 0, state: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateInstallApp, async (_e, installerPath: unknown) => {
    if (typeof installerPath !== 'string' || !installerPath) return { ok: false, error: '缺少安装包路径' }
    try {
      await installAppUpdate(installerPath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '安装失败' }
    }
  })

  ipcMain.handle(IPC.updateCore, async (_e, engine: unknown) => {
    const id = engine as CoreId
    if (!['xray', 'singbox', 'mihomo'].includes(id)) return { ok: false, error: '未知内核' }
    try {
      // only THIS core's exe is locked; stopping every core tore down a running
      // proxy that had nothing to do with the update
      const wasRunning = await stopCoreIfRunning(id)
      let last = -1
      const path = await updateCore(id, (percent) => {
        if (percent !== last) {
          last = percent
          emit({ kind: 'core', engine: id, percent, state: 'downloading' })
        }
      })
      emit({ kind: 'core', engine: id, percent: 100, state: 'done' })
      /*
       * Restart so the new binary is used from a clean process.
       *
       * The flag must record whether ANY core is still running after the update, not
       * just whether this one had to be stopped: updating Xray while sing-box serves
       * traffic stops nothing, yet the proxy still needs to come back after the
       * restart. Reading the state after the update is also the only way to know the
       * sing-box case correctly.
       */
      const anyRunning = proxyManager.state().engines.some((e) => e.running) || wasRunning
      markResumeProxyAfterRestart(anyRunning)
      scheduleRelaunch()
      return { ok: true, path }
    } catch (e) {
      const message = e instanceof Error ? e.message : '更新失败'
      emit({ kind: 'core', engine: id, percent: 0, state: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateAllCores, async () => {
    const updated: string[] = []
    const failed: { engine: string; error: string }[] = []
    try {
      const list = await checkCoreUpdates()
      const behind = list.filter((c) => c.updateAvailable && c.assetUrl)
      // stop only when the running core is among those being replaced
      const running = proxyManager.state().engines.find((e) => e.running)?.engine
      const stoppedRunning = Boolean(running && behind.some((c) => c.engine === running))
      if (stoppedRunning) {
        await proxyManager.stop()
      }
      for (const item of behind) {
        try {
          let last = -1
          await updateCore(item.engine, (percent) => {
            if (percent !== last) {
              last = percent
              emit({ kind: 'core', engine: item.engine, percent, state: 'downloading' })
            }
          })
          emit({ kind: 'core', engine: item.engine, percent: 100, state: 'done' })
          updated.push(item.label)
        } catch (e) {
          const message = e instanceof Error ? e.message : '更新失败'
          emit({ kind: 'core', engine: item.engine, percent: 0, state: 'error', message })
          failed.push({ engine: item.label, error: message })
        }
      }
      if (updated.length > 0) {
        markResumeProxyAfterRestart(stoppedRunning)
        scheduleRelaunch()
      }
    } catch (e) {
      failed.push({ engine: '检查', error: e instanceof Error ? e.message : '更新失败' })
    }
    return { updated, failed }
  })

  ipcMain.handle(IPC.updateTakePending, () => takePendingUpdate())

  ipcMain.handle(IPC.updateOpenReleases, () => {
    openReleasesPage()
    return true
  })
}

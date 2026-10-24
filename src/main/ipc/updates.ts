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

  ipcMain.handle(IPC.updateInstallApp, async (_e, installerPath: unknown, targetVersion?: unknown) => {
    if (typeof installerPath !== 'string' || !installerPath) return { ok: false, error: '缺少安装包路径' }
    try {
      await installAppUpdate(installerPath, typeof targetVersion === 'string' ? targetVersion : undefined)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '安装失败' }
    }
  })

  ipcMain.handle(IPC.updateCore, async (_e, engine: unknown) => {
    const id = engine as CoreId
    if (!['xray', 'singbox', 'mihomo'].includes(id)) return { ok: false, error: '未知内核' }
    try {
      /*
       * Download FIRST, stop the core only to swap the binary.
       *
       * Stopping up front meant the whole transfer went out over the direct route:
       * slow, and the proxy button sat greyed out while the tunnel was perfectly
       * healthy. The proxy now stays up for the download (which then tunnels through
       * it) and is released for the few milliseconds the file swap needs.
       */
      const proxyWasUp = proxyManager.state().engines.some((e) => e.running)
      let stopped = false
      let last = -1
      const path = await updateCore(
        id,
        (percent) => {
          if (percent !== last) {
            last = percent
            emit({ kind: 'core', engine: id, percent, state: 'downloading' })
          }
        },
        async () => {
          // only the core that owns this exe has to let go of it
          stopped = (await stopCoreIfRunning(id)) || stopped
        }
      )
      emit({ kind: 'core', engine: id, percent: 100, state: 'done' })
      // a restart applies the new binary; bring the proxy back if it was up before
      markResumeProxyAfterRestart(proxyWasUp)
      void stopped
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
    let proxyWasUp = false
    try {
      const list = await checkCoreUpdates()
      const behind = list.filter((c) => c.updateAvailable && c.assetUrl)

      /*
       * Download everything first, stop the proxy only when a swap needs the exe.
       *
       * Stopping before the downloads made the whole batch go out over the direct
       * route — the slow update and the greyed-out proxy button the user saw. Each
       * `prepare` callback runs just before that engine's binary is replaced, and
       * only if that engine is the one currently running.
       */
      const running = proxyManager.state().engines.find((e) => e.running)?.engine
      proxyWasUp = Boolean(running)

      for (const item of behind) {
        try {
          let last = -1
          await updateCore(
            item.engine,
            (percent) => {
              if (percent !== last) {
                last = percent
                emit({ kind: 'core', engine: item.engine, percent, state: 'downloading' })
              }
            },
            async () => {
              // nothing to stop unless the engine we are replacing is the live one
              if (running === item.engine) await proxyManager.stop()
            }
          )
          emit({ kind: 'core', engine: item.engine, percent: 100, state: 'done' })
          updated.push(item.label)
        } catch (e) {
          const message = e instanceof Error ? e.message : '更新失败'
          emit({ kind: 'core', engine: item.engine, percent: 0, state: 'error', message })
          failed.push({ engine: item.label, error: message })
        }
      }

      if (updated.length > 0) {
        /*
         * Restart only when something was actually replaced.
         *
         * The resume flag records whether the proxy was up BEFORE the update — not
         * whether this call stopped it. Using the narrower value meant a batch that
         * did not need to stop anything restarted without bringing the proxy back.
         */
        markResumeProxyAfterRestart(proxyWasUp)
        scheduleRelaunch()
      }
    } catch (e) {
      failed.push({ engine: '检查', error: e instanceof Error ? e.message : '更新失败' })
      // never leave the user offline after a partial run
      if (proxyWasUp) markResumeProxyAfterRestart(true)
    }
    return { updated, failed }
  })

  ipcMain.handle(IPC.updateTakePending, () => takePendingUpdate())

  ipcMain.handle(IPC.updateOpenReleases, () => {
    openReleasesPage()
    return true
  })
}

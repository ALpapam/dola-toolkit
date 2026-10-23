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

function emit(progress: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateProgress, progress)
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
      // the exe is locked while the core runs, so stop it first
      await proxyManager.stop()
      let last = -1
      const path = await updateCore(id, (percent) => {
        if (percent !== last) {
          last = percent
          emit({ kind: 'core', engine: id, percent, state: 'downloading' })
        }
      })
      emit({ kind: 'core', engine: id, percent: 100, state: 'done' })
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
      // stop once: every replacement needs the exe unlocked
      if (behind.length > 0) await proxyManager.stop()
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

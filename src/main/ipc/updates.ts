// ---------------------------------------------------------------------------
// Dola Toolkit — update IPC
//
// Core updates are STAGED, not applied inline:
//   1. download + SHA-256 verify + extract into the staging folder
//   2. tell the UI it is ready and offer a restart (now or later)
//   3. the swap happens on the next launch, before any core starts
//
// That ordering keeps the proxy up during the download, and means a corrupt archive
// is rejected while the user is still looking at the dialog — a failed verification
// never reaches the "restart to finish" state.
// ---------------------------------------------------------------------------

import { rmSync } from 'node:fs'
import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import type { AppUpdateInfo, UpdateProgress } from '@shared/types'
import {
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  openReleasesPage,
  takePendingUpdate,
  viaUpdateChannel
} from '../updates'
import { logUpdate, revealUpdateLog, updateLogPath } from '../updateLog'

function emit(progress: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateProgress, progress)
  }
}

let relaunchTimer: NodeJS.Timeout | null = null

/**
 * Stages one core: download, verify, extract. The proxy is never stopped, because
 * nothing here touches a live binary.
 */

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

  ipcMain.handle(IPC.updateDownloadApp, async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      logUpdate('app.download.start')
      let last = -1
      const path = await downloadAppUpdate((percent) => {
        if (percent !== last) {
          last = percent
          emit({ kind: 'app', percent, state: 'downloading' })
        }
      })
      logUpdate('app.download.ok', path)
      emit({ kind: 'app', percent: 100, state: 'done' })
      return { ok: true, path }
    } catch (e) {
      const message = e instanceof Error ? e.message : '下载失败'
      logUpdate('app.download.fail', message)
      emit({ kind: 'app', percent: 0, state: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateInstallApp, async (_e, installerPath: unknown, targetVersion?: unknown) => {
    if (typeof installerPath !== 'string' || !installerPath) return { ok: false, error: '缺少安装包路径' }
    try {
      logUpdate('app.install.start', `${installerPath} → ${String(targetVersion ?? '')}`)
      await installAppUpdate(installerPath, typeof targetVersion === 'string' ? targetVersion : undefined)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : '安装失败'
      logUpdate('app.install.fail', message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateTakePending, () => takePendingUpdate())

  ipcMain.handle(IPC.updateOpenLog, () => revealUpdateLog())

  ipcMain.handle(IPC.updateLogPath, () => updateLogPath())

  ipcMain.handle(IPC.updateOpenReleases, () => {
    openReleasesPage()
    return true
  })
}

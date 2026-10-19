// ---------------------------------------------------------------------------
// Dola Toolkit — app-level IPC (window controls, info, shell helpers)
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from 'node:fs'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import type { AppInfo } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import { getLogsDir, getSettings } from '../store'
import { broadcast, getMainWindow, hideMainWindow } from '../window'
import { proxyManager } from '../proxy/manager'

function appInfo(): AppInfo {
  return {
    // `app.getVersion()` reports the Electron version when the app runs
    // unpackaged (or from a portable stub), so the product version is pinned in
    // @shared/version and only falls back to package metadata when it is real.
    version: APP_VERSION,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logsDir: safeLogsDir()
  }
}

function safeLogsDir(): string {
  try {
    return getLogsDir()
  } catch {
    return ''
  }
}

function isSafeExternal(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Only ever reveal paths that live inside our own data dir or an imported book. */
function isRevealable(target: unknown): target is string {
  if (typeof target !== 'string' || !target.trim()) return false
  if (!existsSync(target)) return false
  try {
    const userData = app.getPath('userData')
    if (target.startsWith(userData)) return true
  } catch {
    /* ignore */
  }
  // library imports may live outside userData; allow known document/media suffixes
  return /\.(epub|pdf|fb2|mobi|azw3|txt|rtf|zip|dat|json|log)$/i.test(target)
}

export function registerAppIpc(): void {
  ipcMain.handle(IPC.appInfo, () => appInfo())

  ipcMain.on(IPC.appQuit, () => {
    void (async () => {
      try {
        await proxyManager.stop()
        await proxyManager.setSystemProxy(false)
      } catch {
        /* keep quitting regardless */
      }
      app.quit()
    })()
  })

  ipcMain.on(IPC.appMinimize, () => {
    const win = getMainWindow()
    if (win) win.minimize()
  })

  ipcMain.on(IPC.appToggleMaximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(IPC.appClose, () => {
    // closeToTray: hide instead of destroying the window; the app stays alive so
    // proxies keep running. Everything else: a real close.
    let closeToTray = false
    try {
      closeToTray = getSettings().general.closeToTray
    } catch {
      closeToTray = false
    }
    const win = getMainWindow()
    if (closeToTray && win) {
      hideMainWindow()
      broadcast('app:hidden-to-background', true)
      return
    }
    app.quit()
  })

  ipcMain.handle(IPC.appOpenExternal, async (_e, url: unknown) => {
    if (!isSafeExternal(url)) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle(IPC.appShowItem, async (_e, target: unknown) => {
    if (!isRevealable(target)) return false
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle(IPC.appOpenLogs, async () => {
    const dir = safeLogsDir()
    if (!dir) return false
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    const err = await shell.openPath(dir)
    return err === ''
  })

  // Kept for API compatibility with the preload bridge; we draw our own chrome,
  // so there is no native overlay to recolor.
  ipcMain.on(IPC.appTitleBarTheme, (event, dark: unknown) => {
    const isDark = dark === true
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    try {
      win.setBackgroundColor(isDark ? '#141218' : '#FFFBFE')
    } catch {
      /* ignore */
    }
  })
}

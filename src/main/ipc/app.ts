// ---------------------------------------------------------------------------
// Dola Toolkit — app-level IPC (window controls, info, shell helpers)
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from 'node:fs'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import type { AppInfo } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import { getLogsDir, getSettings, patchSettings } from '../store'
import { broadcast, getMainWindow, hideMainWindow } from '../window'
import { proxyCall } from '../modService'
import { ensureTray, notifyHidden, trayInfo } from '../tray'

/** the "still running in the background" balloon is shown once per session */
let hiddenHintShown = false

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
        await proxyCall('stop')
        await proxyCall('system-proxy', false)
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

  /**
   * Performs the close: hide to tray, or really quit.
   * `closeToTray` also decides whether the proxy/sync keep running.
   */
  const performClose = (closeToTray: boolean): void => {
    const win = getMainWindow()
    if (closeToTray && win) {
      // The tray icon is what makes "hidden" recoverable: without it the window
      // would vanish and the process would be unreachable.
      ensureTray()
      hideMainWindow()
      broadcast('app:hidden-to-background', true)
      if (!hiddenHintShown) {
        hiddenHintShown = true
        notifyHidden()
      }
      return
    }
    app.quit()
  }

  ipcMain.on(IPC.appClose, () => {
    /*
     * First close asks instead of guessing.
     *
     * `closeToTray` alone cannot express "the user never chose": defaulting it
     * to false would quit on a close the user expected to be minimized, and
     * defaulting it to true would leave the app running invisibly. Until the
     * question has been answered once, the renderer shows a prompt and reports
     * back through appCloseResolve.
     */
    let general: { closeToTray: boolean; closeToTrayAsked: boolean } = {
      closeToTray: false,
      closeToTrayAsked: true
    }
    try {
      const g = getSettings().general
      general = { closeToTray: g.closeToTray, closeToTrayAsked: g.closeToTrayAsked === true }
    } catch {
      /* fall through with the defaults above */
    }
    if (!general.closeToTrayAsked) {
      broadcast(IPC.appCloseAsk)
      return
    }
    performClose(general.closeToTray)
  })

  ipcMain.handle(IPC.appCloseResolve, (_e, payload: unknown): boolean => {
    const choice = (payload ?? {}) as { closeToTray?: unknown; remember?: unknown }
    const closeToTray = choice.closeToTray === true
    if (choice.remember === true) {
      // Remembering the answer also updates the switch on the settings page, and
      // from then on closing follows it without asking again.
      try {
        const next = patchSettings({ general: { closeToTray, closeToTrayAsked: true } })
        broadcast(IPC.settingsChanged, next)
      } catch {
        /* still close even if persisting failed */
      }
    }
    performClose(closeToTray)
    return true
  })

  ipcMain.handle(IPC.appTrayAvailable, () => trayInfo())

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

  /*
   * Page-turn snapshot.
   *
   * The curl engine needs the sheet as pixels: it bends and shades the page
   * strip by strip, which is impossible with DOM transforms and cannot reach
   * into an epub.js iframe from the renderer. `capturePage` grabs what is
   * actually on screen (iframes included), so this works for every format.
   *
   * Returns a data URL, or null when the capture fails — the renderer then
   * draws a plain paper sheet so the animation still plays.
   */
  ipcMain.handle(IPC.appCapture, async (event, rect: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return null
    const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined
    try {
      const image = await win.webContents.capturePage({
        x: num(r?.x) ?? 0,
        y: num(r?.y) ?? 0,
        width: num(r?.width) ?? 0,
        height: num(r?.height) ?? 0
      })
      if (image.isEmpty()) return null
      return image.toDataURL()
    } catch {
      return null
    }
  })
}

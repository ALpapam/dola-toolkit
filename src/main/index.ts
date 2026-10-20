// ---------------------------------------------------------------------------
// Dola Toolkit — main entry (Electron main process)
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, nativeTheme, protocol } from 'electron'
import { IPC } from '@shared/channels'
import { initStore, getLogsDir, getSettings, onSettingsChange } from './store'
import { createMainWindow, getMainWindow, broadcast, showMainWindow } from './window'
import { computeMonet } from './monet'
import { proxyManager } from './proxy/manager'
import { registerAllIpc } from './ipc'

// ---------------------------------------------------------------------------
// Global crash guards — installed before anything else can throw.
// ---------------------------------------------------------------------------

let logsDir = ''
let crashLogReady = false

function writeCrashLog(kind: string, detail: unknown): void {
  try {
    if (!logsDir) {
      try {
        logsDir = join(app.getPath('userData'), 'logs')
        mkdirSync(logsDir, { recursive: true })
      } catch {
        return
      }
    }
    if (!crashLogReady) {
      crashLogReady = true
    }
    const line = `[${new Date().toISOString()}] [${kind}] ${
      detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)
    }\n`
    appendFileSync(join(logsDir, 'crash.log'), line, 'utf8')
  } catch {
    /* logging must never crash the app */
  }
}

process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err)
  console.error('[Dola Toolkit] uncaughtException:', err)
})

process.on('unhandledRejection', (reason) => {
  writeCrashLog('unhandledRejection', reason)
  console.error('[Dola Toolkit] unhandledRejection:', reason)
})

process.on('warning', (warn) => {
  writeCrashLog('warning', `${warn.name}: ${warn.message}`)
})

// ---------------------------------------------------------------------------
// App identity / single instance
// ---------------------------------------------------------------------------

/**
 * `app.disableHardwareAcceleration()` only takes effect before the app is ready,
 * long before `initStore()` runs, so the one setting it depends on is peeked at
 * from the settings file directly. Any failure is non-fatal: we simply keep the
 * GPU, which is the default anyway.
 */
function applyEarlyGpuPreference(): void {
  try {
    const file = join(app.getPath('userData'), 'settings.json')
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as { reader?: { gpuAcceleration?: unknown } }
    if (parsed?.reader?.gpuAcceleration === false) {
      app.disableHardwareAcceleration()
      console.log('[Dola Toolkit] GPU acceleration disabled by settings')
    }
  } catch {
    /* no settings file yet, or unreadable — keep the default (GPU on) */
  }
}

applyEarlyGpuPreference()

// The reader loads bundled + user-imported fonts from a custom scheme. It must
// be declared privileged *before* the app becomes ready, otherwise Chromium
// refuses to use it as a font source.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dola-font',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

app.setAppUserModelId('io.dola.toolkit')
app.setName('Dola Toolkit')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // also covers the "closeToTray hid the window" case
    showMainWindow()
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  bootstrap()
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootstrap(): void {
  let shuttingDown = false

  app.whenReady().then(
    async () => {
      logsDir = join(app.getPath('userData'), 'logs')
      try {
        mkdirSync(logsDir, { recursive: true })
      } catch {
        /* ignore */
      }
      mkdirSync(app.getPath('userData'), { recursive: true })

      // settings must exist before any window or IPC handler touches them
      initStore(app.getPath('userData'))
      logsDir = getLogsDir()

      // only one renderer is trusted: ours, loaded from file:// or the dev server
      app.on('web-contents-created', (_event, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
          if (/^https?:/i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
          return { action: 'deny' }
        })
        contents.on('will-attach-webview', (event) => event.preventDefault())
      })

      try {
        const { registerFontProtocol } = await import('./fonts')
        registerFontProtocol()
      } catch (e) {
        writeCrashLog('registerFontProtocol', e)
      }

      registerAllIpc()

      const win = createMainWindow(getSettings())
      applyThemeBackground()
      win.on('focus', () => {
        void refreshThemeIfWallpaperChanged()
      })

      // re-apply the persisted system-proxy state only if a core is running;
      // never silently hijack the OS proxy on boot.
      if (getSettings().proxy.autoStart) {
        void startProxyIfConfigured()
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow(getSettings())
        else showMainWindow()
      })
    },
    (err) => {
      writeCrashLog('whenReady', err)
      app.quit()
    }
  )

  app.on('window-all-closed', () => {
    // closeToTray keeps the app alive; otherwise follow platform conventions.
    let closeToTray = false
    try {
      closeToTray = getSettings().general.closeToTray
    } catch {
      closeToTray = false
    }
    if (closeToTray) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    void shutdown().finally(() => app.exit(0))
  })

  // persist debounced settings before the process disappears
  app.on('will-quit', () => {
    writeCrashLog('will-quit', 'process exiting')
  })

  app.on('quit', () => {
    /* last chance: nothing async is allowed here */
  })

  app.on('render-process-gone', (_event, _contents, details) => {
    writeCrashLog('render-process-gone', JSON.stringify(details))
  })

  app.on('child-process-gone', (_event, details) => {
    writeCrashLog('child-process-gone', JSON.stringify(details))
  })

  async function shutdown(): Promise<void> {
    try {
      await proxyManager.stop()
    } catch (e) {
      writeCrashLog('shutdown.stopProxy', e)
    }
    try {
      // make absolutely sure the OS proxy is not left pointing at a dead port
      await proxyManager.setSystemProxy(false)
    } catch (e) {
      writeCrashLog('shutdown.clearSystemProxy', e)
    }
    try {
      const { flushStore } = await import('./store')
      flushStore()
    } catch (e) {
      writeCrashLog('shutdown.flush', e)
    }
  }

  // -------------------------------------------------------------------------
  // theme helpers
  // -------------------------------------------------------------------------

  async function applyThemeBackground(): Promise<void> {
    try {
      const monet = await computeMonet(getSettings())
      const dark =
        getSettings().appearance.themeMode === 'dark' ||
        (getSettings().appearance.themeMode === 'system' && nativeTheme.shouldUseDarkColors)
      const { setWindowBackground } = await import('./window')
      setWindowBackground(dark ? monet.dark.surface : monet.light.surface)
      broadcast(IPC.themeChanged, monet)
    } catch (e) {
      writeCrashLog('applyThemeBackground', e)
    }
  }

  async function refreshThemeIfWallpaperChanged(): Promise<void> {
    try {
      const { wallpaperChanged } = await import('./monet')
      if (!(await wallpaperChanged())) return
      const monet = await computeMonet(getSettings(), true)
      const dark =
        getSettings().appearance.themeMode === 'dark' ||
        (getSettings().appearance.themeMode === 'system' && nativeTheme.shouldUseDarkColors)
      const { setWindowBackground } = await import('./window')
      setWindowBackground(dark ? monet.dark.surface : monet.light.surface)
      broadcast(IPC.themeChanged, monet)
    } catch {
      /* wallpaper probing is best effort */
    }
  }

  async function startProxyIfConfigured(): Promise<void> {
    try {
      const settings = getSettings()
      if (!settings.proxy.autoStart) return
      const state = proxyManager.state()
      if (!state.selectedNodeId) return
      await proxyManager.start()
    } catch (e) {
      writeCrashLog('autoStartProxy', e)
    }
  }

  // window close behaviour is owned by ipc/app.ts (closeToTray handling) but we
  // keep a Notification-based hint here for the second-instance path.
  onSettingsChange((settings) => {
    if (settings.general.closeToTray && getMainWindow()?.isVisible() === false) {
      try {
        new Notification({
          title: 'Dola Toolkit 仍在后台运行',
          body: '再次启动 Dola Toolkit 即可唤回窗口。'
        }).show()
      } catch {
        /* notifications may be disabled by the OS */
      }
    }
  })
}

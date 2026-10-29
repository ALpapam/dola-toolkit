// ---------------------------------------------------------------------------
// Dola Toolkit — main entry (Electron main process)
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, nativeTheme, protocol } from 'electron'
import { IPC } from '@shared/channels'
import { initStore, getLogsDir, getSettings, onSettingsChange } from './store'
import { createMainWindow, getMainWindow, broadcast, showMainWindow, hideMainWindow } from './window'
import { computeMonet } from './monet'
import { modServices, pendingResumeMods, proxyCall, registerModServiceIpc } from './modService'
import { registerAllIpc } from './ipc'
import { ensureTray, refreshTrayMenu, destroyTray } from './tray'
import { takeResumeProxy } from './resume'
import { logUpdate } from './updateLog'

// ---------------------------------------------------------------------------
// Global crash guards — installed before anything else can throw.
// ---------------------------------------------------------------------------

let logsDir = ''
/** cores replaced by the staged-update step, reported to the UI on first paint */
let stagedApplied: string[] = []
let stagedFailed: { engine: string; error: string }[] = []
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
    // mod bundles are loaded with <script src="dola-mod://…">, so the scheme has to be
    // standard+secure and CORS-enabled like the font one
    scheme: 'dola-mod',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
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

/**
 * Acquire the single-instance lock, waiting briefly if a restart is in flight.
 *
 * `app.relaunch()` starts the new process while the old one is still shutting down
 * and still holds the lock, so the newcomer used to take the "another instance is
 * running" branch and quit — the restart appeared to do nothing. Waiting a few
 * seconds only when a restart was requested fixes that without letting a genuine
 * second launch linger.
 */
const restartInFlight = process.argv.includes('--relaunch')
async function acquireSingleInstanceLock(): Promise<boolean> {
  if (app.requestSingleInstanceLock()) return true
  if (!restartInFlight) return false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (app.requestSingleInstanceLock()) return true
  }
  return false
}

void acquireSingleInstanceLock().then((gotLock) => {
  if (!gotLock) {
    app.quit()
    return
  }
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
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootstrap(): void {
  let shuttingDown = false
/** set once a real close is allowed, so the guard above stops intercepting */
let allowWindowDestroy = false
/** mod ids that should restart themselves after an in-app update */
let resumeMods: string[] = []

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

      /*
       * Apply staged core binaries before anything can start a core.
       *
       * This is the second half of the staged update: the download, checksum and
       * extraction all happened in the previous session, so this is only a file move
       * with nothing locked. It must run before `startProxyIfConfigured` below, or the
       * old binary would be loaded again.
       */

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
        const { registerModProtocol } = await import('./mods/protocol')
        registerModProtocol()
      } catch (e) {
        writeCrashLog('registerFontProtocol', e)
      }

      registerAllIpc()

      const win = createMainWindow(getSettings())
      applyThemeBackground()
      win.on('focus', () => {
        void refreshThemeIfWallpaperChanged()
      })

      /*
       * The tray must exist whenever the window can be hidden. It is created up
       * front when the user has already chosen "minimize to tray", and on demand
       * the first time the window is hidden — otherwise hiding would leave a
       * process with no window and no way back.
       */
      if (getSettings().general.closeToTray) ensureTray()
      // the tray follows whatever the proxy mod broadcasts; the core keeps no state
      modServices.subscribe('proxy', 'state-changed', () => refreshTrayMenu())

      /*
       * Native close (Alt+F4, taskbar context menu) must follow the same policy as
       * the custom title bar. Without this the window would be destroyed while the
       * process kept running, leaving a tray icon whose 「显示」 could not restore
       * anything.
       */
      win.on('close', (event) => {
        if (allowWindowDestroy || shuttingDown) return
        let closeToTray = false
        let asked = false
        try {
          const g = getSettings().general
          closeToTray = g.closeToTray
          asked = g.closeToTrayAsked === true
        } catch {
          /* treat as "not asked yet" */
        }
        if (!asked) {
          // Let the renderer ask; make sure the prompt is actually on screen.
          event.preventDefault()
          showMainWindow()
          broadcast(IPC.appCloseAsk)
          return
        }
        if (closeToTray) {
          event.preventDefault()
          ensureTray()
          hideMainWindow()
          broadcast('app:hidden-to-background', true)
          return
        }
        allowWindowDestroy = true
      })

      /*
       * Load the mod services, then let them start themselves.
       *
       * The resume marker is handed over as a plain list of mod ids: a feature that had
       * to stop for an in-app update restarts even when 开机自启 is off, and the core
       * stays unaware of what those features are.
       */
      // a mod that asked to be resumed after its own restart
      if (pendingResumeMods.length > 0) resumeMods = pendingResumeMods
      else if (takeResumeProxy()) resumeMods = ['proxy']
      ;(globalThis as { __DOLA_RESUME_MODS__?: string[] }).__DOLA_RESUME_MODS__ = resumeMods
      await modServices.loadAll(join(app.getPath('userData'), 'mods'))
      void emitBoot()

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
      // every mod service gets a chance to clean up (the proxy stops its core and
      // clears the system proxy here)
      await modServices.emit('quit')
    } catch (e) {
      writeCrashLog('shutdown.modServices', e)
    }
    try {
      const { flushStore } = await import('./store')
      flushStore()
    } catch (e) {
      writeCrashLog('shutdown.flush', e)
    }
    try {
      // remove the notification-area icon before the process goes away, or a
      // ghost icon can linger until the user hovers over it
      destroyTray()
    } catch (e) {
      writeCrashLog('shutdown.tray', e)
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

  /**
   * Brings the proxy back up on launch.
   *
   * `force` is used by the resume path: an in-app core update restarts the app, and
   * the user's choice to keep their proxy running must not depend on the separate
   * 「启动时自动开启」 setting — which is exactly what the early `autoStart` return
   * below used to break, leaving them silently offline after an update.
   */
  /*
   * Feature start-up belongs to the feature: the mod's `boot` hook decides whether to
   * auto-start and consumes the resume-after-update marker. The core only announces the
   * event.
   */
  async function emitBoot(): Promise<void> {
    try {
      await modServices.emit('boot')
    } catch (e) {
      writeCrashLog('modServices.boot', e)
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

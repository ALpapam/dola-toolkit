// ---------------------------------------------------------------------------
// Dola Toolkit — main window factory
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, nativeTheme, shell } from 'electron'
import type { Settings } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let cachedBg = '#FFFBFE'

const DEFAULT_BG_LIGHT = '#FFFBFE'
const DEFAULT_BG_DARK = '#141218'

/** Pick the surface color so the window does not flash white on launch. */
export function backgroundColorFor(settings: Settings): string {
  const mode = settings.appearance.themeMode
  const dark =
    mode === 'dark' ||
    (mode === 'system' && nativeTheme.shouldUseDarkColors === true)
  cachedBg = dark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT
  return cachedBg
}

/** Applied by the theme IPC once Monet has resolved. */
export function setWindowBackground(hex: string): void {
  cachedBg = hex
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setBackgroundColor(hex)
  } catch {
    /* ignore */
  }
}

export function getWindowBackground(): string {
  return cachedBg
}

function preloadPath(): string {
  // electron-vite emits out/preload/index.js next to out/main/index.js
  return join(__dirname, '../preload/index.js')
}

function rendererUrl(): string | null {
  const env = process.env['ELECTRON_RENDERER_URL']
  return env && env.trim() ? env.trim() : null
}

function indexHtmlPath(): string {
  return join(__dirname, '../renderer/index.html')
}

export function createMainWindow(settings?: Settings): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const bg = settings ? backgroundColorFor(settings) : cachedBg
  const preload = preloadPath()

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // A 620px floor lets the reader reach its single-page ("narrow") layout,
    // which is what the design calls for on tall/skinny windows.
    minWidth: 620,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: bg,
    autoHideMenuBar: true,
    title: 'Dola Toolkit',
    icon: resolveIcon(),
    webPreferences: {
      preload: existsSync(preload) ? preload : undefined,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
      // Chromium throttles timers/rAF for backgrounded or minimized windows.
      // epub.js renders chapters through a requestAnimationFrame-driven queue,
      // so throttling makes "open book" hang forever whenever the window is not
      // focused — the reader must keep working while the user is elsewhere.
      backgroundThrottling: false
    }
  })

  win.removeMenu()

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  // never let the renderer navigate away or spawn windows
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalIfSafe(url)
  })

  try {
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternalIfSafe(url)
      return { action: 'deny' }
    })
  } catch {
    /* older/odd webContents implementations — navigation guard above still holds */
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Dola Toolkit] renderer gone:', details.reason, details.exitCode)
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // final safety net: block any permission request the UI never asked for
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
      callback(allowed)
    })
  } catch {
    /* not fatal */
  }

  const devUrl = rendererUrl()
  const file = indexHtmlPath()
  if (devUrl) {
    void win.loadURL(devUrl)
    if (process.env['NODE_ENV'] !== 'production') {
      win.webContents.once('did-finish-load', () => {
        try {
          win.webContents.openDevTools({ mode: 'detach' })
        } catch {
          /* devtools unavailable in some builds */
        }
      })
    }
  } else if (existsSync(file)) {
    void win.loadFile(file)
  } else {
    // Renderer not built yet (parallel development) — show a readable placeholder
    // instead of crashing the main process.
    const escaped = JSON.stringify(file)
    void win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!doctype html><html><head><meta charset="utf-8"><title>Dola Toolkit</title></head>
         <body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};
         color:#6750A4;font:600 18px/1.6 system-ui,'Segoe UI',sans-serif;text-align:center">
         <div><div style="font-size:40px">Dola Toolkit</div>
         <div style="font-weight:400;font-size:14px;opacity:.75;margin-top:8px">
         渲染进程尚未构建 — 请运行 <code>npm run dev</code><br>${escaped}</div></div></body></html>`
      )}`
    )
    console.warn('[Dola Toolkit] renderer bundle missing, showing placeholder:', file)
  }

  mainWindow = win
  return win
}

function resolveIcon(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(process.resourcesPath ?? '', 'icon.ico'),
    join(__dirname, '../../build/icon.ico')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return undefined
}

function openExternalIfSafe(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void shell.openExternal(url)
  } catch {
    /* not a URL — ignore */
  }
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* window may be mid-destruction */
    }
  }
}

export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function hideMainWindow(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.hide()
}

export function toggleMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) hideMainWindow()
  else showMainWindow()
}

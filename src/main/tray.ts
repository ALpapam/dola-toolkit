// ---------------------------------------------------------------------------
// Dola Toolkit — system tray
//
// "Minimize to tray" used to only call `win.hide()`, which left the app running
// with no visible window and no way back except relaunching it. The tray icon
// gives it a home: click to restore, right-click for status and quit.
// ---------------------------------------------------------------------------

import { app, BrowserWindow, Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getMainWindow, showMainWindow } from './window'
import { proxyCall, modServices } from './modService'
import type { ProxyState } from '@shared/types'

let tray: Tray | null = null
/** signature of what the menu currently shows, to skip pointless rebuilds */
let lastMenuKey = ''
/** real size of the image handed to the tray — an empty image is invisible */
let trayIconSize: { width: number; height: number } | null = null

/** Reads the best available icon and scales it for the 16px tray slot. */
function trayIcon(): NativeImage {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(process.resourcesPath ?? '', 'icon.ico')
  ]
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) continue
    // Windows renders the notification area at 16px (32 on high DPI).
    const size = process.platform === 'win32' ? 16 : 22
    return img.resize({ width: size, height: size, quality: 'best' })
  }
  return nativeImage.createEmpty()
}

/** One-line proxy summary for the menu, so state is visible without opening it. */
function proxySummary(): string {
  try {
    const state = cachedProxyState
    if (!state) return '代理：状态未知'
    const running = state.engines.find((e) => e.running)
    if (running) {
      const node = state.nodes.find((n) => n.id === state.selectedNodeId)
      return `代理：运行中${node ? ` · ${node.name}` : ''} · 端口 ${state.settings.mixedPort}`
    }
    return '代理：未启动'
  } catch {
    return '代理：未启动'
  }
}

/**
 * Rebuilds the context menu. Called on every state change because Electron
 * menus are immutable once attached.
 */
/**
 * Latest proxy state, kept in sync by the mod's broadcast.
 *
 * The tray renders synchronously (Electron menus cannot be built asynchronously), so the
 * state is cached here rather than awaited on every rebuild.
 */
let cachedProxyState: ProxyState | null = null

/** Subscribes the tray cache to the proxy mod. Called once at boot. */
export function trackProxyState(): void {
  modServices.subscribe('proxy', 'state-changed', (payload) => {
    if (payload && typeof payload === 'object') cachedProxyState = payload as ProxyState
    refreshTrayMenu()
  })
}

export function refreshTrayMenu(force = false): void {
  if (!tray) return
  const running = ((): boolean => {
    try {
      return cachedProxyState?.engines.some((e) => e.running) ?? false
    } catch {
      return false
    }
  })()

  /*
   * The proxy emits state on every batch of core log lines, so rebuilding the
   * menu each time would churn native objects during active traffic. Nothing in
   * the menu changes unless the running state or the summary line does.
   */
  const summary = proxySummary()
  const key = `${running}|${summary}`
  if (!force && key === lastMenuKey) return
  lastMenuKey = key

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 Dola Toolkit',
        click: () => {
          showMainWindow()
        }
      },
      { type: 'separator' },
      { label: summary, enabled: false },
      {
        label: running ? '停止代理' : '启动代理',
        click: () => {
          void (async () => {
            try {
              await proxyCall('toggle')
            } catch {
              /* the window shows the failure; ignore here */
            }
            refreshTrayMenu()
          })()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          void app.quit()
        }
      }
    ])
  )
  tray.setToolTip(`Dola Toolkit\n${proxySummary()}`)
}

/** Creates the tray icon if it does not exist yet. Safe to call repeatedly. */
export function ensureTray(): void {
  if (tray) {
    refreshTrayMenu()
    return
  }
  const icon = trayIcon()
  const size = icon.getSize()
  trayIconSize = size.width > 0 && size.height > 0 ? size : null
  if (!trayIconSize) {
    // A missing/empty image still yields a working Tray object, but the icon is
    // invisible — the packaged resources must ship build/icon.png.
    console.log('[tray] icon image is empty — the icon would be invisible')
  }
  try {
    tray = new Tray(icon)
  } catch (e) {
    // No notification area (rare, e.g. some kiosk sessions): hiding still works,
    // the user just restores with the next launch.
    console.log('[tray] creation failed:', e instanceof Error ? e.message : String(e))
    tray = null
    return
  }
  console.log('[tray] created', trayIconSize ? `${trayIconSize.width}x${trayIconSize.height}` : '(no image)')
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
  refreshTrayMenu()
}

export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}

/** True when a tray icon currently exists (used to decide whether to hide). */
export function hasTray(): boolean {
  return tray !== null
}

/** Windows balloon what "minimize" means the first time, if supported. */
export function notifyHidden(): void {
  if (!tray) return
  try {
    tray.displayBalloon?.({
      title: 'Dola Toolkit 仍在后台运行',
      content: '代理与同步保持工作。单击托盘图标可重新打开。',
      iconType: 'info'
    })
  } catch {
    /* displayBalloon is Windows-only and may throw in unusual shells */
  }
}

/**
 * Whether a tray icon is available right now.
 *
 * The close prompt asks first, so it must not offer 「最小化到托盘」 in a session
 * where the icon could not be created — the window would become unreachable.
 * Creating it lazily here also means the answer is real, not optimistic.
 */
export function trayInfo(): { available: boolean; icon: { width: number; height: number } | null } {
  ensureTray()
  if (!tray) return { available: false, icon: null }
  const size = trayIconSize
  return { available: true, icon: size }
}

/** Keeps the main window from being destroyed by a native close. */
export function bindWindowToTray(win: BrowserWindow): void {
  win.on('close', () => {
    refreshTrayMenu()
  })
}

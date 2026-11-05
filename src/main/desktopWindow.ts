// ---------------------------------------------------------------------------
// Dola Toolkit — 桌面悬浮窗宿主能力
//
// 桌宠（Live2D）需要一个透明、无边框、置顶、可穿透鼠标的窗口，覆盖在整个桌面上。
// 这类窗口有大量容易踩错的细节（DPI、透明合成、点击穿透区域、多显示器、恢复位置），
// 所以由宿主统一实现，插件只描述"要一个多大、放在哪、是否穿透"的窗口。
//
// 插件拿到的是：
//   dola.desktop.open(spec)     → 创建并返回窗口句柄 id
//   dola.desktop.setBounds(id, bounds)
//   dola.desktop.setIgnoreMouse(id, ignore)
//   dola.desktop.setAlwaysOnTop(id, on)
//   dola.desktop.setClickRegions(id, rects)   热区（角色本身）之外的点击直接落到桌面
//   dola.desktop.close(id)
//   dola.desktop.list()         当前打开的悬浮窗
//
// 窗口内加载的是插件的 `pet.html`（经 dola-mod:// 提供），因此渲染层复用插件的
// Live2D 运行时，不占用主窗口。
// ---------------------------------------------------------------------------

import { BrowserWindow, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The pet page needs the same preload bridge (`window.api.mod`) as the main renderer,
 * so a mod page can report its character box and toggle click passthrough.
 * electron-vite emits out/preload/index.js next to out/main/index.js.
 */
function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export interface DesktopWindowSpec {
  /** mod id that owns the window; also the protocol host for its page */
  modId: string
  /** page inside the mod, e.g. 'pet.html' */
  page?: string
  /** window size in DIP; defaults to the primary display's work area */
  width?: number
  height?: number
  x?: number
  y?: number
  /** default true: the whole window ignores the mouse until a click region says otherwise */
  ignoreMouse?: boolean
  alwaysOnTop?: boolean
  /**
   * Allow the window to take keyboard focus.
   *
   * A pet window must not steal focus from whatever the user is doing, so this defaults
   * to false. A settings panel opened from the pet needs the opposite: without focus its
   * inputs never receive keystrokes.
   */
  focusable?: boolean
  /** default false: a window the user resizes would fight with the page's own layout */
  resizable?: boolean
  /** default true: hide from Alt-Tab / taskbar */
  skipTaskbar?: boolean
  /** extra query string appended to the page URL */
  query?: Record<string, string>
}

export interface DesktopRect {
  x: number
  y: number
  width: number
  height: number
}

interface ManagedWindow {
  id: string
  modId: string
  win: BrowserWindow
  /** click regions in window coordinates; empty means "the whole window is clickable" */
  regions: DesktopRect[]
}

let seq = 0

export class DesktopWindowHost {
  private windows = new Map<string, ManagedWindow>()

  /** Creates the window and loads the mod's page. */
  async open(spec: DesktopWindowSpec, modDir: (id: string) => string): Promise<string> {
    const display = screen.getPrimaryDisplay()
    const work = display.workArea
    const width = Math.max(120, Math.round(spec.width ?? Math.min(520, work.width)))
    const height = Math.max(120, Math.round(spec.height ?? Math.min(720, work.height)))
    const x = Math.round(spec.x ?? work.x + work.width - width - 24)
    const y = Math.round(spec.y ?? work.y + work.height - height)

    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      // the three flags that make a desktop pet possible
      frame: false,
      transparent: true,
      resizable: spec.resizable === true,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: spec.skipTaskbar !== false,
      hasShadow: false,
      // do not steal focus from whatever the user is doing — unless it is a panel
      focusable: spec.focusable === true,
      acceptFirstMouse: true,
      alwaysOnTop: spec.alwaysOnTop !== false,
      backgroundColor: '#00000000',
      webPreferences: {
        // the pet is our own page from dola-mod://, and it uses the same mod bridge
        preload: existsSync(preloadPath()) ? preloadPath() : undefined,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })

    if (spec.alwaysOnTop !== false) {
      // 'screen-saver' keeps it above full-screen apps as well
      win.setAlwaysOnTop(true, 'screen-saver')
    }
    // visible on every desktop / above full-screen games
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (spec.ignoreMouse !== false) win.setIgnoreMouseEvents(true, { forward: true })

    const query = new URLSearchParams(spec.query ?? {}).toString()
    const page = (spec.page ?? 'pet.html').replace(/^\/+/, '')
    const url = `dola-mod://${spec.modId}/${page}${query ? `?${query}` : ''}`
    void modDir(spec.modId)
    void pathToFileURL
    await win.loadURL(url)

    const id = `desktop-${++seq}`
    this.windows.set(id, { id, modId: spec.modId, win, regions: [] })
    win.on('closed', () => this.windows.delete(id))
    return id
  }

  private get(id: string): ManagedWindow | null {
    return this.windows.get(id) ?? null
  }

  setBounds(id: string, bounds: Partial<DesktopRect>): boolean {
    const entry = this.get(id)
    if (!entry) return false
    const current = entry.win.getBounds()
    entry.win.setBounds({
      x: bounds.x !== undefined ? Math.round(bounds.x) : current.x,
      y: bounds.y !== undefined ? Math.round(bounds.y) : current.y,
      width: bounds.width !== undefined ? Math.round(bounds.width) : current.width,
      height: bounds.height !== undefined ? Math.round(bounds.height) : current.height
    })
    return true
  }

  /**
   * Toggles mouse passthrough.
   *
   * `forward: true` keeps mousemove events flowing to the page while the window itself is
   * transparent to clicks — that is what lets the page notice the pointer is over the
   * character and ask for clicks to be enabled again.
   */
  setIgnoreMouse(id: string, ignore: boolean): boolean {
    const entry = this.get(id)
    if (!entry) return false
    entry.win.setIgnoreMouseEvents(ignore, { forward: true })
    return true
  }

  setAlwaysOnTop(id: string, on: boolean): boolean {
    const entry = this.get(id)
    if (!entry) return false
    entry.win.setAlwaysOnTop(on, on ? 'screen-saver' : 'normal')
    return true
  }

  /**
   * Brings a window to the front and gives it keyboard focus.
   *
   * A `focusable: false` window cannot take focus at all, so this is only meaningful for
   * windows opened with `focusable: true` — typically a settings panel the user just
   * asked for, which would otherwise open behind its own owner.
   */
  focus(id: string): boolean {
    const entry = this.get(id)
    if (!entry) return false
    const win = entry.win
    if (win.isDestroyed()) return false
    try {
      if (win.isMinimized()) win.restore()
      win.moveTop()
      win.show()
      win.focus()
      return true
    } catch {
      return false
    }
  }

  /**
   * Declares which parts of the window should receive clicks.
   *
   * Electron has no built-in per-region hit testing for a transparent window, so the page
   * does it itself: it watches mousemove (which still arrives thanks to `forward`) and
   * flips passthrough off while the pointer is inside a region. The host stores the
   * regions so a plugin can rebuild them after a resize.
   */
  setClickRegions(id: string, rects: DesktopRect[]): boolean {
    const entry = this.get(id)
    if (!entry) return false
    entry.regions = rects.map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }))
    return true
  }

  getClickRegions(id: string): DesktopRect[] {
    return this.get(id)?.regions ?? []
  }

  close(id: string): boolean {
    const entry = this.get(id)
    if (!entry) return false
    entry.win.destroy()
    this.windows.delete(id)
    return true
  }

  closeAllFor(modId: string): void {
    for (const entry of [...this.windows.values()]) {
      if (entry.modId === modId) this.close(entry.id)
    }
  }

  list(): { id: string; modId: string; bounds: DesktopRect; ignoreMouse: boolean }[] {
    return [...this.windows.values()].map((entry) => {
      const b = entry.win.getBounds()
      return { id: entry.id, modId: entry.modId, bounds: b, ignoreMouse: entry.regions.length > 0 }
    })
  }
}

export const desktopWindows = new DesktopWindowHost()

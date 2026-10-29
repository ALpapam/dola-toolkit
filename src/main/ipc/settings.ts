// ---------------------------------------------------------------------------
// Dola Toolkit — settings IPC
// ---------------------------------------------------------------------------

import { app, ipcMain, nativeTheme } from 'electron'
import { IPC } from '@shared/channels'
import { proxyCall } from '../modService'
import type { Settings, SettingsPatch } from '@shared/types'
import { getSettings, patchSettings, resetSettings } from '../store'
import { broadcast, getMainWindow, setWindowBackground } from '../window'
import { computeMonet } from '../monet'

function appearanceSignature(s: Settings): string {
  const a = s.appearance
  return [a.monet, a.seedSource, a.customSeed, a.contrast, a.themeMode].join('|')
}

async function pushTheme(force: boolean): Promise<void> {
  try {
    const settings = getSettings()
    const monet = await computeMonet(settings, force)
    const dark =
      settings.appearance.themeMode === 'dark' ||
      (settings.appearance.themeMode === 'system' && shouldUseDark())
    setWindowBackground(dark ? monet.dark.surface : monet.light.surface)
    broadcast(IPC.themeChanged, monet)
  } catch {
    /* theme failures must never break a settings write */
  }
}

function shouldUseDark(): boolean {
  return nativeTheme.shouldUseDarkColors === true
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsPatch, async (_e, patch: unknown) => {
    const before = getSettings()
    const safePatch = sanitizePatch(patch)
    const next = patchSettings(safePatch)
    broadcast(IPC.settingsChanged, next)

    const appearanceChanged = appearanceSignature(before) !== appearanceSignature(next)
    if (appearanceChanged) await pushTheme(true)
    else if (before.appearance.themeMode !== next.appearance.themeMode) await pushTheme(false)

    // Proxy settings must be pushed to the running core (listen address, port…).
    try {
      await proxyCall('apply-settings', before.proxy, next.proxy)
    } catch {
      /* proxy subsystem must never break a settings write */
    }

    if (next.general.launchAtLogin !== before.general.launchAtLogin && process.platform === 'win32') {
      try {
        app.setLoginItemSettings({ openAtLogin: next.general.launchAtLogin })
      } catch {
        /* OS may refuse; not fatal */
      }
    }
    // window chrome follows the theme mode
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (next.general.zoom !== before.general.zoom) {
        try {
          win.webContents.setZoomFactor(clamp(next.general.zoom, 0.5, 3))
        } catch {
          /* ignore */
        }
      }
    }
    return next
  })

  ipcMain.handle(IPC.settingsReset, async () => {
    const next = resetSettings()
    broadcast(IPC.settingsChanged, next)
    await pushTheme(true)
    return next
  })

  // renderer focus → cheap wallpaper re-check, no permanent timer
  ipcMain.handle('settings:focus-refresh', async () => {
    await pushTheme(false)
    return getSettings()
  })
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Never trust the renderer: keep only known sections + primitive leaves. */
function sanitizePatch(raw: unknown): SettingsPatch {
  const out: SettingsPatch = {}
  if (typeof raw !== 'object' || raw === null) return out
  const src = raw as Record<string, unknown>
  const sections = ['appearance', 'ai', 'sync', 'proxy', 'library', 'reader', 'general'] as const
  for (const section of sections) {
    const value = src[section]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      const t = typeof v
      if (t === 'string' || t === 'number' || t === 'boolean' || v === null) clean[k] = v
    }
    if (Object.keys(clean).length) {
      ;(out as Record<string, unknown>)[section] = clean
    }
  }
  return out
}

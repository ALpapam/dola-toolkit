// ---------------------------------------------------------------------------
// Dola Toolkit — theme / Monet IPC
// ---------------------------------------------------------------------------

import { ipcMain, nativeTheme } from 'electron'
import { IPC } from '@shared/channels'
import type { MonetResult } from '@shared/types'
import { getSettings } from '../store'
import { broadcast, getMainWindow, setWindowBackground } from '../window'
import { computeMonet, wallpaperChanged } from '../monet'

function isDarkNow(): boolean {
  const settings = getSettings()
  if (settings.appearance.themeMode === 'dark') return true
  if (settings.appearance.themeMode === 'light') return false
  return nativeTheme.shouldUseDarkColors === true
}

function applyBackground(monet: MonetResult): void {
  setWindowBackground(isDarkNow() ? monet.dark.surface : monet.light.surface)
}

export function registerThemeIpc(): void {
  ipcMain.handle(IPC.themeMonet, async (_e, force: unknown) => {
    const managed = await computeMonet(getSettings(), force === true)
    applyBackground(managed)
    return managed
  })

  ipcMain.handle(IPC.themeRefresh, async () => {
    // Called on renderer focus / visibility change: only recompute when the
    // wallpaper actually changed on disk.
    const changed = await wallpaperChanged()
    const managed = await computeMonet(getSettings(), changed)
    applyBackground(managed)
    if (changed) broadcast(IPC.themeChanged, managed)
    return managed
  })

  // Native OS accent / theme switches arrive here; just re-broadcast.
  ipcMain.handle('theme:sync-native', async () => {
    const managed = await computeMonet(getSettings(), true)
    applyBackground(managed)
    broadcast(IPC.themeChanged, managed)
    return managed
  })
}

/** Exposed for index.ts when the window regains focus. */
export async function refreshThemeOnFocus(): Promise<MonetResult> {
  const changed = await wallpaperChanged()
  const managed = await computeMonet(getSettings(), changed)
  applyBackground(managed)
  if (changed) broadcast(IPC.themeChanged, managed)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.setBackgroundColor(isDarkNow() ? managed.dark.surface : managed.light.surface)
  return managed
}

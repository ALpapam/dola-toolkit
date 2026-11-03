// ---------------------------------------------------------------------------
// Dola Toolkit — IPC registry
// Every registrar is imported statically: electron-vite emits a single
// `out/main/index.js`, so a runtime `require('./library')` would resolve
// against the output directory and silently fail (killing the whole library,
// AI and sync feature set). All registrars below are idempotent.
//
// Each call is isolated: one failing subsystem must never prevent the others
// (or the window) from coming up.
// ---------------------------------------------------------------------------

import { registerAppIpc } from './app'
import { registerSettingsIpc } from './settings'
import { registerThemeIpc } from './theme'
import { registerLibraryIpc } from './library'
import { registerAiIpc } from './ai'
import { registerSyncIpc } from './sync'
import { registerFontsIpc } from './fonts'
import { registerUpdatesIpc } from './updates'
import { registerModsIpc } from '../mods/ipc'
import { registerModServiceIpc } from '../modService'

type Registrar = () => void

/** Run a registrar, logging (never rethrowing) so boot always completes. */
function safe(name: string, fn: Registrar | undefined): void {
  if (typeof fn !== 'function') {
    console.warn(`[Dola Toolkit] IPC registrar "${name}" is unavailable, skipping`)
    return
  }
  try {
    fn()
  } catch (e) {
    console.error(
      `[Dola Toolkit] IPC registrar "${name}" failed:`,
      e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : e
    )
  }
}

export function registerAllIpc(): void {
  // Shell first — the window is useless without settings/theme/proxy.
  safe('app', registerAppIpc)
  safe('settings', registerSettingsIpc)
  safe('theme', registerThemeIpc)
  safe('mod-services', registerModServiceIpc)
  // Feature modules owned by the library/AI/sync teammate.
  safe('library', registerLibraryIpc)
  safe('ai', registerAiIpc)
  safe('sync', registerSyncIpc)
  // reader typography — user-imported + bundled font families
  safe('fonts', registerFontsIpc)
  // self-update + core updates
  safe('updates', registerUpdatesIpc)
  safe('mods', registerModsIpc)
}

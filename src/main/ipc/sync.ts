// ---------------------------------------------------------------------------
// Dola Toolkit — sync IPC (`sync:status`, `sync:run`, `sync:test`).
// ---------------------------------------------------------------------------

import { ipcMain } from 'electron'
import type { SyncStatus } from '../../shared/types'
import { IPC } from '../../shared/channels'
import { runSync, statusSync, testSync } from '../sync'

let registered = false

export function registerSyncIpc(): void {
  // Idempotent: Electron throws when a channel is registered twice.
  if (registered) return
  registered = true
  ipcMain.handle(IPC.syncStatus, (): SyncStatus => {
    try {
      return statusSync()
    } catch {
      return { enabled: false, configured: false, lastSyncAt: null, running: false, lastResult: null }
    }
  })

  ipcMain.handle(IPC.syncRun, async (): Promise<SyncStatus> => {
    try {
      return await runSync()
    } catch (err) {
      return {
        enabled: false,
        configured: false,
        lastSyncAt: null,
        running: false,
        lastResult: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          at: Date.now()
        }
      }
    }
  })

  ipcMain.handle(IPC.syncTest, async (): Promise<{ ok: boolean; message: string }> => {
    try {
      return await testSync()
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}


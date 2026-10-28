// ---------------------------------------------------------------------------
// Dola Toolkit — mod IPC
// ---------------------------------------------------------------------------

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/channels'
import {
  importModFromZip,
  listMods,
  markModIntroduced,
  modsRoot,
  setModOrder,
  uninstallMod,
  type ModRecord
} from './manager'

/** Tells every window that the installed mod set changed. */
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.modChanged)
  }
}

export function registerModsIpc(): void {
  ipcMain.handle(IPC.modList, (): ModRecord[] => listMods())

  ipcMain.handle(IPC.modImportZip, async (_e, zipPath: unknown) => {
    if (typeof zipPath !== 'string' || !zipPath) return { ok: false, error: '缺少插件包路径' }
    const result = await importModFromZip(zipPath)
    if (result.ok) broadcast()
    return result
  })

  ipcMain.handle(IPC.modPickAndImport, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: '选择插件包',
      filters: [{ name: 'Dola Toolkit 插件', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    const result = await importModFromZip(picked.filePaths[0])
    if (result.ok) broadcast()
    return result
  })

  ipcMain.handle(IPC.modUninstall, (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '缺少插件 id' }
    const result = uninstallMod(id)
    if (result.ok) broadcast()
    return result
  })

  ipcMain.handle(IPC.modSetOrder, (_e, ids: unknown) => {
    if (!Array.isArray(ids)) return { ok: false }
    setModOrder(ids.filter((x): x is string => typeof x === 'string'))
    return { ok: true }
  })

  ipcMain.handle(IPC.modMarkIntroduced, (_e, id: unknown) => {
    if (typeof id === 'string') markModIntroduced(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.modOpenFolder, () => {
    void shell.openPath(modsRoot())
    return modsRoot()
  })
}

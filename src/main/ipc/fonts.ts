// ---------------------------------------------------------------------------
// Dola Toolkit — font IPC (`fonts:list`, `fonts:import`, `fonts:remove`, …)
// ---------------------------------------------------------------------------

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/channels'
import { fontUrl, fontsDir, importFonts, listFonts, removeFont } from '../fonts'
import { getMainWindow } from '../window'

export interface FontsListPayload {
  fonts: (ReturnType<typeof listFonts>['fonts'][number] & { url: string | null })[]
  defaultId: string
  dir: string
}

export function registerFontsIpc(): void {
  ipcMain.handle(IPC.fontsList, (): FontsListPayload => {
    const list = listFonts()
    return {
      ...list,
      // attach a renderer-usable URL for every family so the UI can preview it
      fonts: list.fonts.map((f) => ({ ...f, url: fontUrl(f.id) })),
      dir: fontsDir()
    }
  })

  /** Open a file picker and import whatever the user chooses. */
  ipcMain.handle(IPC.fontsImport, async () => {
    const win = getMainWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择字体文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '字体文件', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return { imported: [], skipped: [] }
    return importFonts(result.filePaths)
  })

  /** Import explicit paths (used by drag & drop onto the settings panel). */
  ipcMain.handle(IPC.fontsImportPaths, (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return { imported: [], skipped: [] }
    return importFonts(paths.filter((p): p is string => typeof p === 'string'))
  })

  ipcMain.handle(IPC.fontsRemove, (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, reason: '无效的字体 id' }
    return removeFont(id)
  })

  ipcMain.handle(IPC.fontsReveal, async () => {
    const dir = fontsDir()
    await shell.openPath(dir)
    return dir
  })
}

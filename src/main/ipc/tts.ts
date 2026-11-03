// ---------------------------------------------------------------------------
// Dola Toolkit — 语音合成 IPC（`tts:status`、`tts:speak`、`tts:test`、`tts:pick-reference`）
// ---------------------------------------------------------------------------

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { audioFileDataUrl, ttsSpeak, ttsStatus } from '../tts'

let registered = false

export function registerTtsIpc(): void {
  // idempotent: Electron throws when a channel is registered twice
  if (registered) return
  registered = true

  ipcMain.handle(IPC.ttsStatus, () => {
    try {
      return ttsStatus()
    } catch {
      return { configured: false, ready: false, endpoint: '', refAudio: '', reason: '状态读取失败' }
    }
  })

  ipcMain.handle(IPC.ttsSpeak, async (_e, text: unknown) => {
    try {
      return await ttsSpeak(typeof text === 'string' ? text : String(text ?? ''))
    } catch (e) {
      return { ok: false, audio: '', text: '', error: e instanceof Error ? e.message : String(e) }
    }
  })

  /**
   * Settings-page test.
   *
   * A real synthesis is the only check that proves the endpoint, the reference audio and
   * the language settings all agree — a reachable server on its own proves nothing.
   */
  ipcMain.handle(IPC.ttsTest, async () => {
    const line = '你好，我是你的桌面伙伴。'
    try {
      const res = await ttsSpeak(line)
      if (res.ok) return { ...res, text: line }
      const status = ttsStatus()
      return { ...res, error: res.error ?? status.reason }
    } catch (e) {
      return { ok: false, audio: '', text: line, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /**
   * Picks a reference clip and reports whether it is readable.
   *
   * The returned preview lets the settings page play the sample back right away — the
   * usual mistake is choosing a silent file and only finding out from a failed synthesis.
   */
  ipcMain.handle(IPC.ttsPickReference, async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, {
        title: '选择参考音频（3~10 秒，无背景音乐）',
        filters: [{ name: '音频', extensions: ['wav', 'flac', 'ogg', 'mp3'] }],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths.length) return { path: null, preview: null }
      const path = res.filePaths[0]
      return { path, preview: audioFileDataUrl(path) }
    } catch {
      return { path: null, preview: null }
    }
  })
}

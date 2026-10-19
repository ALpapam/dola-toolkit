// ---------------------------------------------------------------------------
// Dola Toolkit — AI IPC (`ai:status`, `ai:chat`, `ai:test`).
// ---------------------------------------------------------------------------

import { ipcMain } from 'electron'
import type { AIChatResult, ChatMessage } from '../../shared/types'
import { IPC } from '../../shared/channels'
import { aiChat, aiStatus, aiTest } from '../ai'

/** Coerce an IPC payload into a safe ChatMessage[] (never throws). */
function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const item of raw.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const role = rec['role']
    const content = rec['content']
    if (typeof content !== 'string' || !content.trim()) continue
    out.push({
      role: role === 'system' || role === 'assistant' ? role : 'user',
      content
    })
  }
  return out
}

let registered = false

export function registerAiIpc(): void {
  // Idempotent: Electron throws when a channel is registered twice.
  if (registered) return
  registered = true
  ipcMain.handle(IPC.aiStatus, () => {
    try {
      return aiStatus()
    } catch {
      return { configured: false, enabled: false, baseUrl: '', model: '', lastError: '状态读取失败' }
    }
  })

  ipcMain.handle(IPC.aiChat, async (_e, messages: unknown): Promise<AIChatResult> => {
    const started = Date.now()
    try {
      const clean = sanitizeMessages(messages)
      if (!clean.length) {
        return { ok: false, content: '', error: '消息为空', ms: Date.now() - started }
      }
      return await aiChat(clean)
    } catch (err) {
      return {
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started
      }
    }
  })

  ipcMain.handle(IPC.aiTest, async (): Promise<AIChatResult> => {
    const started = Date.now()
    try {
      return await aiTest()
    } catch (err) {
      return {
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started
      }
    }
  })
}


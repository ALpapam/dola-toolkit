// ---------------------------------------------------------------------------
// Dola Toolkit — 本地语音合成（GPT-SoVITS）客户端
//
// 只做一件事：把一段文字发给用户自己的 TTS 服务，拿回音频。
//
// 为什么放在主进程：
//   · 渲染层直接 fetch `http://127.0.0.1:9880` 会被 CSP 的 connect-src 拦掉；
//   · 参考音频是本地路径，只有主进程能读；
//   · 声音模型在用户机器上，文字和音频都不该经过任何中转。
//
// Never throws: every failure comes back as `{ ok: false, error: '中文原因' }`.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { TtsSettings } from '../shared/types'
import { getSettings } from './store'

export interface TtsResult {
  ok: boolean
  /** `data:audio/wav;base64,…` — playable straight from an <audio> tag */
  audio: string
  /** spoken text, echoed back so the UI can show what was said */
  text: string
  error: string | null
}

const MAX_TEXT = 400

function cfg(): TtsSettings {
  try {
    return getSettings().tts
  } catch {
    return {
      enabled: false,
      endpoint: 'http://127.0.0.1:9880/tts',
      refAudio: '',
      promptText: '',
      promptLang: 'zh',
      textLang: 'zh',
      speed: 1,
      timeoutMs: 120_000
    }
  }
}

/** `{configured, ready}`: configured means the user filled it in; ready adds the checks we can do locally. */
export function ttsStatus(): {
  configured: boolean
  ready: boolean
  endpoint: string
  refAudio: string
  /** why it is not ready, in Chinese */
  reason: string
} {
  const c = cfg()
  const refOk = Boolean(c.refAudio) && existsSync(c.refAudio)
  const base = { endpoint: c.endpoint, refAudio: c.refAudio }
  if (!c.enabled) return { ...base, configured: false, ready: false, reason: '还没有在设置里开启语音合成' }
  if (!c.endpoint) return { ...base, configured: false, ready: false, reason: '没有填 TTS 地址' }
  if (!c.refAudio) return { ...base, configured: false, ready: false, reason: '没有选择参考音频' }
  if (!refOk) return { ...base, configured: true, ready: false, reason: '参考音频文件不存在' }
  return { ...base, configured: true, ready: true, reason: '' }
}

/**
 * GPT-SoVITS caps a single request at roughly one paragraph of text, and very long input
 * makes it return garbage as often as it fails outright. Cutting at sentence boundaries
 * keeps the prosody natural where the split happens.
 */
function clampText(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_#`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= MAX_TEXT) return clean
  const cut = clean.slice(0, MAX_TEXT)
  const lastStop = Math.max(...['。', '！', '？', '；', '.', '!', '?', '\n'].map((p) => cut.lastIndexOf(p)))
  return lastStop > MAX_TEXT * 0.5 ? cut.slice(0, lastStop + 1) : cut
}

/**
 * Star Wars: `text_lang` and `prompt_lang` are positional in GPT-SoVITS' API, and
 * omitting `prompt_text` (the transcript of the reference clip) is allowed — the model then
 * does its own feature extraction.
 */
export async function ttsSpeak(rawText: string): Promise<TtsResult> {
  const c = cfg()
  const text = clampText(rawText)
  if (!text) return { ok: false, audio: '', text: '', error: '没有要朗读的内容' }
  if (!c.enabled) return { ok: false, audio: '', text, error: '语音合成还没开启（设置 → 语音）' }
  if (!c.refAudio) return { ok: false, audio: '', text, error: '还没有选择参考音频（设置 → 语音）' }
  if (!existsSync(c.refAudio)) return { ok: false, audio: '', text, error: `参考音频不存在：${c.refAudio}` }

  const url = new URL(c.endpoint)
  url.searchParams.set('text', text)
  url.searchParams.set('text_lang', c.textLang || 'zh')
  url.searchParams.set('ref_audio_path', c.refAudio)
  // an empty transcript tells GPT-SoVITS to derive it from the audio
  url.searchParams.set('prompt_text', c.promptText ?? '')
  url.searchParams.set('prompt_lang', c.promptLang || 'zh')
  url.searchParams.set('media_type', 'wav')
  if (Number.isFinite(c.speed) && c.speed > 0.5 && c.speed < 2.5) {
    url.searchParams.set('speed_factor', String(c.speed))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(10_000, c.timeoutMs || 120_000))
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      // the server explains itself in JSON: {"message": "tts failed", "Exception": "…"}
      let detail = `HTTP ${res.status}`
      try {
        const payload = (await res.json()) as { message?: string; Exception?: string }
        detail = [payload.message, payload.Exception].filter(Boolean).join('：') || detail
      } catch {
        /* not JSON — keep the status code */
      }
      return { ok: false, audio: '', text, error: `合成失败：${detail}` }
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 200) return { ok: false, audio: '', text, error: '合成返回的音频是空的' }
    const mime = res.headers.get('content-type')?.split(';')[0] || 'audio/wav'
    return { ok: true, audio: `data:${mime};base64,${bytes.toString('base64')}`, text, error: null }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      audio: '',
      text,
      error: aborted ? '合成超时（服务没有响应）' : `连不上语音服务：${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Writes the generated audio next to the app's data so it can be replayed or inspected
 * after the fact. Best-effort: a voice line is not worth surfacing a disk error for.
 */
export function cacheVoice(audioDataUrl: string): string | null {
  try {
    const dir = join(app.getPath('userData'), 'tts-cache')
    mkdirSync(dir, { recursive: true })
    const b64 = audioDataUrl.slice(audioDataUrl.indexOf(',') + 1)
    const file = join(dir, 'last.wav')
    writeFileSync(file, Buffer.from(b64, 'base64'))
    return file
  } catch {
    return null
  }
}

/** Reads a local audio file back as a data URL (used by the settings page to preview the sample). */
export function audioFileDataUrl(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return `data:audio/wav;base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}

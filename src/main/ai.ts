// ---------------------------------------------------------------------------
// Dola Toolkit — OpenAI-compatible chat client.
//
// Never throws: every failure is reported through `AIChatResult.ok === false`
// with a Chinese error message suitable for a toast.
// ---------------------------------------------------------------------------

import type { AIChatResult, AIStatus, ChatMessage } from '../shared/types'
import { getSettings } from './store'

export interface ChatOptions {
  /** ask the server for strict JSON (retried without it on HTTP 400) */
  json?: boolean
  /** override the timeout from settings (ms) */
  timeoutMs?: number
  temperature?: number
  maxTokens?: number
  /** skip the `[readAiSettings]` indirection (tests) */
  responseOnly?: boolean
}

interface ResolvedAIConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  systemPrompt: string
  seriesPrompt: string
}

const DEFAULT_TIMEOUT = 60_000

let lastError: string | null = null

/** Last transport error (surfaced through `aiStatus()`). */
export function setLastError(message: string | null): void {
  lastError = message
}

export function getLastError(): string | null {
  return lastError
}

/**
 * Read AI settings from main-core's store. Kept lazy so this module can be
 * imported before the settings store is initialised (and in tests).
 */
export function readAIConfig(): ResolvedAIConfig {
  const fallback: ResolvedAIConfig = {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: DEFAULT_TIMEOUT,
    systemPrompt: '',
    seriesPrompt: ''
  }
  try {
    // Static import: the packaged main process is a single bundled file, so a
    // runtime require('../store') cannot resolve and would silently fall back to
    // empty credentials — which looks exactly like "AI 未配置".
    const ai = getSettings().ai ?? {}
    const baseUrl = typeof ai.baseUrl === 'string' ? ai.baseUrl : ''
    return {
      enabled: ai.enabled ?? false,
      baseUrl: baseUrl.trim(),
      apiKey: typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '',
      model: typeof ai.model === 'string' && ai.model.trim() ? ai.model.trim() : 'gpt-4o-mini',
      temperature: typeof ai.temperature === 'number' && Number.isFinite(ai.temperature) ? ai.temperature : 0.7,
      maxTokens: typeof ai.maxTokens === 'number' && ai.maxTokens > 0 ? ai.maxTokens : 1024,
      timeoutMs: typeof ai.timeoutMs === 'number' && ai.timeoutMs >= 5000 ? ai.timeoutMs : DEFAULT_TIMEOUT,
      systemPrompt: typeof ai.systemPrompt === 'string' ? ai.systemPrompt : '',
      seriesPrompt: typeof ai.seriesPrompt === 'string' ? ai.seriesPrompt : ''
    }
  } catch {
    return fallback
  }
}

export function aiStatus(): AIStatus {
  const cfg = readAIConfig()
  return {
    configured: Boolean(cfg.apiKey && cfg.baseUrl),
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    lastError
  }
}

/** Joining a base URL that may or may not already include `/v1`. */
export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

/** Strip ```json fences and surrounding prose from a model reply. */
export function stripCodeFences(raw: string): string {
  let text = (raw ?? '').trim()
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  // A stray leading/trailing fence without a closing pair
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim()
  return text
}

/** Extract the first JSON object/array embedded in prose. */
export function extractJsonPayload(raw: string): string | null {
  const text = stripCodeFences(raw)
  if (!text) return null
  const firstObj = text.indexOf('{')
  const firstArr = text.indexOf('[')
  let start = -1
  let open = ''
  let close = ''
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    start = firstObj
    open = '{'
    close = '}'
  } else if (firstArr >= 0) {
    start = firstArr
    open = '['
    close = ']'
  }
  if (start < 0) return null
  const end = text.lastIndexOf(close)
  if (end <= start) return null
  const candidate = text.slice(start, end + 1)
  // Prefer a balanced slice when possible.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return candidate.slice(0, i + 1)
    }
  }
  return candidate
}

interface ParsedChoice {
  content: string
  usage?: { prompt: number; completion: number; total: number }
}

/** Tolerate OpenAI / Azure / Ollama / Anthropic-ish response shapes. */
export function parseChatResponse(body: unknown): ParsedChoice {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : null

  const root = asRecord(body)
  if (!root) return { content: '' }

  const usageRaw = asRecord(root['usage'])
  const usage = usageRaw
    ? {
        prompt: Number(usageRaw['prompt_tokens'] ?? usageRaw['input_tokens'] ?? 0) || 0,
        completion: Number(usageRaw['completion_tokens'] ?? usageRaw['output_tokens'] ?? 0) || 0,
        total: Number(usageRaw['total_tokens'] ?? 0) || 0
      }
    : undefined

  const choices = root['choices']
  if (Array.isArray(choices) && choices.length) {
    const first = asRecord(choices[0])
    if (first) {
      const message = asRecord(first['message'])
      if (message) {
        const content = message['content']
        if (typeof content === 'string' && content.trim()) return { content, usage }
        if (Array.isArray(content)) {
          // content parts: [{type:'text', text:'...'}]
          const joined = content
            .map((part) => {
              const rec = asRecord(part)
              if (!rec) return ''
              return typeof rec['text'] === 'string' ? rec['text'] : ''
            })
            .join('')
          if (joined.trim()) return { content: joined, usage }
        }
      }
      const text = first['text']
      if (typeof text === 'string' && text.trim()) return { content: text, usage }
    }
  }

  if (typeof root['output_text'] === 'string' && root['output_text'].trim()) {
    return { content: root['output_text'], usage }
  }
  const output = root['output']
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const item of output) {
      const rec = asRecord(item)
      if (!rec) continue
      const content = rec['content']
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = asRecord(part)
          if (p && typeof p['text'] === 'string') parts.push(p['text'])
        }
      } else if (typeof content === 'string') parts.push(content)
    }
    if (parts.join('').trim()) return { content: parts.join(''), usage }
  }
  if (typeof root['message'] === 'string') return { content: root['message'], usage }
  // Some servers put the error in `error`
  const err = root['error']
  if (typeof err === 'string') return { content: '', usage }
  return { content: '', usage }
}

/** Human-friendly message from an HTTP error body. */
function describeHttpError(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) detail = parsed.error.message
    else if (typeof parsed.error === 'string') detail = parsed.error
    else if (typeof parsed.message === 'string') detail = parsed.message
  } catch {
    detail = body.slice(0, 200)
  }
  const suffix = detail ? `：${detail}` : ''
  if (status === 401 || status === 403) return `AI 鉴权失败（HTTP ${status}）${suffix}`
  if (status === 404) return `AI 接口不存在（HTTP 404）${suffix}`
  if (status === 429) return `AI 请求过于频繁（HTTP 429）${suffix}`
  if (status >= 500) return `AI 服务异常（HTTP ${status}）${suffix}`
  return `AI 请求失败（HTTP ${status}）${suffix}`
}

/**
 * Send a chat completion. Never throws.
 * When `opts.json` is set and the server rejects `response_format` with a 400,
 * the request is retried once without it.
 */
export async function aiChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<AIChatResult> {
  const started = Date.now()
  const cfg = readAIConfig()

  if (!cfg.baseUrl || !cfg.apiKey) {
    return {
      ok: false,
      content: '',
      error: '未配置 AI：请先在「设置 → AI」填写接口地址与密钥',
      ms: Date.now() - started
    }
  }
  if (!cfg.enabled) {
    return {
      ok: false,
      content: '',
      error: 'AI 已关闭：请在「设置 → AI」中启用',
      ms: Date.now() - started
    }
  }
  const cleanMessages = (Array.isArray(messages) ? messages : [])
    .filter((m): m is ChatMessage => Boolean(m) && typeof m.content === 'string')
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
      content: m.content
    }))
  if (!cleanMessages.length) {
    return { ok: false, content: '', error: '消息为空', ms: Date.now() - started }
  }

  const url = completionsUrl(cfg.baseUrl)
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT

  const buildBody = (withJson: boolean): string => {
    const payload: Record<string, unknown> = {
      model: cfg.model,
      messages: cleanMessages,
      temperature: opts.temperature ?? cfg.temperature,
      max_tokens: opts.maxTokens ?? cfg.maxTokens,
      stream: false
    }
    if (withJson) {
      payload['response_format'] = { type: 'json_object' }
      // Most OpenAI-compatible servers that accept response_format expect the
      // word "json" somewhere in the prompt; the caller usually handles that.
    }
    return JSON.stringify(payload)
  }

  const attempt = async (withJson: boolean): Promise<{ status: number; body: string; error?: string }> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: 'application/json'
        },
        body: buildBody(withJson),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const body = await res.text()
      return { status: res.status, body }
    } catch (err) {
      const name = (err as { name?: string }).name
      const message =
        name === 'TimeoutError' || name === 'AbortError'
          ? `AI 请求超时（${Math.round(timeoutMs / 1000)} 秒）`
          : `无法连接 AI 服务：${err instanceof Error ? err.message : String(err)}`
      return { status: 0, body: '', error: message }
    }
  }

  let result = await attempt(Boolean(opts.json))
  if (opts.json && result.status === 400) {
    // Some servers reject response_format outright.
    result = await attempt(false)
  }

  if (result.status === 0) {
    lastError = result.error ?? '网络错误'
    return { ok: false, content: '', error: lastError, ms: Date.now() - started }
  }
  if (result.status < 200 || result.status >= 300) {
    lastError = describeHttpError(result.status, result.body)
    return { ok: false, content: '', error: lastError, ms: Date.now() - started }
  }

  let parsedBody: unknown = null
  try {
    parsedBody = JSON.parse(result.body)
  } catch {
    lastError = 'AI 返回了无法解析的响应'
    return { ok: false, content: '', error: lastError, ms: Date.now() - started }
  }

  const { content, usage } = parseChatResponse(parsedBody)
  if (!content.trim()) {
    const root = parsedBody as { error?: unknown }
    lastError =
      root && typeof root['error'] === 'string'
        ? `AI 错误：${root['error']}`
        : 'AI 返回了空内容'
    return { ok: false, content: '', error: lastError, usage, ms: Date.now() - started }
  }

  lastError = null
  return {
    ok: true,
    content,
    error: null,
    ...(usage ? { usage } : {}),
    ms: Date.now() - started
  }
}

/** Convenience wrapper used by the classifier: asks for JSON and parses it. */
export async function aiChatJson(
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<{ result: AIChatResult; json: unknown | null }> {
  const result = await aiChat(messages, { ...opts, json: true })
  if (!result.ok) return { result, json: null }
  const payload = extractJsonPayload(result.content)
  if (!payload) return { result, json: null }
  try {
    return { result, json: JSON.parse(payload) as unknown }
  } catch {
    return { result, json: null }
  }
}

/** Minimal connectivity check for the settings page. */
export async function aiTest(): Promise<AIChatResult> {
  // Reasoning models (DeepSeek-V4.x, o-series…) spend most of their budget on
  // hidden reasoning before emitting any content. A 16-token budget therefore
  // returns an empty string and finish_reason "length", which looks like a
  // broken key. Give the probe enough room and keep the question tiny.
  return aiChat([{ role: 'user', content: '请只回复 pong' }], { maxTokens: 512, temperature: 0 })
}

// ---------------------------------------------------------------------------
// Dola Toolkit — tiny HTTP(S) GET helper shared by the update checker and the
// proxy module. No third-party client: one GET with a timeout and a redirect-free
// response callback, so callers control redirects and streaming themselves.
// ---------------------------------------------------------------------------

import type { ClientRequest, IncomingMessage } from 'node:http'
import * as http from 'node:http'
import * as https from 'node:https'

export function httpsGet(
  url: string,
  timeoutMs: number,
  onResponse: (res: IncomingMessage) => void,
  headers: Record<string, string> = {}
): ClientRequest {
  const isHttps = url.startsWith('https:')
  const mod = isHttps ? https : http
  const req = mod.get(
    url,
    {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Dola Toolkit/1.0', 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers }
    },
    onResponse
  ) as ClientRequest
  req.on('timeout', () => req.destroy(new Error('请求超时')))
  return req
}

// ---------------------------------------------------------------------------
// Dola Toolkit — HTTP(S) helpers for the update checker.
//
// Downloads and version lookups can be routed through the local mixed proxy when
// one is running. Without that, updating while the proxy is on still uses the
// direct route, which for GitHub means "slow" in most of mainland China — the
// update felt slower than the traffic it was updating.
// ---------------------------------------------------------------------------

import type { ClientRequest, IncomingMessage } from 'node:http'
import * as http from 'node:http'
import * as https from 'node:https'
import * as tls from 'node:tls'

/**
 * https agent that tunnels through an HTTP proxy (the app's mixed inbound).
 *
 * Node does not honour HTTP_PROXY on its own and there is no third-party proxy
 * agent in this project, so the CONNECT handshake and the TLS layer on top of it
 * are done by hand. Subclassing Agent rather than passing `createConnection` in
 * the options keeps TypeScript happy (it is a class method, not an AgentOption).
 */
class ProxyHttpsAgent extends https.Agent {
  private readonly proxyPort: number

  constructor(proxyPort: number) {
    super({ keepAlive: false })
    this.proxyPort = proxyPort
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: import('node:stream').Duplex) => void
  ): tls.TLSSocket | undefined {
    const done = (err: Error | null, socket?: tls.TLSSocket): void => callback?.(err, socket as never)
    const host = String(options.host ?? '')
    const targetPort = Number(options.port) || 443
    const connect = http.request({
      host: '127.0.0.1',
      port: this.proxyPort,
      method: 'CONNECT',
      path: `${host}:${targetPort}`,
      timeout: 20_000,
      headers: { Host: `${host}:${targetPort}` }
    })
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        done(new Error(`代理未建立隧道 (HTTP ${res.statusCode})`))
        return
      }
      const secured = tls.connect({ socket, servername: host }, () => done(null, secured))
      secured.on('error', (e) => done(e))
    })
    connect.on('timeout', () => connect.destroy(new Error('代理连接超时')))
    connect.on('error', (e) => done(e))
    connect.end()
    return undefined
  }
}

export function proxyAgent(port: number): https.Agent {
  return new ProxyHttpsAgent(port)
}

export interface GetOptions {
  headers?: Record<string, string>
  /** local mixed-port to tunnel through; omit for a direct connection */
  proxyPort?: number | null
}

export function httpsGet(
  url: string,
  timeoutMs: number,
  onResponse: (res: IncomingMessage) => void,
  options: GetOptions = {}
): ClientRequest {
  const isHttps = url.startsWith('https:')
  const mod = isHttps ? https : http
  const agent = isHttps && options.proxyPort ? proxyAgent(options.proxyPort) : undefined
  const req = mod.get(
    url,
    {
      timeout: timeoutMs,
      agent,
      headers: {
        'User-Agent': 'Dola Toolkit/1.0',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...options.headers
      }
    },
    onResponse
  ) as ClientRequest
  req.on('timeout', () => req.destroy(new Error('请求超时')))
  return req
}

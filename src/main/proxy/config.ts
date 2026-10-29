// ---------------------------------------------------------------------------
// Dola Toolkit — proxy core config generators.
// PURE functions only: no fs, no electron, no network. Unit-testable.
// Import-free except for types, so the file can be compiled standalone.
// ---------------------------------------------------------------------------

import type { CoreId, ProxyNode, ProxySettings, TransportKind } from '@shared/types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function port(v: unknown, fallback = 443): number {
  const n = Math.round(num(v, fallback))
  return n > 0 && n < 65536 ? n : fallback
}

function network(n: ProxyNode): TransportKind {
  const nw = str(n.network, 'tcp') as TransportKind
  return ['tcp', 'ws', 'grpc', 'http', 'h2', 'quic'].includes(nw) ? nw : 'tcp'
}

function isTls(n: ProxyNode): boolean {
  const sec = str(n.security, 'auto')
  return sec === 'tls' || sec === 'reality'
}

function listenHost(settings: ProxySettings): string {
  return settings.allowLan ? '0.0.0.0' : '127.0.0.1'
}

function alpnList(n: ProxyNode): string[] {
  const raw = str(n.alpn)
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '::1/128',
  'fc00::/7',
  'fe80::/10'
]

// ===========================================================================
// Xray
// ===========================================================================

interface XrayStream {
  network: string
  security?: string
  tlsSettings?: Record<string, unknown>
  realitySettings?: Record<string, unknown>
  wsSettings?: Record<string, unknown>
  grpcSettings?: Record<string, unknown>
  httpSettings?: Record<string, unknown>
  tcpSettings?: Record<string, unknown>
}

function xrayStream(n: ProxyNode): XrayStream {
  const nw = network(n)
  const stream: XrayStream = { network: nw === 'h2' ? 'http' : nw }
  const sni = str(n.sni) || str(n.host) || str(n.server)

  if (isTls(n)) {
    stream.security = str(n.security) === 'reality' ? 'reality' : 'tls'
    if (stream.security === 'reality') {
      stream.realitySettings = {
        serverName: sni,
        fingerprint: str(n.fingerprint, 'chrome'),
        publicKey: str(n.publicKey),
        shortId: str(n.shortId),
        spiderX: str(n.spiderX, '/'),
        show: false
      }
    } else {
      const tlsSettings: Record<string, unknown> = {
        serverName: sni,
        // per-node override for servers with self-signed / rotated certificates
        allowInsecure: n.allowInsecure === true,
        fingerprint: str(n.fingerprint)
      }
      const alpn = alpnList(n)
      if (alpn.length) tlsSettings.alpn = alpn
      stream.tlsSettings = tlsSettings
    }
  } else {
    stream.security = 'none'
  }

  if (nw === 'ws') {
    const ws: Record<string, unknown> = { path: str(n.path, '/') }
    const host = str(n.host) || sni
    if (host) ws.headers = { Host: host }
    stream.wsSettings = ws
  } else if (nw === 'grpc') {
    stream.grpcSettings = { serviceName: str(n.serviceName), multiMode: false }
  } else if (nw === 'h2' || nw === 'http') {
    const host = str(n.host) || sni
    const settings: Record<string, unknown> = { path: str(n.path, '/') }
    if (host) settings.host = [host]
    stream.httpSettings = settings
  }
  return stream
}

function xrayOutbound(n: ProxyNode): Record<string, unknown> {
  const server = str(n.server)
  const p = port(n.port)
  const out: Record<string, unknown> = { tag: 'proxy' }
  const tls = tlsFree(n)

  switch (n.protocol) {
    case 'vmess':
      out.protocol = 'vmess'
      out.settings = {
        vnext: [
          {
            address: server,
            port: p,
            users: [
              {
                id: str(n.uuid),
                alterId: Math.round(num(n.alterId, 0)),
                security: 'auto'
              }
            ]
          }
        ]
      }
      break
    case 'vless':
      out.protocol = 'vless'
      out.settings = {
        vnext: [
          {
            address: server,
            port: p,
            users: [
              {
                id: str(n.uuid),
                encryption: 'none',
                flow: str(n.flow)
              }
            ]
          }
        ]
      }
      break
    case 'trojan':
      out.protocol = 'trojan'
      out.settings = {
        servers: [{ address: server, port: p, password: str(n.password) }]
      }
      break
    case 'shadowsocks':
      out.protocol = 'shadowsocks'
      out.settings = {
        servers: [
          {
            address: server,
            port: p,
            method: str(n.method, 'aes-256-gcm'),
            password: str(n.password)
          }
        ]
      }
      break
    case 'socks':
      out.protocol = 'socks'
      out.settings = {
        servers: [
          {
            address: server,
            port: p,
            users: str(n.password) ? [{ user: str(n.uuid), pass: str(n.password) }] : []
          }
        ]
      }
      break
    case 'http':
      out.protocol = 'http'
      out.settings = {
        servers: [
          {
            address: server,
            port: p,
            users: str(n.password) ? [{ user: str(n.uuid), pass: str(n.password) }] : []
          }
        ]
      }
      break
    default:
      // Xray cannot express this protocol; fall back to a direct outbound so the
      // config still starts instead of trapping the user offline.
      out.protocol = 'freedom'
      out.tag = 'proxy'
      break
  }

  if (out.protocol !== 'freedom') out.streamSettings = xrayStream(n)
  out.mux = tls ? { enabled: false, concurrency: -1 } : { enabled: false, concurrency: -1 }
  return out
}

function tlsFree(n: ProxyNode): boolean {
  return n.protocol === 'shadowsocks' || n.protocol === 'socks' || n.protocol === 'http'
}

export function buildXrayConfig(node: ProxyNode, settings: ProxySettings): string {
  const sni = str(node.sni) || str(node.host) || str(node.server)
  const rules: unknown[] = [
    {
      type: 'field',
      ip: ['geoip:private', ...PRIVATE_CIDRS],
      outboundTag: 'direct',
      network: 'tcp,udp'
    },
    {
      type: 'field',
      domain: ['localhost', '*.local', '*.lan'],
      outboundTag: 'direct'
    }
  ]
  if (str(node.host) && str(node.host) !== str(node.server)) {
    // keep the fake Host reachable without looping through the proxy for DNS
    rules.push({ type: 'field', domain: [str(node.host)], outboundTag: 'proxy' })
  }
  /*
   * 绕过大陆: CN domains and IPs leave directly. Xray ships geoip.dat / geosite.dat,
   * so no extra files are needed here.
   */
  if (settings.routingMode !== 'global') {
    rules.push(
      { type: 'field', domain: ['geosite:cn', 'geosite:private'], outboundTag: 'direct' },
      /*
       * Everything known to be foreign goes to the node BY NAME, before any IP is
       * resolved. The node resolves it from its own side, so no local DNS query leaves
       * the machine for those domains — no pollution, and the CDN picks the node's
       * region instead of ours.
       */
      { type: 'field', domain: ['geosite:geolocation-!cn'], outboundTag: 'proxy' },
      { type: 'field', ip: ['geoip:cn'], outboundTag: 'direct' }
    )
  }

  /*
   * QUIC (UDP 443) is dropped after the rules above have had their say, i.e. only for
   * traffic that would be proxied. Most nodes relay UDP poorly, and a stalled QUIC
   * handshake is what makes YouTube sit on a black frame; blocking it makes the browser
   * fall back to TCP immediately, which is consistently faster through a proxy.
   */
  rules.push({ type: 'field', network: 'udp', port: 443, outboundTag: 'block' })

  /*
   * DNS stays domestic, on purpose.
   *
   * The old default (`remoteDns: true`) put 1.1.1.1 FIRST for every lookup, bilibili
   * included. From mainland networks that resolver is lossy or blackholed, so pages
   * stalled on their first DNS round trip, and its answers are geographically wrong —
   * which made `geoip:cn` miss domestic CDNs and send CN traffic through the node.
   * That is the whole story behind "bilibili needs loading, YouTube is slower".
   *
   * Foreign domains no longer need a local resolver at all: they are matched by domain
   * and resolved by the node (see the geolocation-!cn rule below), which also removes
   * any chance of a poisoned answer.
   */
  const dnsServers: unknown[] = settings.remoteDns
    ? [
        // encrypted but still domestic: no hijack, and the CDN answer stays correct
        { address: 'https://dns.alidns.com/dns-query', domains: ['geosite:cn'], skipFallback: true },
        { address: 'https://doh.pub/dns-query', domains: ['geosite:cn'], skipFallback: true },
        { address: '223.5.5.5', skipFallback: true },
        { address: '119.29.29.29' }
      ]
    : [
        { address: '223.5.5.5', skipFallback: true },
        { address: '119.29.29.29' }
      ]

  const config = {
    log: { loglevel: settings.logLevel === 'debug' ? 'debug' : settings.logLevel === 'warn' ? 'warning' : settings.logLevel === 'error' ? 'error' : 'info' },
    dns: {
      servers: dnsServers,
      queryStrategy: settings.ipv6 ? 'UseIP' : 'UseIPv4',
      // keep localhost names off the wire entirely
      hosts: { 'domain:localhost': ['127.0.0.1'] }
    },
    inbounds: [
      {
        tag: 'mixed-in',
        port: port(settings.mixedPort, 7897),
        listen: listenHost(settings),
        protocol: 'mixed',
        settings: { auth: 'noauth', udp: true },
        sniffing: settings.sniffing
          ? { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
          : { enabled: false }
      }
    ],
    outbounds: [
      xrayOutbound(node),
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      { tag: 'block', protocol: 'blackhole', settings: {} }
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      domainMatcher: 'hybrid',
      rules: [...rules, { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }]
    },
    policy: {
      levels: { '0': { handshake: 4, connIdle: 300, uplinkOnly: 1, downlinkOnly: 1 } },
      system: { statsInboundUplink: false, statsInboundDownlink: false }
    }
  }
  void sni
  return JSON.stringify(config, null, 2)
}

/**
 * Xray needs its geo assets next to the binary (or via XRAY_LOCATION_ASSET).
 * The manager sets that env var; this helper only reports what has to exist.
 */
export function xrayGeoEnv(geoDirPath: string): Record<string, string> {
  return { XRAY_LOCATION_ASSET: geoDirPath }
}

// ===========================================================================
// sing-box
// ===========================================================================

/**
 * Hysteria2 pins are written in hex in share links, while sing-box wants the
 * same 32 bytes as base64 (certificate_public_key_sha256). Values that are
 * already base64 are passed through untouched.
 */
function pinToBase64(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  const hex = v.replace(/[^0-9a-fA-F]/g, '')
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    const bytes = Buffer.from(hex, 'hex')
    return bytes.toString('base64')
  }
  return v
}

function sbTls(n: ProxyNode): Record<string, unknown> | undefined {
  if (!isTls(n)) return undefined
  const insecure = n.allowInsecure === true
  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: str(n.sni) || str(n.host) || str(n.server),
    // per-node override: Hysteria2 servers with self-signed certificates, or a
    // share link whose pin no longer matches the server
    insecure
  }
  const fp = str(n.fingerprint)
  if (fp) tls.utls = { enabled: true, fingerprint: fp }
  const alpn = alpnList(n)
  if (alpn.length) tls.alpn = alpn
  /*
   * Hysteria2 servers usually present a self-signed certificate and tell the
   * client to trust it by pinning the server's public key: `pinSHA256` in the
   * share link (hex), `certificate_public_key_sha256` in sing-box (base64).
   * Two traps here:
   *   · the hex was copied over verbatim, which can never match — sing-box
   *     decodes that string as base64 and compares a different digest;
   *   · sing-box enforces the pin even when `insecure` is true, so a stale pin
   *     still breaks the handshake. The pin is therefore only emitted when the
   *     user has not opted out of verification.
   */
  if (!insecure) {
    const pin = pinToBase64(str(n.pinSHA256))
    if (pin) tls.certificate_public_key_sha256 = [pin]
  }
  if (str(n.security) === 'reality') {
    tls.reality = {
      enabled: true,
      public_key: str(n.publicKey),
      short_id: str(n.shortId)
    }
  }
  return tls
}

function sbTransport(n: ProxyNode): Record<string, unknown> | undefined {
  const nw = network(n)
  if (nw === 'ws') {
    const ws: Record<string, unknown> = { type: 'ws', path: str(n.path, '/') }
    const host = str(n.host) || str(n.sni)
    if (host) ws.headers = { Host: host }
    const ed = num(0)
    if (ed > 0) ws.max_early_data = ed
    return ws
  }
  if (nw === 'grpc') {
    return { type: 'grpc', service_name: str(n.serviceName) }
  }
  if (nw === 'h2' || nw === 'http') {
    const http: Record<string, unknown> = { type: 'http', path: str(n.path, '/') }
    const host = str(n.host) || str(n.sni)
    if (host) http.host = [host]
    return http
  }
  return undefined
}

function sbOutbound(n: ProxyNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tag: 'proxy',
    server: str(n.server),
    server_port: port(n.port),
    /*
     * Resolve destination domains on the CLIENT instead of forwarding the name
     * to the server. Hysteria2 servers resolve with their own system resolver;
     * when that resolver cannot answer (a domestic resolver asked for a
     * googlevideo host, for example) every connection dies with
     * "resolve error: ... no such host" and the proxy looks like it keeps
     * dropping even though the tunnel itself is fine.
     */
    domain_strategy: 'prefer_ipv4'
  }

  switch (n.protocol) {
    case 'vmess':
      base.type = 'vmess'
      base.uuid = str(n.uuid)
      base.security = 'auto'
      base.alter_id = Math.round(num(n.alterId, 0))
      break
    case 'vless':
      base.type = 'vless'
      base.uuid = str(n.uuid)
      if (str(n.flow)) base.flow = str(n.flow)
      break
    case 'trojan':
      base.type = 'trojan'
      base.password = str(n.password)
      break
    case 'shadowsocks':
      base.type = 'shadowsocks'
      base.method = str(n.method, 'aes-256-gcm')
      base.password = str(n.password)
      break
    case 'socks':
      base.type = 'socks'
      base.version = '5'
      if (str(n.uuid)) base.username = str(n.uuid)
      if (str(n.password)) base.password = str(n.password)
      break
    case 'http':
      base.type = 'http'
      if (str(n.uuid)) base.username = str(n.uuid)
      if (str(n.password)) base.password = str(n.password)
      break
    case 'hysteria2':
      base.type = 'hysteria2'
      base.password = str(n.password)
      if (str(n.obfs)) {
        base.obfs = { type: str(n.obfs), password: str(n.obfsParam) }
      }
      if (num(n.upMbps) > 0) base.up_mbps = Math.round(num(n.upMbps))
      if (num(n.downMbps) > 0) base.down_mbps = Math.round(num(n.downMbps))
      break
    case 'tuic':
      base.type = 'tuic'
      base.uuid = str(n.uuid)
      base.password = str(n.password)
      base.congestion_control = 'bbr'
      base.udp_relay_mode = 'native'
      break
    case 'anytls':
      base.type = 'anytls'
      base.password = str(n.password)
      break
    default:
      base.type = 'direct'
      delete base.server
      delete base.server_port
      break
  }

  const tls = sbTls(n)
  if (tls && base.type !== 'direct') base.tls = tls
  const transport = sbTransport(n)
  if (transport && base.type !== 'direct') base.transport = transport
  if (base.type === 'hysteria2' || base.type === 'tuic') {
    if (!base.tls) base.tls = { enabled: true, server_name: str(n.sni) || str(n.server) }
  }
  return base
}

export function buildSingBoxConfig(
  node: ProxyNode,
  settings: ProxySettings,
  /** CN rule-set files; omitted by callers that only need a plain config */
  cnRuleSets: { geosite: string | null; geoip: string | null } = { geosite: null, geoip: null }
): string {
  const bypass = settings.routingMode !== 'global'
  const ruleSets = bypass ? cnRuleSets : { geosite: null, geoip: null }
  const useRuleSets = bypass && Boolean(ruleSets.geosite || ruleSets.geoip)
  const ruleSetDefs: Record<string, unknown>[] = []
  const cnRuleSetTags: string[] = []
  if (ruleSets.geosite) {
    ruleSetDefs.push({ type: 'local', tag: 'geosite-cn', format: 'binary', path: ruleSets.geosite })
    cnRuleSetTags.push('geosite-cn')
  }
  if (ruleSets.geoip) {
    ruleSetDefs.push({ type: 'local', tag: 'geoip-cn', format: 'binary', path: ruleSets.geoip })
    cnRuleSetTags.push('geoip-cn')
  }

  /*
   * Resolution stays domestic, and it is the DEFAULT rather than an exception.
   *
   * Previously every name that was not in the CN list was resolved through DoH over the
   * tunnel (`dns.final: 'remote'`), so a bilibili lookup that missed the list waited for
   * a round trip through the node before the connection could even start — measured at
   * 1.5 s versus 0.19 s direct.
   *
   * Foreign destinations do not need a local answer at all: the proxy outbound receives
   * the domain and lets the node resolve it, so a poisoned local answer can never be
   * used. What the local resolver IS needed for is deciding "is this CN?", which is
   * exactly what it is good at.
   */
  const dnsServers: Record<string, unknown>[] = [
    // the plain resolver doubles as the bootstrap for the encrypted one below
    { type: 'udp', tag: 'local', server: '223.5.5.5' },
    { type: 'udp', tag: 'local2', server: '119.29.29.29' }
  ]
  if (settings.remoteDns) {
    // still domestic — just encrypted, so a local hijack cannot rewrite the answer
    dnsServers.push({
      type: 'https',
      tag: 'local-doh',
      server: 'dns.alidns.com',
      domain_resolver: 'local'
    })
  }
  const dnsRules: Record<string, unknown>[] = []

  const routeRules: Record<string, unknown>[] = [
    ...(settings.sniffing
      ? [{ action: 'sniff', inbound: ['mixed-in'], timeout: '300ms' } as Record<string, unknown>]
      : []),
    { ip_is_private: true, outbound: 'direct' },
    // CN traffic leaves directly, so domestic sites are not routed abroad
    ...(useRuleSets && cnRuleSetTags.length ? [{ rule_set: cnRuleSetTags, outbound: 'direct' }] : []),
    /*
     * Everything NOT in the CN list goes to the node BY NAME, before any IP rule can
     * force a local lookup.
     *
     * Without this the `geoip-cn` rule below resolved foreign domains with the local
     * resolver, and a poisoned answer (youtube.com → a CN address) made it look domestic
     * and route directly, which simply failed. Matching on the name avoids resolving at
     * all: the node receives the domain and resolves it on its own side.
     */
    ...(useRuleSets && ruleSets.geosite
      ? [{ rule_set: ['geosite-cn'], invert: true, outbound: 'proxy' }]
      : []),
    /*
     * Drop QUIC after the direct rules (first match wins, so this only catches traffic
     * that would have been proxied). Node relay of UDP 443 is the usual reason a video
     * sits on a black frame; browsers fall back to TCP instantly.
     */
    { network: 'udp', port: [443], action: 'reject' }
  ]

  const config = {
    log: {
      level: settings.logLevel === 'debug' ? 'debug' : settings.logLevel === 'warn' ? 'warn' : settings.logLevel === 'error' ? 'error' : 'info',
      timestamp: true
    },
    dns: {
      servers: dnsServers,
      rules: dnsRules,
      final: settings.remoteDns ? 'local-doh' : 'local',
      strategy: settings.ipv6 ? 'prefer_ipv4' : 'ipv4_only'
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: listenHost(settings),
        listen_port: port(settings.mixedPort, 7897)
      }
    ],
    outbounds: [
      sbOutbound(node),
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ],
    route: {
      // sing-box 1.13+ moved sniffing from inbound fields to route actions.
      rules: routeRules,
      rule_set: ruleSetDefs,
      final: 'proxy',
      auto_detect_interface: true,
      // rule matching resolves locally; proxied connections still hand the domain to
      // the node, so this cannot leak a poisoned answer to a foreign site
      default_domain_resolver: 'local'
    },
    experimental: {
      cache_file: { enabled: false },
      clash_api: { external_controller: '127.0.0.1:0', default_mode: 'rule' }
    }
  }
  return JSON.stringify(config, null, 2)
}

/** sing-box 1.14 needs a resolvable `type` on every DNS server; validate ours. */
export function singBoxConfigIssues(config: unknown): string[] {
  const issues: string[] = []
  const c = config as { dns?: { servers?: unknown[] }; outbounds?: unknown[]; inbounds?: unknown[] }
  if (!Array.isArray(c.outbounds) || c.outbounds.length < 2) issues.push('outbounds missing')
  if (!Array.isArray(c.inbounds) || c.inbounds.length === 0) issues.push('inbounds missing')
  if (c.dns && Array.isArray(c.dns.servers)) {
    for (const s of c.dns.servers) {
      const srv = s as { type?: unknown; server?: unknown }
      if (typeof srv.type !== 'string') issues.push('dns server without type')
      if (typeof srv.server !== 'string') issues.push('dns server without server')
    }
  }
  return issues
}

// ===========================================================================
// Mihomo (YAML, hand-built — no yaml dependency)
// ===========================================================================

/** Quote anything that is not a plain alphanumeric / dash / dot token. */
export function yamlStr(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v)
  if (s === '') return '""'
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) {
    return s
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

function yamlBool(v: boolean): string {
  return v ? 'true' : 'false'
}

function yamlNum(v: number): string {
  return Number.isFinite(v) ? String(v) : '0'
}

interface YamlMap {
  [key: string]: YamlValue
}
type YamlValue = string | number | boolean | YamlValue[] | YamlMap

function emitYaml(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    return value
      .map((v) => {
        if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
          const nested = emitYaml(v, indent + 2)
          return `${pad}- ${nested.trimStart()}`
        }
        return `${pad}- ${String(v)}`
      })
      .join('\n')
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`
          return `${pad}${k}:\n${emitYaml(v, indent + 2)}`
        }
        if (typeof v === 'object' && v !== null) {
          return `${pad}${k}:\n${emitYaml(v, indent + 2)}`
        }
        return `${pad}${k}: ${String(v)}`
      })
      .join('\n')
  }
  return `${pad}${String(value)}`
}

function mihomoProxy(n: ProxyNode): YamlMap {
  const p: YamlMap = {
    name: 'NODE',
    type: 'ss',
    server: yamlStr(n.server),
    port: port(n.port),
    udp: true
  }
  const sni = str(n.sni) || str(n.host) || str(n.server)
  const nw = network(n)

  switch (n.protocol) {
    case 'vmess':
      p.type = 'vmess'
      p.uuid = yamlStr(n.uuid)
      p.alterId = Math.round(num(n.alterId, 0))
      p.cipher = 'auto'
      if (isTls(n)) {
        p.tls = true
        p.servername = yamlStr(sni)
      }
      if (str(n.fingerprint)) p['client-fingerprint'] = yamlStr(n.fingerprint)
      break
    case 'vless':
      p.type = 'vless'
      p.uuid = yamlStr(n.uuid)
      if (isTls(n)) {
        p.tls = true
        p.servername = yamlStr(sni)
      }
      if (str(n.fingerprint)) p['client-fingerprint'] = yamlStr(n.fingerprint)
      if (str(n.flow)) p.flow = yamlStr(n.flow)
      if (str(n.security) === 'reality') {
        p['reality-opts'] = {
          'public-key': yamlStr(n.publicKey),
          'short-id': yamlStr(n.shortId)
        }
      }
      break
    case 'trojan':
      p.type = 'trojan'
      p.password = yamlStr(n.password)
      p.sni = yamlStr(sni)
      p['skip-cert-verify'] = false
      break
    case 'shadowsocks':
      p.type = 'ss'
      p.cipher = yamlStr(str(n.method, 'aes-256-gcm'))
      p.password = yamlStr(n.password)
      if (str(n.obfs)) {
        p.plugin = 'obfs'
        p['plugin-opts'] = { mode: yamlStr(n.obfs), host: yamlStr(n.obfsParam) }
      }
      break
    case 'socks':
      p.type = 'socks5'
      if (str(n.uuid)) p.username = yamlStr(n.uuid)
      if (str(n.password)) p.password = yamlStr(n.password)
      break
    case 'http':
      p.type = 'http'
      if (str(n.uuid)) p.username = yamlStr(n.uuid)
      if (str(n.password)) p.password = yamlStr(n.password)
      if (isTls(n)) {
        p.tls = true
        p.sni = yamlStr(sni)
      }
      break
    case 'hysteria2':
      p.type = 'hysteria2'
      p.password = yamlStr(n.password)
      p.sni = yamlStr(sni)
      p['skip-cert-verify'] = false
      /*
       * Nodes that pin a certificate (pinSHA256) otherwise fail TLS verification
       * outright, so every proxied request errors out. mihomo calls the pinned hash
       * `fingerprint`.
       */
      if (str(n.pinSHA256)) p.fingerprint = yamlStr(str(n.pinSHA256).toLowerCase())
      delete p.udp
      if (str(n.obfs)) {
        p.obfs = yamlStr(n.obfs)
        p['obfs-password'] = yamlStr(n.obfsParam)
      }
      if (num(n.upMbps) > 0) p.up = yamlStr(`${Math.round(num(n.upMbps))} Mbps`)
      if (num(n.downMbps) > 0) p.down = yamlStr(`${Math.round(num(n.downMbps))} Mbps`)
      break
    case 'tuic':
      p.type = 'tuic'
      p.uuid = yamlStr(n.uuid)
      p.password = yamlStr(n.password)
      p.sni = yamlStr(sni)
      p.alpn = ['h3']
      p['congestion-controller'] = 'bbr'
      p['udp-relay-mode'] = 'native'
      p['skip-cert-verify'] = false
      break
    case 'anytls':
      p.type = 'anytls'
      p.password = yamlStr(n.password)
      p.sni = yamlStr(sni)
      p['skip-cert-verify'] = false
      break
    case 'wireguard':
      p.type = 'wireguard'
      p.ip = yamlStr(str(n.uuid, '172.16.0.2/32'))
      p['private-key'] = yamlStr(str(n.password))
      p['public-key'] = yamlStr(str(n.publicKey))
      p['allowed-ips'] = ['0.0.0.0/0']
      break
    default:
      p.type = 'socks5'
      break
  }

  // transport for the protocol types that support it
  if (['vmess', 'vless', 'trojan'].includes(str(p.type))) {
    if (nw === 'ws') {
      p.network = 'ws'
      const ws: YamlMap = { path: yamlStr(str(n.path, '/')) }
      const host = str(n.host) || sni
      if (host) ws.headers = { Host: yamlStr(host) }
      p['ws-opts'] = ws
    } else if (nw === 'grpc') {
      p.network = 'grpc'
      p['grpc-opts'] = { 'grpc-service-name': yamlStr(n.serviceName) }
    } else if (nw === 'h2' || nw === 'http') {
      p.network = 'h2'
      const h2: YamlMap = { path: yamlStr(str(n.path, '/')) }
      const host = str(n.host) || sni
      if (host) h2.host = [yamlStr(host)]
      p['h2-opts'] = h2
    } else {
      p.network = 'tcp'
    }
    const alpn = alpnList(n)
    if (alpn.length) p.alpn = alpn.map((a) => yamlStr(a))
  }

  // YAML-safe scalars: never let mihomo see an unquoted weird string.
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && !v.startsWith('"') && k !== 'type' && k !== 'cipher') {
      p[k] = yamlStr(v)
    }
  }
  return p
}

export function buildMihomoConfig(node: ProxyNode, settings: ProxySettings): string {
  const proxy = mihomoProxy(node)
  const doc: YamlMap = {
    'mixed-port': port(settings.mixedPort, 7897),
    'allow-lan': settings.allowLan,
    'bind-address': yamlStr(listenHost(settings)),
    mode: 'rule',
    'log-level': settings.logLevel,
    ipv6: settings.ipv6,
    // Use the bundled .dat assets instead of downloading an MMDB at runtime.
    'geodata-mode': true,
    'geodata-loader': 'standard',
    'geo-auto-update': false,
    'unified-delay': true,
    'tcp-concurrent': true,
    'external-controller': yamlStr('127.0.0.1:0'),
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: {
      enable: true,
      ipv6: settings.ipv6,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['223.5.5.5', '119.29.29.29'].map((s) => yamlStr(s)),
      fallback: settings.remoteDns
        ? ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'].map((s) => yamlStr(s))
        : [],
      'fallback-filter': { geoip: true, 'geoip-code': 'CN' },
      // CN names never leave for a foreign resolver, so CDN answers stay local
      'nameserver-policy': {
        'geosite:cn': ['223.5.5.5', '119.29.29.29']
      }
    },
    proxies: [proxy],
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['NODE', 'DIRECT']
      }
    ],
    rules: [
      'GEOIP,private,DIRECT',
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,local,DIRECT',
      'DOMAIN-SUFFIX,lan,DIRECT',
      // 绕过大陆: mihomo carries its own GEOSITE / GEOIP databases
      ...(settings.routingMode !== 'global'
        ? ['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT', 'GEOSITE,private,DIRECT']
        : []),
      // proxied QUIC is slower than the TCP fallback on most nodes
      'AND,((NETWORK,udp),(DST-PORT,443)),REJECT',
      'MATCH,PROXY'
    ]
  }
  const header = [
    '# Dola Toolkit — generated mihomo config (do not edit, rewritten on every start)',
    `# node: ${str(node.name, 'unnamed')} (${str(node.protocol)}) engine: mihomo`,
    ''
  ].join('\n')
  return `${header}${emitYaml(doc as YamlValue)}\n`
}

/** Minimal YAML sanity check used by the self-test (not a real parser). */
export function validateMihomoYaml(text: string): string[] {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  if (!/^mixed-port:\s*\d+/m.test(text)) problems.push('missing mixed-port')
  if (!/^proxies:/m.test(text)) problems.push('missing proxies')
  if (!/^rules:/m.test(text)) problems.push('missing rules')
  const seen = new Map<string, number>()
  lines.forEach((line, i) => {
    if (line.trim().startsWith('#') || !line.trim()) return
    if (/^\t/.test(line)) problems.push(`tab indentation at line ${i + 1}`)
    const open = (line.match(/"/g) ?? []).length
    if (open % 2 !== 0) problems.push(`unbalanced quotes at line ${i + 1}: ${line.trim()}`)
    const key = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line)
    if (key) {
      const sig = `${key[1].length}|${key[2]}`
      seen.set(sig, (seen.get(sig) ?? 0) + 1)
    }
  })
  for (const [sig, count] of seen) {
    const [indent, key] = sig.split('|')
    if (key === 'type' || key === 'name' || key === 'path' || key === 'mode') continue
    if (count > 1) problems.push(`duplicate key "${key}" at indent ${indent}`)
  }
  return problems
}

// ===========================================================================
// Dispatch
// ===========================================================================

export function buildCoreConfig(
  engine: CoreId,
  node: ProxyNode,
  settings: ProxySettings,
  cnRuleSets: { geosite: string | null; geoip: string | null } = { geosite: null, geoip: null }
): string {
  switch (engine) {
    case 'xray':
      return buildXrayConfig(node, settings)
    case 'singbox':
      return buildSingBoxConfig(node, settings, cnRuleSets)
    case 'mihomo':
      return buildMihomoConfig(node, settings)
    default:
      return buildXrayConfig(node, settings)
  }
}

export function configFileName(engine: CoreId): string {
  return engine === 'mihomo' ? 'config.yaml' : 'config.json'
}

/** argv for a foreground run; the first element is the subcommand when needed. */
export function startArgs(engine: CoreId, configPath: string, homeDir?: string): string[] {
  switch (engine) {
    case 'xray':
      return ['run', '-c', configPath]
    case 'singbox':
      return ['run', '-c', configPath, '--disable-color']
    case 'mihomo':
      /*
       * `-d` matters: without it mihomo uses its global home (~/.config/mihomo), so it
       * could not see the GeoIP.dat / Geosite.dat that bootstrapGeo puts next to the
       * config, and tried to download and then delete files in the user profile — which
       * failed and aborted the start with "can't remove invalid GeoIP.dat".
       */
      return homeDir ? ['-d', homeDir, '-f', configPath] : ['-f', configPath]
    default:
      return ['-c', configPath]
  }
}

export function testArgs(engine: CoreId, configPath: string, homeDir?: string): string[] {
  switch (engine) {
    case 'xray':
      return ['run', '-test', '-c', configPath]
    case 'singbox':
      return ['check', '-c', configPath, '--disable-color']
    case 'mihomo':
      // the same `-d` as startArgs: validation must resolve its geo assets identically,
      // otherwise `-t` reports an error the real run would not hit (or vice versa)
      return homeDir ? ['-d', homeDir, '-t', '-f', configPath] : ['-t', '-f', configPath]
    default:
      return ['-t', '-f', configPath]
  }
}

export function isJsonEngine(engine: CoreId): boolean {
  return engine !== 'mihomo'
}


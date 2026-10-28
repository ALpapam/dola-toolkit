export function fmtBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

export function fmtDate(ts: number | string | null | undefined): string {
  if (!ts) return '—'
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff >= 0 && diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 时 ${m % 60} 分`
}

/** "#RRGGBB" → "rgba(r,g,b,a)" */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** stable pleasant color from a string (used for generated book covers) */
export function hashColor(input: string, light = 42, sat = 46): string {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} ${sat}% ${light}%)`
}

export function hashHue(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0
  return h % 360
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function shortPath(p: string, max = 46): string {
  if (p.length <= max) return p
  return `…${p.slice(p.length - max + 1)}`
}

export function formatProtocol(p: string): string {
  const map: Record<string, string> = {
    vmess: 'VMess',
    vless: 'VLESS',
    trojan: 'Trojan',
    shadowsocks: 'SS',
    socks: 'SOCKS',
    http: 'HTTP',
    hysteria2: 'Hy2',
    tuic: 'TUIC',
    anytls: 'AnyTLS',
    wireguard: 'WG'
  }
  return map[p] ?? p.toUpperCase()
}

export function engineLabel(e: string): string {
  return e === 'xray' ? 'Xray' : e === 'mihomo' ? 'Mihomo' : e === 'singbox' ? 'Sing-box' : e
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_\-–—:：·,，.。()（）[\]【】]+/g, '')
    .trim()
}

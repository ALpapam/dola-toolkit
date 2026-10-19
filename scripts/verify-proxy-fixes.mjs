// Definitive verification of the three reported proxy bugs.
// The upstream is a real, correct HTTP proxy (scripts/local-http-proxy.mjs) so
// "can we actually proxy?" is proven end to end, not just asserted.
import { spawn, execFileSync } from 'node:child_process'

const PORT = Number(process.env.CDP_PORT ?? 9360)
const UPSTREAM = 18099
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : r(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const PS = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const regProxy = () => {
  try {
    return execFileSync(
      PS,
      [
        '-NoProfile',
        '-Command',
        "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';\"$($p.ProxyEnable)|$($p.ProxyServer)\""
      ],
      { encoding: 'utf8' }
    ).trim()
  } catch {
    return 'ERR'
  }
}

function getViaProxy(proxyPort, url) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    `  $req = [System.Net.HttpWebRequest]::Create([System.Uri]'${url}')`,
    `  $req.Proxy = New-Object System.Net.WebProxy('http://127.0.0.1:${proxyPort}', $false)`,
    '  $req.Timeout = 12000',
    "  $resp = $req.GetResponse()",
    '  $code = [int]$resp.StatusCode',
    '  $resp.Close()',
    '  Write-Output $code',
    '} catch [System.Net.WebException] {',
    '  if ($_.Exception.Response) { Write-Output ([int]$_.Exception.Response.StatusCode) }',
    "  else { Write-Output ('ERR:' + $_.Exception.Message) }",
    '} catch {',
    "  Write-Output ('ERR:' + $_.Exception.Message)",
    '}'
  ].join('\n')
  try {
    return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
  } catch {
    return 'ERR'
  }
}

async function main() {
  const upstream = spawn('node', ['scripts/local-http-proxy.mjs', String(UPSTREAM)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true
  })
  await sleep(1600)
  console.log(`upstream http proxy on 127.0.0.1:${UPSTREAM}\n`)

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description ?? '')
    return r.result?.value
  }
  const state = async () =>
    await ev(`(async()=>{const s=await window.api.proxy.state(); return {
      uiSys: s.systemProxy, allowLan: s.settings.allowLan,
      running: !!s.engines.find(e=>e.running),
      pid: (s.engines.find(e=>e.running)||{}).pid ?? null,
      err: (s.engines.find(e=>e.error)||{}).error ?? null
    }})()`)
  await sleep(2200)

  const st = await ev(`window.api.proxy.state()`)
  for (const n of st.nodes) await ev(`window.api.proxy.deleteNode(${JSON.stringify(n.id)})`)
  const node = await ev(
    `window.api.proxy.saveNode({ name:'local-upstream', protocol:'http', engine:'xray', server:'127.0.0.1', port:${UPSTREAM} })`
  )
  await ev(`window.api.proxy.selectNode(${JSON.stringify(node?.id)})`)
  check('节点就绪', Boolean(node?.id))

  // ---------- A: system proxy only ----------
  console.log('\n=== A: 只开系统代理（allowLan=false）===')
  await ev(`window.api.settings.patch({proxy:{allowLan:false, systemProxy:true}})`)
  await sleep(800)
  await ev(`window.api.proxy.stop()`)
  await sleep(2000)
  await ev(`window.api.proxy.start()`)
  await sleep(4000)
  const a = await state()
  check('核心运行', a.running === true, JSON.stringify(a))
  check('UI 系统代理=开', a.uiSys === true)
  const regA = regProxy()
  check('注册表 = 1|127.0.0.1:7897', regA === '1|127.0.0.1:7897', regA)
  const codeA = getViaProxy(7897, 'http://example.com/')
  check('经 7897 实际代理成功', codeA === '200', `code=${codeA}`)

  // ---------- B: allowLan + system proxy, watch for flapping ----------
  console.log('\n=== B: 再开允许局域网，观察系统代理是否抖动 ===')
  await ev(`window.api.settings.patch({proxy:{allowLan:true}})`)
  await sleep(1500)
  const samples = []
  for (let i = 0; i < 24; i++) {
    samples.push(regProxy())
    await sleep(500)
  }
  check('12 秒内系统代理稳定', new Set(samples).size === 1, [...new Set(samples)].join(' , '))
  const b = await state()
  check('核心仍在运行', b.running === true, JSON.stringify(b))
  const codeB = getViaProxy(7897, 'http://example.com/')
  check('局域网模式下仍可代理', codeB === '200', `code=${codeB}`)

  // ---------- C: switch node while running ----------
  console.log('\n=== C: 运行中切换节点 ===')
  const before = regProxy()
  const sD = []
  const n2 = await ev(
    `window.api.proxy.saveNode({ name:'second', protocol:'http', engine:'xray', server:'127.0.0.1', port:${UPSTREAM} })`
  )
  await ev(`window.api.proxy.selectNode(${JSON.stringify(n2?.id)})`)
  for (let i = 0; i < 16; i++) {
    sD.push(regProxy())
    await sleep(500)
  }
  check('切换节点期间系统代理稳定', new Set(sD).size === 1, [...new Set(sD)].join(' , '))
  check('切换后仍为开', regProxy().startsWith('1|'), `${before} -> ${regProxy()}`)
  const d = await state()
  check('切换后核心运行', d.running === true, JSON.stringify(d))
  const codeD = getViaProxy(7897, 'http://example.com/')
  check('切换后仍可代理', codeD === '200', `code=${codeD}`)

  // ---------- D: stop must be clean ----------
  console.log('\n=== D: 停止 ===')
  await ev(`window.api.proxy.stop()`)
  await sleep(3500)
  const e1 = await state()
  check('停止后未运行', e1.running === false, JSON.stringify(e1))
  check('停止后系统代理关闭', e1.uiSys === false)
  await sleep(3500)
  const e2 = await state()
  check('6 秒内无自动重启', e2.running === false, JSON.stringify(e2))
  const regD = regProxy()
  check('注册表已还原', !regD.includes('127.0.0.1:7897') || regD.startsWith('0|'), regD)

  try {
    upstream.kill()
  } catch {
    /* ignore */
  }
  ws.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

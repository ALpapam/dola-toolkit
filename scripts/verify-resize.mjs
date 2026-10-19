// Verify the reader switches layouts when the REAL OS window is resized.
// Uses user32.SetWindowPos (no CDP emulation, which leaks between CDP sessions).
import { execFileSync } from 'node:child_process'

const PORT = Number(process.env.CDP_PORT ?? 9355)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resizeWindow(width, height) {
  const ps = `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);'
$p = Get-Process Dola Toolkit,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Dola Toolkit*' } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_WINDOW'; exit }
[W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W.U]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, 60, 60, ${width}, ${height}, 0x0004) | Out-Null
Write-Output "OK $($p.Id)"
`
  return execFileSync(process.env.SYSTEMROOT + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result)
      pend.delete(m.id)
    }
  })
  const send = (mm, p) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method: mm, params: p }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || '')
    return r.result?.value
  }
  await send('Runtime.enable')

  // make sure the long book is open
  const open = await ev(`!!document.querySelector('.reader')`)
  if (!open) {
    await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
    await sleep(1200)
    await ev(`(()=>{const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').includes('长篇')); if(c)c.click(); return !!c})()`)
    await sleep(2800)
  }

  const probe = `JSON.stringify({
    innerW: window.innerWidth,
    stageW: Math.round(document.querySelector('.reader-stage').getBoundingClientRect().width),
    stageH: Math.round(document.querySelector('.reader-stage').getBoundingClientRect().height),
    pages: document.querySelectorAll('.reader-page').length,
    pageW: [...document.querySelectorAll('.reader-page')].map(p => Math.round(p.getBoundingClientRect().width)),
    overflow: (() => {
      const sp = document.querySelector('.reader-spread')
      const st = document.querySelector('.reader-stage')
      if (!sp || !st) return null
      const a = sp.getBoundingClientRect(), b = st.getBoundingClientRect()
      return a.width > b.width + 2 || a.height > b.height + 2
    })(),
    label: document.querySelector('.pgnum')?.textContent
  })`

  for (const [w, h] of [
    [1280, 820],
    [1000, 820],
    [820, 820],
    [760, 820],
    [680, 760],
    [1280, 820]
  ]) {
    resizeWindow(w, h)
    await sleep(1500)
    console.log(`${String(w).padStart(4)}x${h}`, await ev(probe))
  }
  ws.close()
  process.exit(0)
}
main()

// Open a prose book, drag the bottom-right corner, then sample the completion
// animation frame-by-frame with requestAnimationFrame (the only reliable way —
// Page.captureScreenshot is far slower than the animation itself).
const PORT = Number(process.env.CDP_PORT ?? 9331)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(1600)

// make sure a prose book exists and is open
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-cn.txt']) }catch(e){} })()`)
await sleep(2200)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT'))||document.querySelector('.book-card'); c?.click() })()`)
await sleep(3400)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(900)

// instrument: record projected width + shade every animation frame
await ev(`(() => {
  window.__raf = []
  window.__rafOn = true
  const el = document.querySelector('.reader-page-turnable')
  if (!el) return 'no el'
  const tick = () => {
    if (!window.__rafOn) return
    const b = el.getBoundingClientRect()
    const shade = getComputedStyle(el, '::after').opacity
    window.__raf.push([Math.round(b.width), +Number(shade).toFixed(3)])
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return 'ok'
})()`)

const g = JSON.parse(await ev(`(()=>{const p=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:p.x,y:p.y,w:p.width,h:p.height})})()`))
const sx = g.x + g.w * 0.85
const sy = g.y + g.h * 0.88
await mouse('mousePressed', sx, sy)
for (let i = 1; i <= 10; i++) {
  await mouse('mouseMoved', sx - (g.w * 0.5 * i) / 10, sy)
  await sleep(24)
}
await ev(`window.__raf = []`) // discard the drag frames, keep only the release
await mouse('mouseReleased', sx - g.w * 0.5, sy)
await sleep(900)

const frames = JSON.parse(await ev(`JSON.stringify(window.__raf)`))
await ev(`window.__rafOn = false`)

console.log('松手后逐帧 [投影宽度, 光影]:')
frames.forEach(([w, s], i) => console.log(`  frame ${String(i).padStart(2)}: w=${String(w).padStart(4)}  shade=${s}`))
const widths = frames.map((f) => f[0])
const shades = frames.map((f) => f[1])
console.log(`\n总帧数 ${frames.length}`)
console.log(`不同宽度 ${new Set(widths).size} 个 / 不同光影 ${new Set(shades).size} 个`)
const smooth = new Set(widths).size >= 8
console.log(smooth ? '✅ 逐帧平滑补间（动画生效）' : '❌ 仍在跳变')
console.log('最终页码:', await ev(`document.querySelector('.pgnum')?.textContent`))
ws.close()
process.exit(smooth ? 0 : 1)

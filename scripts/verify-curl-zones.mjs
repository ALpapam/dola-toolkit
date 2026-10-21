// Tap zones replaced drag-to-turn:
//   right third → next page, left third → previous page, middle third → nothing
// (the middle stays inert so text selection still works there).
// Also checks the < > buttons still work and that the old drag settings are gone.
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

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)
  ok ? pass++ : fail++
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.clearDeviceMetricsOverride')
await sleep(1600)

await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-cn.txt']) }catch(e){} })()`)
await sleep(2400)
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'},reader:{gpuAcceleration:true}}) })()`)
await sleep(1000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2200)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT')); c?.click() })()`)
await sleep(3800)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1300)

const page = () => ev(`document.querySelector('.pgnum')?.textContent`)
const paper = async () =>
  JSON.parse(
    await ev(`(()=>{const e=document.querySelector('.reader-spread.current')||document.querySelector('.reader-page');
      const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`)
  )
/** click at a horizontal fraction of the sheet */
async function tap(frac) {
  const r = await paper()
  const x = r.x + r.w * frac
  const y = r.y + r.h * 0.5
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1200)
}

/* ---- tap zones ---- */
{
  const b = await page()
  await tap(0.85)
  check('点右侧 1/3 = 下一页', (await page()) !== b, `${b} -> ${await page()}`)
}
{
  const b = await page()
  await tap(0.15)
  check('点左侧 1/3 = 上一页', (await page()) !== b, `${b} -> ${await page()}`)
}
{
  const b = await page()
  await tap(0.5)
  check('点中间 1/3 = 不翻页', (await page()) === b, `仍为 ${b}`)
}
{
  // just inside each boundary
  const b = await page()
  await tap(0.70)
  check('中点 70% 处算右侧', (await page()) !== b, `${b} -> ${await page()}`)
  const b2 = await page()
  await tap(0.30)
  check('中点 30% 处算左侧', (await page()) !== b2, `${b2} -> ${await page()}`)
}

/* ---- buttons still work (and do not double-turn) ---- */
{
  const b = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await sleep(1200)
  const a = await page()
  const n = Number((/^(\d+)/.exec(b) || [0, 0])[1])
  const m = Number((/^(\d+)/.exec(a) || [0, 0])[1])
  check('按钮翻页只前进一跨页（无双重触发）', m - n === 2, `${b} -> ${a}`)
}

/* ---- drag settings removed ---- */
{
  const s = JSON.parse(await ev(`(async()=>{ const st=await window.api.settings.get(); return JSON.stringify(st.reader) })()`))
  check('设置里已移除拖动翻页', s.dragFlip === undefined, JSON.stringify(Object.keys(s)))
  check('设置里已移除触发距离', s.dragThreshold === undefined)
  const ui = await ev(`(()=>{const t=[...document.querySelectorAll('.set-item-title')].map(e=>e.textContent.trim()); return JSON.stringify(t)})()`)
  const titles = JSON.parse(await ev(`(()=>{ location.hash=''; return '[]' })()`))
  void titles
  void ui
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

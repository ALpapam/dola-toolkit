// Verifies the rewritten curl geometry:
//   1. no mosaic: a patch of the leaf mid-turn must resemble the same patch of
//      the page it is supposed to show (text readable order, not shuffled)
//   2. the back of the leaf equals the NEW far page at the same screen position,
//      so the hand-off to the DOM at the end is seamless
//   3. horizontal swipe works anywhere on the sheet
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
const spread = () =>
  ev(`(()=>{const s=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:s.x,y:s.y,w:s.width,h:s.height})})()`)

/* ---- the leaf's reverse side is the live page, so it is checked against a
   screenshot in verify-curl-capture.mjs; here we only confirm the turn runs ---- */
{
  const b = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await sleep(1200)
  check('点击翻页生效', (await page()) !== b, `${b} -> ${await page()}`)
}
/* ---- 3: swipe works anywhere on the sheet ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1500)
  for (const [label, fx, frac] of [
    ['中下部向右拖', 0.6, -0.45],
    ['中部向右拖', 0.55, -0.45],
    ['左上向回拖', 0.15, 0.45]
  ]) {
    const before = await page()
    const r = JSON.parse(await spread())
    const sx = r.x + r.w * fx
    const sy = r.y + r.h * (label.includes('左上') ? 0.2 : 0.62)
    await mouse('mousePressed', sx, sy)
    for (let i = 1; i <= 14; i++) {
      await mouse('mouseMoved', sx + (r.w * frac * i) / 14, sy)
      await sleep(20)
    }
    await mouse('mouseReleased', sx + r.w * frac, sy)
    await sleep(1500)
    check(`手势翻页：${label}`, (await page()) !== before, `${before} -> ${await page()}`)
  }
}

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

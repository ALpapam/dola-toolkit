// Capture each flip animation mode mid-drag, plus single-page drag, so the
// effect can be verified visually.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve('.tmp/shots3')
mkdirSync(OUT, { recursive: true })
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
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('shot ->', name)
}
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 880, deviceScaleFactor: 1, mobile: false })
await sleep(1400)

await ev(`(() => { const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('书库')); r?.click() })()`)
await sleep(1300)
await ev(`(() => { document.querySelector('.book-card')?.click() })()`)
await sleep(2800)

async function dragMidProgress(pctOfWidth) {
  const g = JSON.parse(await ev(`(() => { const p=document.querySelector('.reader-spread.current').getBoundingClientRect(); const s=document.querySelector('.reader-stage').getBoundingClientRect(); return JSON.stringify({sx:s.x,sy:s.y,sw:s.width,sh:s.height,px:p.x,py:p.y,pw:p.width,ph:p.height}) })()`))
  const startX = g.px + g.pw - 14
  const startY = g.py + g.ph * 0.5
  const endX = startX - g.pw * pctOfWidth
  await mouse('mousePressed', startX, startY)
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', startX + ((endX - startX) * i) / 10, startY)
    await sleep(15)
  }
  return { startX, startY, endX }
}
async function release(x, y) {
  await mouse('mouseReleased', x, y)
  await sleep(800)
}

for (const mode of ['cover', 'slide', 'curl']) {
  await ev(`window.api.settings.patch({ reader: { flipAnimation: '${mode}' } })`)
  await sleep(700)
  const d = await dragMidProgress(0.55)
  await sleep(250)
  await shot(`flip-${mode}`)
  await release(d.endX, d.startY)
  await sleep(500)
}

// restore cover + a clean state
await ev(`window.api.settings.patch({ reader: { flipAnimation: 'cover' } })`)
await sleep(400)

// single-page mode: force narrow window
await send('Emulation.setDeviceMetricsOverride', { width: 780, height: 880, deviceScaleFactor: 1, mobile: false })
await sleep(1600)
const d2 = await dragMidProgress(0.55)
await sleep(250)
const singleInfo = await ev(`(() => {
  const pages = [...document.querySelectorAll('.reader-page')]
  return JSON.stringify({ count: pages.length, nums: [...document.querySelectorAll('.page-num')].map(e=>e.textContent) })
})()`)
console.log('single-page spread:', singleInfo)
await shot('flip-single')
await release(d2.endX, d2.startY)

// wide again
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 880, deviceScaleFactor: 1, mobile: false })
await sleep(900)
await ev(`window.api.settings.patch({ reader: { fontSize: 22 } })`)
await sleep(1400)
await shot('font-22px')
const big = await ev(`(() => { const p = document.querySelector('.page-inner'); const n=[...document.querySelectorAll('.pgnum')]; return JSON.stringify({ svgCount: p.querySelectorAll('svg').length, family: getComputedStyle(p).fontFamily, foot: document.querySelector('.pgnum')?.textContent }) })()`)
console.log('22px:', big)
await ev(`window.api.settings.patch({ reader: { fontSize: 17 } })`)
await sleep(600)

console.log('done')
ws.close()
process.exit(0)

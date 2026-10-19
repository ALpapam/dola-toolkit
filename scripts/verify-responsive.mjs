// Verify the responsive reader (single page when narrow, spread when wide)
// plus rail drag-reorder persistence.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve('.tmp/shots-narrow')
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

await send('Page.enable')
await send('Runtime.enable')

// --- wide: two pages ------------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false })
await sleep(1200)
await ev(`(() => { const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('书库')); r?.click(); return 'ok' })()`)
await sleep(1400)
await ev(`document.querySelector('.book-card')?.click()`)
await sleep(2600)
const wide = await ev(`(() => {
  const pages = [...document.querySelectorAll('.reader-page, .page-pane, .pdf-page')]
  return JSON.stringify({ count: pages.length, spread: document.querySelector('.reader-spread') ? 'spread' : 'none' })
})()`)
console.log('wide:', wide)
await shot('01-reader-wide')

// --- narrow: single page --------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 860, deviceScaleFactor: 1, mobile: false })
await sleep(1800)
const narrow = await ev(`(() => {
  const pages = [...document.querySelectorAll('.reader-page, .page-pane, .pdf-page')]
  return JSON.stringify({ count: pages.length, spread: document.querySelector('.reader-spread') ? 'spread' : 'none' })
})()`)
console.log('narrow:', narrow)
await shot('02-reader-narrow')

// --- rail drag reorder ----------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
await sleep(900)
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(800)
const orderBefore = await ev(`JSON.parse(localStorage.getItem('dola.railOrder') || '[]').join(',')`)
await ev(`(() => {
  const items = [...document.querySelectorAll('.rail-scroll .rail-item')]
  if (items.length < 2) return 'need 2+'
  const dt = new DataTransfer()
  const a = items[0], b = items[1]
  a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  const rb = b.getBoundingClientRect()
  b.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rb.top + rb.height - 2, clientX: rb.left + 10 }))
  b.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  return 'dragged'
})()`)
await sleep(700)
const orderAfter = await ev(`JSON.parse(localStorage.getItem('dola.railOrder') || '[]').join(',')`)
console.log('railOrder before:', orderBefore, '-> after:', orderAfter, orderBefore !== orderAfter ? 'REORDER OK' : 'NO CHANGE')
await shot('03-rail-reordered')

console.log('done')
ws.close()
process.exit(0)

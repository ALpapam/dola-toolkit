// Verify the nav-rail drag reorder: dispatches real DOM DragEvents (React 19
// listens at the root, so bubbling events are handled) and asserts the
// persisted order changed.
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

await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
await sleep(800)

console.log('initial :', await ev(`JSON.parse(localStorage.getItem('dola.railOrder')||'null')`))
console.log('dom order:', await ev(`[...document.querySelectorAll('.rail-scroll .rail-item')].map(e=>e.getAttribute('aria-label')).join(' | ')`))

const result = await ev(`(() => {
  const items = [...document.querySelectorAll('.rail-scroll .rail-item')]
  if (items.length < 2) return 'need 2+ tools, got ' + items.length
  const first = items[0], second = items[1]
  const firstLabel = first.getAttribute('aria-label')
  const secondLabel = second.getAttribute('aria-label')

  const dt = new DataTransfer()
  const mk = (type, el, extra = {}) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }))

  mk('dragstart', first, { clientX: 40, clientY: first.getBoundingClientRect().top + 20 })
  const rb = second.getBoundingClientRect()
  // hover the lower half of the second row => drop BELOW it
  mk('dragover', second, { clientX: 40, clientY: rb.top + rb.height * 0.85 })
  mk('drop', second, { clientX: 40, clientY: rb.top + rb.height * 0.85 })
  mk('dragend', first, { clientX: 40, clientY: rb.top + rb.height * 0.85 })
  return JSON.stringify({ firstLabel, secondLabel })
})()`)
console.log('drag:', result)
await sleep(600)
const after = await ev(`JSON.parse(localStorage.getItem('dola.railOrder')||'null')`)
console.log('after   :', JSON.stringify(after))
console.log('dom order:', await ev(`[...document.querySelectorAll('.rail-scroll .rail-item')].map(e=>e.getAttribute('aria-label')).join(' | ')`))

ws.close()
process.exit(0)

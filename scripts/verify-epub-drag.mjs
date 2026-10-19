// Verify:
//   1. EPUB drag-to-turn works by dragging the bottom corners of the page
//   2. the < / > buttons are rendered
//   3. clicking the page no longer turns it
//   4. the collapsed rail icons are square
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve('.tmp/shots4')
mkdirSync(OUT, { recursive: true })
const PORT = Number(process.env.CDP_PORT ?? 9331)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errors.push('EXC ' + (d.exception?.description ?? d.text))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
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
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(1600)

/* ---- 1. rail square ---- */
const rail = JSON.parse(await ev(`(() => {
  const rr = document.querySelector('.rail').getBoundingClientRect()
  const items = [...document.querySelectorAll('.rail-scroll .rail-item, .rail-footer .rail-item, .rail-expand-btn')]
  const boxes = items.map(el => { const b = el.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } })
  const logo = document.querySelector('.rail-brand-logo')?.getBoundingClientRect()
  return JSON.stringify({ railW: +rr.width.toFixed(1), boxes, logo: logo ? { w: +logo.width.toFixed(1), h: +logo.height.toFixed(1) } : null })
})()`))
console.log('rail:', JSON.stringify(rail))
const square = rail.boxes.every((b) => Math.abs(b.w - b.h) < 1.5)
console.log(`rail items square: ${square ? '✅' : '❌'} (${rail.boxes.map((b) => `${b.w}x${b.h}`).join(', ')})`)
await shot('01-rail-square')

/* ---- 2. open EPUB ---- */
await ev(`(async()=>{ try{ await window.api.library.importPaths(['${resolve('.tmp/fixtures/test-epub.epub').replace(/\\/g, '/')}']) }catch(e){} })()`)
await sleep(2000)
await ev(`(()=>{ const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('书库')); r?.click() })()`)
await sleep(1500)
const picked = await ev(`(()=>{ const cards=[...document.querySelectorAll('.book-card')]; const ep=cards.find(c=>(c.textContent||'').toUpperCase().includes('EPUB'))||cards[0]; ep?.click(); return ep?ep.textContent.slice(0,20):'none' })()`)
console.log('opened:', picked)
await sleep(5000)

console.log('flip buttons:', await ev(`JSON.stringify([...document.querySelectorAll('.flip-fab')].map(b=>({cls:b.className, text:b.textContent.trim(), rect:(({x,y})=>({x:Math.round(x),y:Math.round(y)}))(b.getBoundingClientRect())})))`))
console.log('epub iframe:', await ev(`!!document.querySelector('.epub-host iframe')`))
console.log('gesture bridge injected:', await ev(`(()=>{ const f=document.querySelector('.epub-host iframe'); if(!f) return 'no iframe'; try { return !!f.contentDocument.getElementById('dola-gesture-bridge') } catch(e){ return 'ERR '+e.message } })()`))
console.log('__dolaGestureBridge flag:', await ev(`(()=>{ const f=document.querySelector('.epub-host iframe'); if(!f) return 'no iframe'; try { return String(f.contentWindow.__dolaGestureBridge) } catch(e){ return 'ERR '+e.message } })()`))
await shot('02-epub-open')

/* ---- 3. click should NOT turn ---- */
const beforeClick = await ev(`document.querySelector('.pgnum')?.textContent`)
const paper = JSON.parse(await ev(`(()=>{ const host=document.querySelector('.epub-host').getBoundingClientRect(); return JSON.stringify({x:host.x,y:host.y,w:host.width,h:host.height}) })()`))
await mouse('mousePressed', paper.x + paper.w * 0.8, paper.y + paper.h * 0.5)
await mouse('mouseReleased', paper.x + paper.w * 0.8, paper.y + paper.h * 0.5)
await sleep(800)
const afterClick = await ev(`document.querySelector('.pgnum')?.textContent`)
console.log(`click (mid page) ${beforeClick} -> ${afterClick} ${beforeClick === afterClick ? '✅ no turn' : '❌ turned'}`)

/* ---- 4. drag bottom-right corner LEFT inside the iframe ---- */
async function dragInIframe(label, fx, fy, dx) {
  const before = await ev(`document.querySelector('.pgnum')?.textContent`)
  // dispatch inside the iframe document so the injected bridge receives it
  const ok = await ev(`(() => {
    const f = document.querySelector('.epub-host iframe')
    if (!f) return 'no iframe'
    const d = f.contentDocument
    const w = f.contentWindow
    const r = f.getBoundingClientRect()
    const x = r.width * ${fx}, y = r.height * ${fy}
    const mk = (type, cx, cy) => new w.PointerEvent(type, { clientX: cx, clientY: cy, button: 0, buttons: type==='pointerup'?0:1, bubbles: true, cancelable: true })
    d.dispatchEvent(mk('pointerdown', x, y))
    for (let i = 1; i <= 12; i++) d.dispatchEvent(mk('pointermove', x + ${dx} * i / 12, y))
    d.dispatchEvent(mk('pointerup', x + ${dx}, y))
    return 'dispatched'
  })()`)
  await sleep(900)
  const after = await ev(`document.querySelector('.pgnum')?.textContent`)
  console.log(`${label} (${ok}): ${before} -> ${after} ${before !== after ? '✅' : '❌'}`)
}
await dragInIframe('epub drag bottom-right LEFT', 0.85, 0.85, -400)
await dragInIframe('epub drag bottom-left RIGHT', 0.15, 0.85, 400)

/* ---- 5. prose drag still works (bottom corners) ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['${resolve('.tmp/fixtures/test-cn.txt').replace(/\\/g, '/')}']) }catch(e){} })()`)
await sleep(1800)
await ev(`(()=>{ const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('书库')); r?.click() })()`)
await sleep(1400)
await ev(`(()=>{ const cards=[...document.querySelectorAll('.book-card')]; const t=cards.find(c=>(c.textContent||'').toUpperCase().includes('TXT'))||cards[0]; t?.click() })()`)
await sleep(3000)
const g = JSON.parse(await ev(`(()=>{ const p=document.querySelector('.reader-spread.current').getBoundingClientRect(); return JSON.stringify({x:p.x,y:p.y,w:p.width,h:p.height}) })()`))
async function stageDrag(label, fx, fy, dx) {
  const before = await ev(`document.querySelector('.pgnum')?.textContent`)
  const sx = g.x + g.w * fx
  const sy = g.y + g.h * fy
  await mouse('mousePressed', sx, sy)
  for (let i = 1; i <= 12; i++) {
    await mouse('mouseMoved', sx + (dx * i) / 12, sy)
    await sleep(16)
  }
  await mouse('mouseReleased', sx + dx, sy)
  await sleep(850)
  const after = await ev(`document.querySelector('.pgnum')?.textContent`)
  console.log(`${label}: ${before} -> ${after} ${before !== after ? '✅' : '❌'}`)
}
await stageDrag('prose bottom-right LEFT', 0.85, 0.88, -g.w * 0.6)
await stageDrag('prose TOP-right LEFT (should NOT turn)', 0.85, 0.2, -g.w * 0.6)
await stageDrag('prose bottom-left RIGHT', 0.15, 0.88, g.w * 0.6)
await shot('03-prose-drag')

console.log('\nconsole errors:', JSON.stringify(errors.slice(0, 8)))
ws.close()
process.exit(0)

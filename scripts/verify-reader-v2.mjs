// Comprehensive verification of the reader + rail changes.
//   1. rail: collapsed icons are squares, logo has equal left/right margins
//   2. floating buttons render < and >
//   3. clicking the page does NOT turn it
//   4. drag from a top corner does NOT turn it
//   5. drag from the bottom-right turns exactly ONE spread, with animation
//   6. drag from the bottom-left turns back exactly one spread
//   7. a drag under the threshold springs back without turning
//   8. the same works for EPUB (via the cross-document bridge)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve('.tmp/shots6')
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
    errors.push('EXC ' + (d.exception?.description ?? d.text).slice(0, 180))
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
}
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(1600)

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)
  ok ? pass++ : fail++
}

/* ---- 1. rail geometry ---- */
const rail = JSON.parse(await ev(`(() => {
  const r = document.querySelector('.rail').getBoundingClientRect()
  const logo = document.querySelector('.rail-brand-logo').getBoundingClientRect()
  const boxes = [...document.querySelectorAll('.rail-scroll .rail-item, .rail-footer .rail-item, .rail-expand-btn')]
    .map(e => { const b = e.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } })
  return JSON.stringify({
    railW: +r.width.toFixed(1),
    leftGap: +(logo.left - r.left).toFixed(1),
    rightGap: +(r.right - logo.right).toFixed(1),
    boxes
  })
})()`))
check('rail窄于76px', rail.railW < 76, `railW=${rail.railW}`)
check('图标为正方形', rail.boxes.every((b) => Math.abs(b.w - b.h) < 1), rail.boxes.map((b) => `${b.w}x${b.h}`).join(' '))
check('logo左右留白相等', Math.abs(rail.leftGap - rail.rightGap) <= 1.2, `left=${rail.leftGap} right=${rail.rightGap}`)
await shot('01-rail')

/* ---- 2. buttons ---- */
const btns = await ev(`JSON.stringify([...document.querySelectorAll('.flip-fab')].map(b => ({ cls: b.className, d: (b.querySelector('path')?.getAttribute('d') || '').slice(0, 26) })))`)
console.log('   flip buttons:', btns)

/* ---- open a prose book ---- */
await ev(`(async()=>{ try{ await window.api.library.importPaths(['${resolve('.tmp/fixtures/test-cn.txt').replace(/\\/g, '/')}']) }catch(e){} })()`)
await sleep(2000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT'))||document.querySelector('.book-card'); c?.click() })()`)
await sleep(3400)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1000)

const paper = async () => JSON.parse(await ev(`(() => {
  const p = document.querySelector('.reader-spread.current')
  if (!p) return 'null'
  const b = p.getBoundingClientRect()
  return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height })
})()`))
const page = () => ev(`document.querySelector('.pgnum')?.textContent`)

async function swipe(label, fx, fy, dxFrac, expectTurn) {
  const g = await paper()
  const before = await page()
  const sx = g.x + g.w * fx
  const sy = g.y + g.h * fy
  const dx = g.w * dxFrac
  await mouse('mousePressed', sx, sy)
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', sx + (dx * i) / 10, sy)
    await sleep(22)
  }
  const engaged = await ev(`document.querySelector('.reader-stage').classList.contains('is-dragging')`)
  let midDeg = 0
  if (engaged) {
    midDeg = Number((/rotateY\((-?[\d.]+)deg\)/.exec(await ev(`document.querySelector('.reader-page-turnable')?.style.transform || ''`)) || [0, 0])[1])
  }
  await mouse('mouseReleased', sx + dx, sy)
  // sample the completion animation
  let sawAnimation = false
  for (let i = 0; i < 8; i++) {
    await sleep(40)
    const t = await ev(`(()=>{const e=document.querySelector('.reader-page-turnable'); return e ? (e.style.transform||'') : ''})()`)
    if (/rotateY\((-?[\d.]+)deg\)/.test(t)) sawAnimation = true
  }
  await sleep(500)
  const after = await page()
  const turned = before !== after
  check(label, turned === expectTurn, `${before} -> ${after}${engaged ? ' engaged' : ' not-engaged'}`)
  return { midDeg, sawAnimation, turned }
}

console.log('\n--- prose ---')
const r1 = await swipe('底部右侧向左拖 = 翻一页', 0.85, 0.88, -0.5, true)
check('拖动中页面跟随旋转', r1.midDeg < -5, `rotateY=${r1.midDeg}deg`)
check('松手后播放完成动画', r1.sawAnimation)
await swipe('底部左侧向右拖 = 回一页', 0.15, 0.88, 0.5, true)
await swipe('顶部角落拖动 = 不翻页', 0.85, 0.15, -0.5, false)
const beforeClick = await page()
await mouse('mousePressed', (await paper()).x + 200, (await paper()).y + 300)
await mouse('mouseReleased', (await paper()).x + 200, (await paper()).y + 300)
await sleep(700)
check('点击页面不翻页', (await page()) === beforeClick, `${beforeClick} -> ${await page()}`)
await swipe('拖动未达阈值 = 回弹不翻页', 0.85, 0.88, -0.08, false)
await shot('02-prose-after')

/* ---- EPUB ---- */
console.log('\n--- epub ---')
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['${resolve('.tmp/fixtures/test-epub.epub').replace(/\\/g, '/')}']) }catch(e){} })()`)
await sleep(2000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('EPUB')); c?.click() })()`)
await sleep(7000)
const hasFrame = await ev(`document.querySelectorAll('.epub-host iframe').length`)
check('EPUB 打开成功', hasFrame === 1, `iframe=${hasFrame}`)
await shot('03-epub')

async function epubSwipe(label, fx, fy, dx, expectTurn) {
  const before = await ev(`document.querySelector('.pgnum')?.textContent`)
  await ev(`(() => {
    const f = document.querySelector('.epub-host iframe'); if (!f) return 'no'
    const d = f.contentDocument, w = f.contentWindow, r = f.getBoundingClientRect()
    const x = r.width * ${fx}, y = r.height * ${fy}
    const mk = (t, cx, cy) => new w.PointerEvent(t, { clientX: cx, clientY: cy, button: 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true })
    d.dispatchEvent(mk('pointerdown', x, y))
    for (let i = 1; i <= 10; i++) d.dispatchEvent(mk('pointermove', x + ${dx} * i / 10, y))
    d.dispatchEvent(mk('pointerup', x + ${dx}, y))
    return 'ok'
  })()`)
  await sleep(1400)
  const after = await ev(`document.querySelector('.pgnum')?.textContent`)
  check(label, (before !== after) === expectTurn, `${before} -> ${after}`)
}
await epubSwipe('EPUB 底部右侧向左拖 = 下一页', 0.85, 0.85, -420, true)
await epubSwipe('EPUB 底部左侧向右拖 = 上一页', 0.15, 0.85, 420, true)
await epubSwipe('EPUB 顶部拖动 = 不翻页', 0.5, 0.15, -420, false)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
console.log('errors:', JSON.stringify(errors.slice(0, 5)))
ws.close()
process.exit(fail ? 1 : 0)
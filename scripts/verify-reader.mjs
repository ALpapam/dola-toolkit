// Verify the two new features over CDP:
//   1. the bundled font actually loads (document.fonts) and is applied to pages
//   2. a real pointer drag on the page edge turns the page
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve('.tmp/shots2')
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
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 880, deviceScaleFactor: 1, mobile: false })
await sleep(1600)

/* ---------------- 1. fonts ---------------- */
console.log('\n=== fonts ===')
const fontInfo = await ev(`(async () => {
  const list = await window.api.fonts.list()
  await document.fonts.ready
  const loaded = []
  for (const f of list.fonts) {
    try {
      const family = f.name.replace(/'/g, "")
      const faces = [...document.fonts].filter(x => x.family.replace(/['"]/g, '') === family)
      loaded.push({ id: f.id, name: f.name, builtin: f.builtin, url: !!f.url, faces: faces.length, status: faces.map(x=>x.status).join(',') })
    } catch (e) { loaded.push({ id: f.id, error: String(e) }) }
  }
  // can the browser actually measure a glyph with the bundled face?
  let measurable = null
  try {
    await document.fonts.load('17px "JetBrains Maple Mono NF"', '永A')
    measurable = document.fonts.check('17px "JetBrains Maple Mono NF"')
  } catch (e) { measurable = 'ERR ' + e.message }
  return JSON.stringify({ defaultId: list.defaultId, fonts: loaded, measurable, familyVar: getComputedStyle(document.documentElement).getPropertyValue('--reading-font') }, null, 1)
})()`)
console.log(fontInfo)

// seed fixtures and open the library
await ev(`(async () => {
  try {
    await window.api.library.importPaths([
      '${resolve('.tmp/fixtures/test-epub.epub').replace(/\\/g, '/')}',
      '${resolve('.tmp/fixtures/test-cn.txt').replace(/\\/g, '/')}',
      '${resolve('.tmp/fixtures/test-fb2.fb2').replace(/\\/g, '/')}'
    ])
    return 'seeded'
  } catch (e) { return 'seed: ' + e.message }
})()`)
await sleep(2200)

await ev(`(() => { const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('书库')); r?.click(); return 'ok' })()`)
await sleep(1600)

/* ---------------- 2. reader + drag flip ---------------- */
// open the txt book (prose renderer, the one that supports drag)
const opened = await ev(`(() => {
  const cards = [...document.querySelectorAll('.book-card')]
  const txt = cards.find(c => (c.textContent||'').includes('测试') || (c.textContent||'').includes('TXT'))
  const target = txt || cards[0]
  if (!target) return 'no cards'
  target.click()
  return 'opened ' + (target.textContent||'').slice(0, 24)
})()`)
console.log('\nopen:', opened)
await sleep(3000)

const pageState0 = await ev(`(() => {
  const num = document.querySelector('.reader-page .page-num')?.textContent
  const inner = document.querySelector('.reader-page .page-inner')
  return JSON.stringify({
    pageNum: num,
    fontFamily: inner ? getComputedStyle(inner).fontFamily : null,
    spreadW: document.querySelector('.reader-spread.current')?.getBoundingClientRect().width,
    hasUnder: !!document.querySelector('.reader-spread.under')
  })
})()`)
console.log('page state:', pageState0)
await shot('01-reader-font')

// measure the stage so the drag is placed inside it
const geo = JSON.parse(await ev(`(() => {
  const s = document.querySelector('.reader-stage').getBoundingClientRect()
  const p = document.querySelector('.reader-spread.current')?.getBoundingClientRect()
  return JSON.stringify({ sx: s.x, sy: s.y, sw: s.width, sh: s.height, px: p?.x, py: p?.y, pw: p?.width, ph: p?.height })
})()`))
console.log('geo:', geo)

// Drag from the RIGHT edge of the page leftwards (next page)
const startX = geo.px + geo.pw - 20
const startY = geo.py + geo.ph / 2
const endX = startX - geo.pw * 0.65

await mouse('mousePressed', startX, startY)
for (let i = 1; i <= 12; i++) {
  await mouse('mouseMoved', startX + (endX - startX) * (i / 12), startY)
  await sleep(18)
  if (i === 6) {
    const mid = await ev(`(() => {
      const cur = document.querySelector('.reader-spread.current')
      return JSON.stringify({ dragging: document.querySelector('.reader-stage').classList.contains('is-dragging'), transform: cur ? getComputedStyle(cur).transform.slice(0, 60) : null })
    })()`)
    console.log('mid-drag:', mid)
    await shot('02-dragging')
  }
}
await mouse('mouseReleased', endX, startY)
await sleep(900)

const afterNext = await ev(`(() => {
  const nums = [...document.querySelectorAll('.reader-page .page-num')].map(e=>e.textContent)
  return JSON.stringify({ pageNums: nums, foot: document.querySelector('.pgnum')?.textContent })
})()`)
console.log('after drag-next:', afterNext)
await shot('03-after-next')

// Drag from the LEFT edge of the page rightwards (previous page)
const geo2 = JSON.parse(await ev(`(() => {
  const p = document.querySelector('.reader-spread.current')?.getBoundingClientRect()
  return JSON.stringify({ px: p.x, py: p.y, pw: p.width, ph: p.height })
})()`))
const sx2 = geo2.px + 20
const sy2 = geo2.py + geo2.ph / 2
const ex2 = sx2 + geo2.pw * 0.65
await mouse('mousePressed', sx2, sy2)
for (let i = 1; i <= 10; i++) {
  await mouse('mouseMoved', sx2 + (ex2 - sx2) * (i / 10), sy2)
  await sleep(18)
}
await mouse('mouseReleased', ex2, sy2)
await sleep(900)
const afterPrev = await ev(`JSON.stringify({ pageNums: [...document.querySelectorAll('.reader-page .page-num')].map(e=>e.textContent), foot: document.querySelector('.pgnum')?.textContent })`)
console.log('after drag-prev:', afterPrev)

// small drag that should spring back (below threshold)
const geo3 = JSON.parse(await ev(`(() => { const p=document.querySelector('.reader-spread.current').getBoundingClientRect(); return JSON.stringify({px:p.x,py:p.y,pw:p.width,ph:p.height}) })()`))
await mouse('mousePressed', geo3.px + geo3.pw - 20, geo3.py + geo3.ph / 2)
await mouse('mouseMoved', geo3.px + geo3.pw - 20 - 12, geo3.py + geo3.ph / 2)
await sleep(120)
await shot('04-below-threshold')
await mouse('mouseReleased', geo3.px + geo3.pw - 20 - 12, geo3.py + geo3.ph / 2)
await sleep(700)
const afterSmall = await ev(`JSON.stringify({ pageNums: [...document.querySelectorAll('.reader-page .page-num')].map(e=>e.textContent) })`)
console.log('after small drag (should be unchanged):', afterSmall)

// typography settings page
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(700)
await ev(`(() => { const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||b.getAttribute('aria-label')||'').includes('设置')); r?.click(); return 'ok' })()`)
await sleep(900)
await ev(`(() => { const n=[...document.querySelectorAll('.snav')].find(b=>(b.textContent||'').includes('字体')); n?.click(); return 'ok' })()`)
await sleep(1400)
await shot('05-settings-typography')
const typo = await ev(`(() => ({
  rows: [...document.querySelectorAll('.font-row')].map(r => (r.querySelector('.font-name')?.textContent||'').trim()),
  active: document.querySelector('.font-row.active .font-name')?.textContent,
  previewFont: document.querySelector('.font-preview') ? getComputedStyle(document.querySelector('.font-preview')).fontFamily : null
}))()`)
console.log('typography UI:', JSON.stringify(typo))

console.log('\nconsole errors:', JSON.stringify(errors.slice(0, 10)))
ws.close()
process.exit(0)

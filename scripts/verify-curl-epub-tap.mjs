// EPUB taps must reach the reader through the chapter bridge, and the settings
// page must no longer offer the removed drag options.
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

/* ---- settings UI ---- */
await ev(`document.querySelector('.rail-item[aria-label="设置"]')?.click()`)
await sleep(1600)
await ev(`(()=>{const n=[...document.querySelectorAll('.snav')].find(b=>(b.textContent||'').includes('书库')); n?.click()})()`)
await sleep(1200)
const titles = JSON.parse(
  await ev(`(()=>{const t=[...document.querySelectorAll('.set-item-title')].map(e=>e.textContent.trim());
    return JSON.stringify([...new Set(t)])})()`)
)
check('设置里不再有「拖动翻页」', !titles.includes('拖动翻页'), `共 ${titles.length} 项`)
check('设置里不再有「翻页触发距离」', !titles.includes('翻页触发距离'))
check('设置里有「翻页方式」说明', titles.includes('翻页方式'), titles.filter((t) => t.includes('翻页')).join(' / '))

/* ---- EPUB tap zones ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{
  const st=await window.api.library.state()
  const old=st.books.filter(b=>(b.title||'').includes('星海')).map(b=>b.id)
  if(old.length) await window.api.library.removeBooks(old)
  await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-epub.epub'])
})()`)
await sleep(2000)
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'}}) })()`)
await sleep(900)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('EPUB')); c?.click() })()`)
await sleep(9000)
check('EPUB 打开', await ev(`!!document.querySelector('.epub-host iframe')`))

const page = () => ev(`document.querySelector('.pgnum')?.textContent`)
const bookRect = async () =>
  JSON.parse(await ev(`(()=>{const e=document.querySelector('.epub-host'); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`))
async function tapBook(frac) {
  const r = await bookRect()
  const x = r.x + r.w * frac
  const y = r.y + r.h * 0.5
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1400)
}

{
  const b = await page()
  await tapBook(0.85)
  check('EPUB 点右侧 1/3 = 下一页', (await page()) !== b, `${b} -> ${await page()}`)
}
{
  const b = await page()
  await tapBook(0.15)
  check('EPUB 点左侧 1/3 = 上一页', (await page()) !== b, `${b} -> ${await page()}`)
}

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

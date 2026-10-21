// Functional suite for the curl reader.
//
// Page turns are triggered by tapping the left/right third of the sheet (drag
// turning was removed on request), the < > buttons, the arrow keys and the wheel.
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

const page = () => ev(`document.querySelector('.pgnum')?.textContent`)
const spread = () =>
  ev(`(()=>{const s=document.querySelector('.reader-spread.current'); const r=s.getBoundingClientRect();
    return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`)
const painted = () =>
  ev(`(()=>{const c=document.querySelector('.curl-canvas'); if(!c) return -1;
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
    for(let i=3;i<d.length;i+=4*7){ if(d[i]>8){ n++; if(n>40000) return 40000 } } return n})()`)

/** tap at a horizontal fraction of the sheet */
async function tap(frac) {
  const r = JSON.parse(await spread())
  const x = r.x + r.w * frac
  const y = r.y + r.h * 0.5
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
  await sleep(1250)
}

/* ---- setup ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(1000)
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

check('卷曲画布已挂载', (await painted()) >= 0)

/* ---- taps ---- */
{
  const b = await page()
  await tap(0.85)
  const a = await page()
  check('点右侧 1/3 前进一个跨页', a !== b && a.startsWith('3'), `${b} -> ${a}`)
}
{
  const b = await page()
  await tap(0.15)
  const a = await page()
  check('点左侧 1/3 后退一个跨页', a !== b && a.startsWith('1'), `${b} -> ${a}`)
}
{
  const b = await page()
  await tap(0.5)
  check('点中间 1/3 不翻页', (await page()) === b, b)
}

/* ---- rapid taps must not race through the book ---- */
{
  const seen = []
  for (let k = 0; k < 5; k++) {
    await tap(0.85)
    seen.push(await page())
  }
  const last = Number((/^(\d+)/.exec(seen.slice(-1)[0]) || [0, 0])[1])
  check('连续快点不会失控翻页', last <= 13, `最终 ${seen.slice(-1)[0]}`)
}

/* ---- wheel ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1800)
  const r = JSON.parse(await spread())
  const start = await page()
  for (let i = 0; i < 10; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x + r.w / 2, y: r.y + r.h / 2, deltaX: 0, deltaY: 120 })
    await sleep(45)
  }
  await sleep(2000)
  const end = await page()
  check('滚轮惯性只翻一页', end !== start && end.startsWith('3'), `${start} -> ${end}`)
}

/* ---- button turn animates then advances ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1700)
  const b = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  const frames = []
  for (let i = 0; i < 10; i++) {
    await sleep(45)
    frames.push(await painted())
  }
  await sleep(1400)
  const a = await page()
  check('按钮翻页会播放动画', frames.some((n) => n > 0), `采样 ${JSON.stringify(frames.slice(0, 4))}`)
  check('按钮翻页最终前进一页', a !== b && a.startsWith('3'), `${b} -> ${a}`)
}

/* ---- GPU off ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1700)
  await ev(`(async()=>{ await window.api.settings.patch({reader:{gpuAcceleration:false}}) })()`)
  await sleep(1200)
  const b = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  const frames = []
  for (let i = 0; i < 10; i++) {
    await sleep(45)
    frames.push(await painted())
  }
  await sleep(1400)
  const a = await page()
  check('关闭 GPU 后仍能动画翻页', frames.some((n) => n > 0) && a !== b, `${b} -> ${a}`)
  await ev(`(async()=>{ await window.api.settings.patch({reader:{gpuAcceleration:true}}) })()`)
}

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

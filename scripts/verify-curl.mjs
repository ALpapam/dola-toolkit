// Verifies the Canvas 2D curl page-turn engine (pageCurl.ts / useCurlTurn.ts).
//
// The old checks looked for a CSS `rotateY` on `.reader-page-turnable`; that
// element no longer exists — the turn is now painted frame-by-frame onto
// `.curl-canvas`. So instead of sampling a transform we sample the canvas
// itself: how many pixels the current frame covers, and whether that changes
// between frames (which proves the sheet is genuinely being redrawn).
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
/** count of painted pixels in the curl canvas (capped for speed) */
const painted = () =>
  ev(`(()=>{const c=document.querySelector('.curl-canvas'); if(!c) return -1;
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
    for(let k=3;k<d.length;k+=4){ if(d[k]>0){ n++; if(n>40000) return 40000 } } return n})()`)
const spreadRect = () =>
  ev(`(()=>{const s=document.querySelector('.reader-spread.current'); if(!s) return null;
    const r=s.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`)

/* ---- setup: prose book, spread mode ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(1000)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-cn.txt']) }catch(e){} })()`)
await sleep(2400)
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'},reader:{flipAnimation:'cover',dragFlip:true,gpuAcceleration:true}}) })()`)
await sleep(1000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2200)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT')); c?.click() })()`)
await sleep(3800)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1100)

check('卷曲画布已挂载', (await painted()) >= 0)

/* ---- one drag turns exactly one spread and paints frames ---- */
async function drag(fx, fy, frac) {
  const r = JSON.parse(await spreadRect())
  const sx = r.x + r.w * fx
  const sy = r.y + r.h * fy
  const dx = r.w * frac
  await mouse('mousePressed', sx, sy)
  const frames = []
  for (let i = 1; i <= 14; i++) {
    await mouse('mouseMoved', sx + (dx * i) / 14, sy)
    await sleep(22)
    if (i % 4 === 0) frames.push(await painted())
  }
  await mouse('mouseReleased', sx + dx, sy)
  await sleep(1500)
  return frames
}

const b1 = await page()
const frames = await drag(0.85, 0.82, -0.45)
const a1 = await page()
check('一次拖动只前进一个跨页', a1 !== b1 && a1.startsWith('3'), `${b1} -> ${a1}`)
check('拖动过程中画布在逐帧重绘', frames.some((n) => n > 0), `采样 ${JSON.stringify(frames)}`)

const b2 = await page()
await drag(0.15, 0.82, 0.45)
const a2 = await page()
check('一次拖动只后退一个跨页', a2 !== b2 && a2.startsWith('1'), `${b2} -> ${a2}`)

/* ---- swipe must work anywhere on the sheet (not just a bottom band) ---- */
const b3 = await page()
await drag(0.85, 0.15, -0.45)
check('页面顶部横滑也能翻页', (await page()) !== b3, `${b3} -> ${await page()}`)

/* ---- rapid repeated drags must not race through the book ---- */
{
  const seen = []
  for (let k = 0; k < 5; k++) {
    const r = JSON.parse(await spreadRect())
    const sx = r.x + r.w * 0.85
    const sy = r.y + r.h * 0.82
    await mouse('mousePressed', sx, sy)
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', sx - (r.w * 0.45 * i) / 6, sy)
      await sleep(10)
    }
    await mouse('mouseReleased', sx - r.w * 0.45, sy)
    await sleep(140)
    seen.push(await page())
  }
  const last = Number((/^(\d+)/.exec(seen.slice(-1)[0]) || [0, 0])[1])
  check('连续快拖不会失控翻页', last <= 13, `最终 ${seen.slice(-1)[0]}`)
}

/* ---- inertial wheel must not rattle through spreads ---- */
{
  // clean slate: back to the cover and let every in-flight turn land, otherwise
  // a turn queued by the previous section lands mid-burst and looks like a
  // second wheel advance
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(2000)
  const r = JSON.parse(await spreadRect())
  const startPage = await page()
  // No per-event sampling here: each `page()` is a CDP round-trip and would
  // stretch a ~450ms inertia burst past the lock, letting a second turn in.
  for (let i = 0; i < 10; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: r.x + r.w / 2,
      y: r.y + r.h / 2,
      deltaX: 0,
      deltaY: 120
    })
    await sleep(45)
  }
  await sleep(2000)
  const endPage = await page()
  check('滚轮惯性只翻一页', endPage !== startPage && endPage.startsWith('3'), `${startPage} -> ${endPage}`)
}

/* ---- click turn animates then advances ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`) // back to cover
  await sleep(1600)
  const b4 = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  const clickFrames = []
  for (let i = 0; i < 10; i++) {
    await sleep(45)
    clickFrames.push(await painted())
  }
  await sleep(1400)
  const a4 = await page()
  check('按钮翻页会播放动画', clickFrames.some((n) => n > 0), `采样 ${JSON.stringify(clickFrames)}`)
  check('按钮翻页最终前进一页', a4 !== b4 && a4.startsWith('3'), `${b4} -> ${a4}`)
}

/* ---- GPU off: same behaviour, cheaper profile ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1600)
  await ev(`(async()=>{ await window.api.settings.patch({reader:{gpuAcceleration:false}}) })()`)
  await sleep(1200)
  const b5 = await page()
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  const offFrames = []
  for (let i = 0; i < 10; i++) {
    await sleep(45)
    offFrames.push(await painted())
  }
  await sleep(1400)
  const a5 = await page()
  check('关闭 GPU 后仍能动画翻页', offFrames.some((n) => n > 0) && a5 !== b5, `${b5} -> ${a5}`)
  await ev(`(async()=>{ await window.api.settings.patch({reader:{gpuAcceleration:true}}) })()`)
}

/* ---- EPUB: the sheet must never move the book itself ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(1100)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-epub.epub']) }catch(e){} })()`)
await sleep(2000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('EPUB')); c?.click() })()`)
await sleep(9000)
check('EPUB 打开成功', await ev(`!!document.querySelector('.epub-host iframe')`))
const offsets = []
const beforeEpub = await ev(`document.querySelector('.pgnum')?.textContent`)
await ev(`(()=>{ window.__off=[]; const st=document.querySelector('.reader-stage');
  const t0=performance.now();
  const tick=()=>{ if(performance.now()-t0>1500) return;
    const h=document.querySelector('.epub-host'); if(h) window.__off.push(Math.round(h.getBoundingClientRect().x - st.getBoundingClientRect().x));
    requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(1700)
offsets.push(...JSON.parse(await ev(`JSON.stringify(window.__off)`)))
check('EPUB 翻页时书本本体不移动', new Set(offsets).size === 1, `偏移集合 ${JSON.stringify([...new Set(offsets)])}`)
check('EPUB 翻页生效', (await ev(`document.querySelector('.pgnum')?.textContent`)) !== beforeEpub, `${beforeEpub} -> ${await ev(`document.querySelector('.pgnum')?.textContent`)}`)
check('EPUB 也不会画到舞台外', await ev(`(()=>{const st=document.querySelector('.reader-stage').getBoundingClientRect(); const c=document.querySelector('.curl-canvas').getBoundingClientRect(); return Math.abs(c.x-st.x)<1 && Math.abs(c.width-st.width)<1})()`))

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

// Two layout rules that were wrong:
//   1. the turning sheet must never paint over the < > buttons (z-order)
//   2. in single-page mode the sheet must stay inside the page — it used to
//      sweep out into the stage margin, which read as "the turn starts in the
//      middle of the window"
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

await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-cn.txt']) }catch(e){} })()`)
await sleep(2400)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2200)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT')); c?.click() })()`)
await sleep(3800)

/* ---- 1. buttons above the curl overlay ---- */
{
  const z = JSON.parse(
    await ev(`(()=>{const b=document.querySelector('.flip-fab'); const c=document.querySelector('.curl-canvas');
      return JSON.stringify({btn: b?Number(getComputedStyle(b).zIndex):null, canvas: c?Number(getComputedStyle(c).zIndex):null})})()`)
  )
  check('翻页按钮在翻页特效之上', z.btn !== null && z.canvas !== null && z.btn > z.canvas, `按钮 z=${z.btn}，画布 z=${z.canvas}`)
}

/* ---- 2. single page: the sheet stays inside the page ---- */
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'never'}}) })()`)
await sleep(1700)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1300)
const geo = JSON.parse(
  await ev(`(()=>{const st=document.querySelector('.reader-stage').getBoundingClientRect();
    const pg=document.querySelector('.reader-page').getBoundingClientRect();
    return JSON.stringify({page:{x:Math.round(pg.x-st.x), w:Math.round(pg.width)}})})()`)
)
const bounds = JSON.parse(
  await ev(`(async()=>{
    document.querySelector('.flip-fab.next')?.click()
    const c=document.querySelector('.curl-canvas')
    for(let k=0;k<60;k++){
      await new Promise(r=>requestAnimationFrame(r))
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data
      let n=0; for(let i=3;i<d.length;i+=4*17) if(d[i]>8) n++
      if(n>50) break
    }
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data
    const W=c.width,H=c.height
    let minX=W,maxX=-1
    for(let y=0;y<H;y+=8){ for(let x=0;x<W;x+=2){ if(d[(y*W+x)*4+3]>10){ if(x<minX)minX=x; if(x>maxX)maxX=x } } }
    const k=W/c.getBoundingClientRect().width
    return JSON.stringify({minX:Math.round(minX/k), maxX:Math.round(maxX/k)})
  })()`)
)
check(
  '单页模式翻页不越出页面',
  bounds.minX >= geo.page.x - 2 && bounds.maxX <= geo.page.x + geo.page.w + 2,
  `纸张 ${bounds.minX}..${bounds.maxX}，页面 ${geo.page.x}..${geo.page.x + geo.page.w}`
)

/* ---- 3. both directions advance in single-page mode ---- */
await sleep(1200)
const b1 = await ev(`document.querySelector('.pgnum')?.textContent`)
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(1300)
const a1 = await ev(`document.querySelector('.pgnum')?.textContent`)
await ev(`document.querySelector('.flip-fab.prev')?.click()`)
await sleep(1300)
const a2 = await ev(`document.querySelector('.pgnum')?.textContent`)
check('单页模式下一页/上一页都生效', a1 !== b1 && a2 === b1, `${b1} → ${a1} → ${a2}`)

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

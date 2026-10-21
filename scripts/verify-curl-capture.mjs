// Verifies the two symptoms the console revealed, updated for the new design:
//   1. the "blank snapshot" guard must NOT fire on ordinary pages
//   2. while the leaf sweeps, the area it has passed over must show the NEW page
//      on screen (the leaf's reverse side is now the live page, not a captured
//      image, so a screenshot is compared rather than the canvas contents)
const PORT = Number(process.env.CDP_PORT ?? 9331)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (text.includes('[curl]')) logs.push(text)
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
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'},reader:{gpuAcceleration:true}}) })()`)
await sleep(1000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2200)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT')); c?.click() })()`)
await sleep(3800)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1300)

/* ---- 1. ordinary turns must not fall back ---- */
logs.length = 0
for (let i = 0; i < 6; i++) {
  await ev(`document.querySelector('.flip-fab.${i === 3 ? 'prev' : 'next'}')?.click()`)
  await sleep(900)
}
const fallbacks = logs.filter((l) => l.includes('fallback') || l.includes('snapshot'))
check('普通页面翻页不再误判空白', fallbacks.length === 0, `警告 ${fallbacks.length} 条`)

/* ---- 2. no early content jump + the swept area shows the new page ---- */
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1500)
const geo = JSON.parse(
  await ev(`(()=>{const s=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:s.x,y:s.y,w:s.width,h:s.height})})()`)
)
// capture the new far page (LEFT half) as the reference, right after the turn starts
const started = Date.now()
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(300) // ~2/3 through the turn: the leaf has swept well past the gutter
const midShot = await send('Page.captureScreenshot', { format: 'png' })
await sleep(1000)
const refShot = await send('Page.captureScreenshot', { format: 'png' })

const cmp = JSON.parse(
  await ev(`(async()=>{
    const load=async(b64)=>{ const im=new Image(); im.src='data:image/png;base64,'+b64; await new Promise(k=>{im.onload=k;im.onerror=k}); return im }
    const mid=await load(${JSON.stringify(midShot.data)})
    const ref=await load(${JSON.stringify(refShot.data)})
    const dpr=mid.naturalWidth/window.innerWidth
    const sp={x:${Math.round(geo.x)},y:${Math.round(geo.y)},w:${Math.round(geo.w)},h:${Math.round(geo.h)}}
    // far half = LEFT half; sample close to the gutter, which the leaf covers early
    const px=Math.round((sp.x+sp.w*0.5-sp.w*0.5*0.18)*dpr)
    const py=Math.round((sp.y+sp.h*0.42)*dpr)
    const sz=Math.round(48*dpr)
    const grab=(im)=>{ const c=document.createElement('canvas'); c.width=im.naturalWidth; c.height=im.naturalHeight
      const g=c.getContext('2d'); g.drawImage(im,0,0); return g.getImageData(px,py,sz,sz).data }
    const a=grab(mid), b=grab(ref)
    let s=0,n=0
    for(let i=0;i<a.length;i+=4){ s+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]); n++ }
    return JSON.stringify({diff: Math.round(s/(n*3))})
  })()`)
)
check('翻动中已扫过的区域显示的是新页面', cmp.diff < 24, `与翻完后的画面差异 ${cmp.diff}`)
check('翻页耗时正常（无长时间空白等待）', Date.now() - started < 2500)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

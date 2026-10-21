// Verifies the two symptoms the console revealed:
//   1. the "blank snapshot" guard must NOT fire on ordinary pages (it was
//      misfiring because contrast was measured on a 64x64 downscale)
//   2. the reverse side of the leaf must be the real far page, not the plain
//      paper colour — i.e. no light-purple blank during the turn
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

const page = () => ev(`document.querySelector('.pgnum')?.textContent`)
logs.length = 0

/* ---- 1. ordinary turns must not fall back ---- */
for (let i = 0; i < 6; i++) {
  if (i === 3) {
    // half way, go back so we exercise both directions
    await ev(`document.querySelector('.flip-fab.prev')?.click()`)
  } else {
    await ev(`document.querySelector('.flip-fab.next')?.click()`)
  }
  await sleep(900)
}
const fallbacks = logs.filter((l) => l.includes('fallback') || l.includes('empty snapshot') || l.includes('blank snapshot'))
check('普通页面翻页不再误判空白', fallbacks.length === 0, `警告 ${fallbacks.length} 条`)

/* ---- 2. the reverse side shows the far page, not the paper colour ---- */
logs.length = 0
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1500)
const probe = JSON.parse(
  await ev(`(async()=>{
    const sp=document.querySelector('.reader-spread.current').getBoundingClientRect()
    const far={x:sp.x,y:sp.y,w:sp.width/2,h:sp.height}
    const grabCss=async(r)=>{
      const url=await window.api.app.capture({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.w),height:Math.round(r.h)})
      const im=new Image(); im.src=url; await new Promise(k=>{im.onload=k;im.onerror=k})
      const cv=document.createElement('canvas'); cv.width=Math.round(r.w); cv.height=Math.round(r.h)
      cv.getContext('2d').drawImage(im,0,0,cv.width,cv.height)
      return cv.getContext('2d').getImageData(0,0,cv.width,cv.height)
    }
    document.querySelector('.flip-fab.next').click()
    await new Promise(r=>setTimeout(r, 340))
    const cv=document.querySelector('.curl-canvas')
    const rect=cv.getBoundingClientRect()
    const tmp=document.createElement('canvas'); tmp.width=Math.round(rect.width); tmp.height=Math.round(rect.height)
    tmp.getContext('2d').drawImage(cv,0,0,tmp.width,tmp.height)
    const newFar=await grabCss(far)
    const px=Math.round(far.w*0.2), py=Math.round(far.h*0.4), sz=44
    const cx0=Math.round(far.x-rect.x)+px, cy0=Math.round(far.y-rect.y)+py
    const cand=tmp.getContext('2d').getImageData(cx0,cy0,sz,sz).data
    const ref=newFar.data, gw=newFar.width
    let s=0,n=0
    for(let y=0;y<sz;y++){ for(let x=0;x<sz;x++){
      const ci=((y*sz)+x)*4, ri=((py+y)*gw+(px+x))*4
      if(cand[ci+3]<10) continue
      s+=Math.abs(cand[ci]-ref[ri])+Math.abs(cand[ci+1]-ref[ri+1])+Math.abs(cand[ci+2]-ref[ri+2]); n++
    }}
    return JSON.stringify({diff: n?Math.round(s/(n*3)):-1, n})
  })()`)
)
await sleep(1200)
check('背面 = 新页面同位置内容（无淡紫空白）', probe.diff >= 0 && probe.diff < 30, `像素差异 ${probe.diff}`)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

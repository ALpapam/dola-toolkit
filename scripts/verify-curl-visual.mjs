// Verifies the two visual complaints about the curl engine:
//   1. no vertical stripes: the shading must vary smoothly along x, with no
//      repeated step edges across the sheet
//   2. the back of the turning leaf must show the NEXT page (the page that
//      lands on the far half), not a mirror of the current page
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

// open the prose book in spread mode
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
await sleep(1200)

const rect = () =>
  ev(`(()=>{const s=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:s.x,y:s.y,w:s.width,h:s.height})})()`)

/* ---- 1. shading must be smooth (no stripe banding) ---- */
{
  const r = JSON.parse(await rect())
  const sx = r.x + r.w * 0.85
  const sy = r.y + r.h * 0.8
  await mouse('mousePressed', sx, sy)
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', sx - (r.w * 0.18 * i) / 10, sy)
    await sleep(30)
  }
  // scan one horizontal line across the whole canvas and look for repeated
  // step edges: banding shows up as many large jumps in brightness
  const scan = JSON.parse(
    await ev(`(()=>{
      const c=document.querySelector('.curl-canvas')
      const g=c.getContext('2d')
      const d=g.getImageData(0, Math.round(c.height*0.5), c.width, 1).data
      const lum=[]
      for(let x=0;x<c.width;x++){ const i=x*4; if(d[i+3]>8) lum.push(Math.round(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])) }
      let big=0
      for(let x=1;x<lum.length;x++){ if(Math.abs(lum[x]-lum[x-1])>26) big++ }
      return JSON.stringify({samples:lum.length, bigJumps:big})
    })()`)
  )
  await mouse('mouseReleased', sx - r.w * 0.18, sy)
  await sleep(1500)
  // a handful of edges is text; banding would produce dozens
  check('纸张着色平滑无竖条纹', scan.bigJumps <= 6, `亮度突变 ${scan.bigJumps} 处 / ${scan.samples} 采样`)
}

/* ---- 2. the back of the leaf must show the NEXT page ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1600)
  const before = await ev(`document.querySelector('.pgnum')?.textContent`)
  const result = JSON.parse(
    await ev(`(async()=>{
      const stage=document.querySelector('.reader-stage')
      const paper=document.querySelector('.reader-spread.current')
      const pr=paper.getBoundingClientRect()
      const half=pr.width/2
      const far={x:pr.x, y:pr.y, w:half, h:pr.height}   // LEFT half = where the leaf lands

      const grab=async(r)=>{
        const url=await window.api.app.capture({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.w),height:Math.round(r.h)})
        const im=new Image(); im.src=url; await new Promise(k=>{im.onload=k;im.onerror=k})
        const cv=document.createElement('canvas'); cv.width=Math.round(r.w); cv.height=Math.round(r.h)
        const g=cv.getContext('2d'); g.drawImage(im,0,0,cv.width,cv.height)
        return g.getImageData(0,0,cv.width,cv.height).data
      }
      const oldFar = await grab(far)        // the leaf's front neighbour (old left page)

      document.querySelector('.flip-fab.next').click()
      // wait until the canvas actually has the sheet on screen
      const cv=document.querySelector('.curl-canvas')
      const tmp=document.createElement('canvas'); tmp.width=cv.width; tmp.height=cv.height
      const tg=tmp.getContext('2d')
      let painted=false
      for(let k=0;k<40 && !painted;k++){
        await new Promise(r=>requestAnimationFrame(r))
        await new Promise(r=>setTimeout(r,12))
        tg.clearRect(0,0,tmp.width,tmp.height); tg.drawImage(cv,0,0)
        const d=tg.getImageData(0,0,tmp.width,tmp.height).data
        for(let i=3;i<d.length;i+=4*97){ if(d[i]>10){ painted=true; break } }
      }
      // probe a patch that the sheet has already swept over
      const W=tmp.width, H=tmp.height
      const px=Math.round(W*0.16), py=Math.round(H*0.42), sz=64
      const sheetProbe=tg.getImageData(px,py,sz,sz).data

      const newFar = await grab(far)        // what the far half shows once landed
      const dpr = half/Math.round(half)
      const gw=Math.round(half), gh=Math.round(pr.height)
      const qx=Math.round(gw*(px/W)), qy=Math.round(gh*(py/tmp.height))
      const slice=(d)=>{ const out=[]; for(let y=0;y<sz;y++){ for(let x=0;x<sz;x++){ const i=((qy+y)*gw+(qx+x))*4; out.push(d[i],d[i+1],d[i+2],d[i+3]) } } return out }
      const diff=(a,b)=>{ let s=0,n=0; for(let i=0;i<a.length;i+=4){ if(a[i+3]<10) continue; s+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]); n++ } return n? Math.round(s/(n*3)) : -1 }
      return JSON.stringify({ painted, vsOld: diff(sheetProbe, slice(oldFar)), vsNew: diff(sheetProbe, slice(newFar)) })
    })()`)
  )
  await sleep(1500)
  const after = await ev(`document.querySelector('.pgnum')?.textContent`)
  check('翻页生效', before !== after, `${before} -> ${after}`)
  check(
    '纸张背面显示下一页（而非当前页镜像）',
    result.painted && result.vsNew >= 0 && result.vsNew < result.vsOld,
    `与旧页差异 ${result.vsOld} / 与新页差异 ${result.vsNew}`
  )
}

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

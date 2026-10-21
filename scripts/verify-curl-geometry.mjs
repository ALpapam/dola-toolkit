// Verifies the rewritten curl geometry:
//   1. no mosaic: a patch of the leaf mid-turn must resemble the same patch of
//      the page it is supposed to show (text readable order, not shuffled)
//   2. the back of the leaf equals the NEW far page at the same screen position,
//      so the hand-off to the DOM at the end is seamless
//   3. horizontal swipe works anywhere on the sheet
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
const spread = () =>
  ev(`(()=>{const s=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:s.x,y:s.y,w:s.width,h:s.height})})()`)

/* ---- 1 + 2: mid-turn the back face must equal the new far page ---- */
{
  const b = await page()
  const result = JSON.parse(
    await ev(`(async()=>{
      const sp=document.querySelector('.reader-spread.current').getBoundingClientRect()
      const far={x:sp.x, y:sp.y, w:sp.width/2, h:sp.height}   // LEFT half (next lands here)
      // grab a region as CSS-sized ImageData (handles any DPR)
      const grabCss=async(r)=>{
        const url=await window.api.app.capture({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.w),height:Math.round(r.h)})
        const im=new Image(); im.src=url; await new Promise(k=>{im.onload=k;im.onerror=k})
        const cv=document.createElement('canvas'); cv.width=Math.round(r.w); cv.height=Math.round(r.h)
        cv.getContext('2d').drawImage(im,0,0,cv.width,cv.height)
        return cv.getContext('2d').getImageData(0,0,cv.width,cv.height)
      }
      document.querySelector('.flip-fab.next').click()
      await new Promise(r=>setTimeout(r, 330))
      const cv=document.querySelector('.curl-canvas')
      const rect=cv.getBoundingClientRect()
      const tmp=document.createElement('canvas'); tmp.width=Math.round(rect.width); tmp.height=Math.round(rect.height)
      tmp.getContext('2d').drawImage(cv,0,0,tmp.width,tmp.height)
      const canvasData=tmp.getContext('2d').getImageData(0,0,tmp.width,tmp.height)

      const newFar=await grabCss(far)   // CSS-sized far half, local coords
      // patch inside the far half, already covered by the leaf's back
      const px=Math.round(far.w*0.2), py=Math.round(far.h*0.4), sz=44
      // canvas coords: far half starts at stage-relative x = far.x - rect.x
      const cx0=Math.round(far.x-rect.x)+px, cy0=Math.round(far.y-rect.y)+py
      const cand=tmp.getContext('2d').getImageData(cx0,cy0,sz,sz).data
      const ref=newFar.data
      const gw=newFar.width
      let s=0,n=0
      for(let y=0;y<sz;y++){ for(let x=0;x<sz;x++){
        const ci=((y*sz)+x)*4
        const ri=((py+y)*gw+(px+x))*4
        if(cand[ci+3]<10) continue
        s+=Math.abs(cand[ci]-ref[ri])+Math.abs(cand[ci+1]-ref[ri+1])+Math.abs(cand[ci+2]-ref[ri+2]); n++
      }}
      return JSON.stringify({ diff: n?Math.round(s/(n*3)):-1, n })
    })()`)
  )
  await sleep(1400)
  check('翻页生效', (await page()) !== b, `${b} -> ${await page()}`)
  check('翻转中的背面 = 新页面同位置内容（无马赛克/镜像）', result.diff >= 0 && result.diff < 26, `像素平均差异 ${result.diff}`)
}

/* ---- 3: swipe works anywhere on the sheet ---- */
{
  await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
  await sleep(1500)
  for (const [label, fx, frac] of [
    ['中下部向右拖', 0.6, -0.45],
    ['中部向右拖', 0.55, -0.45],
    ['左上向回拖', 0.15, 0.45]
  ]) {
    const before = await page()
    const r = JSON.parse(await spread())
    const sx = r.x + r.w * fx
    const sy = r.y + r.h * (label.includes('左上') ? 0.2 : 0.62)
    await mouse('mousePressed', sx, sy)
    for (let i = 1; i <= 14; i++) {
      await mouse('mouseMoved', sx + (r.w * frac * i) / 14, sy)
      await sleep(20)
    }
    await mouse('mouseReleased', sx + r.w * frac, sy)
    await sleep(1500)
    check(`手势翻页：${label}`, (await page()) !== before, `${before} -> ${await page()}`)
  }
}

await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

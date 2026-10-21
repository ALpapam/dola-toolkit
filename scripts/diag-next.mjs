// Reproduces the "next page shows a grey blank sheet" report and measures what
// the canvas actually contains frame by frame.
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

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.clearDeviceMetricsOverride')
await sleep(1600)

// prose book, spread mode
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

// install a per-frame probe: opaque pixel count, contrast, and how many pixels
// match the PAPER_BACK tone (234,228,237) that means "no back image"
await ev(`(()=>{
  window.__probe=[]
  const cv=document.querySelector('.curl-canvas')
  if(!cv) return 'no canvas'
  const tick=()=>{
    if(!window.__probing) return
    const tmp=document.createElement('canvas'); tmp.width=200; tmp.height=120
    const g=tmp.getContext('2d')
    g.drawImage(cv,0,0,200,120)
    const d=g.getImageData(0,0,200,120).data
    let opaque=0,sum=0,sum2=0,n=0,paperBack=0
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]>10){ opaque++; const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; sum+=l; sum2+=l*l; n++
        if(Math.abs(d[i]-234)<6 && Math.abs(d[i+1]-228)<6 && Math.abs(d[i+2]-237)<6) paperBack++ }
    }
    const mean=n?sum/n:0
    window.__probe.push({t:Math.round(performance.now()),opaque,sd:n?+Math.sqrt(Math.max(0,sum2/n-mean*mean)).toFixed(1):0,paperBack})
    requestAnimationFrame(tick)
  }
  window.__probing=true; requestAnimationFrame(tick); return 'ok'
})()`)

const before = await ev(`document.querySelector('.pgnum')?.textContent`)
const t0 = await ev(`Math.round(performance.now())`)
logs.length = 0
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(1100)
await ev(`window.__probing=false`)
const after = await ev(`document.querySelector('.pgnum')?.textContent`)
const probe = JSON.parse(await ev(`JSON.stringify(window.__probe)`))

console.log(`next: ${before} -> ${after}`)
console.log(`[curl] 警告: ${logs.length} 条${logs.length ? ' → ' + logs.slice(0, 3).join(' | ') : ''}`)
console.log('\n逐帧 (t=相对毫秒, opaque=画布不透明像素, paperBack=灰纸色像素):')
probe.slice(0, 26).forEach((f) => {
  const mark = f.paperBack > f.opaque * 0.25 ? '  ← 灰色纸面' : ''
  console.log(`  +${f.t - t0}ms opaque=${String(f.opaque).padStart(5)} sd=${String(f.sd).padStart(5)} paperBack=${String(f.paperBack).padStart(5)}${mark}`)
})

// same for prev, for comparison
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(1200)
await ev(`document.querySelector('.flip-fab.next')?.click()`)
await sleep(1200)
await ev(`window.__probe=[]; window.__probing=true`)
const beforeP = await ev(`document.querySelector('.pgnum')?.textContent`)
logs.length = 0
await ev(`document.querySelector('.flip-fab.prev')?.click()`)
await sleep(1100)
await ev(`window.__probing=false`)
const probeP = JSON.parse(await ev(`JSON.stringify(window.__probe)`))
console.log(`\nprev: ${beforeP} -> ${await ev(`document.querySelector('.pgnum')?.textContent`)}  (警告 ${logs.length} 条)`)
probeP.slice(0, 16).forEach((f) => {
  const mark = f.paperBack > f.opaque * 0.25 ? '  ← 灰色纸面' : ''
  console.log(`  opaque=${String(f.opaque).padStart(5)} sd=${String(f.sd).padStart(5)} paperBack=${String(f.paperBack).padStart(5)}${mark}`)
})

ws.close()
process.exit(0)

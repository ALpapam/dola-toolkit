// EPUB with an illustration: turning through it must not fall back and must
// not blank out. Also checks the backward direction, which previously showed a
// grey half.
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

// open the EPUB (it now contains an illustration page)
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
// drop any earlier copy first: importPaths skips books already in the library,
// so the updated fixture (with the illustration) would otherwise be ignored
await ev(`(async()=>{
  const st=await window.api.library.state()
  const old=st.books.filter(b=>(b.title||'').includes('星海')).map(b=>b.id)
  if(old.length) await window.api.library.removeBooks(old)
  await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-epub.epub'])
})()`)
await sleep(2200)
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'},reader:{gpuAcceleration:true}}) })()`)
await sleep(1000)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2200)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('EPUB')); c?.click() })()`)
await sleep(9000)
check('EPUB 打开', await ev(`!!document.querySelector('.epub-host iframe')`))
// walk to the illustrated chapter and confirm its image is really there
let sawImage = false
for (let i = 0; i < 12 && !sawImage; i++) {
  sawImage = await ev(`(()=>{const f=document.querySelector('.epub-host iframe'); if(!f) return false; const d=f.contentDocument; return !!d && d.images.length>0 && d.images[0].complete && d.images[0].naturalWidth>0})()`)
  if (sawImage) break
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await sleep(750)
}
check('能翻到插图页且图片已解码', sawImage)

logs.length = 0
// walk forward through the book, then back
for (let i = 0; i < 8; i++) {
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await sleep(820)
}
const forwardLogs = logs.filter((l) => l.includes('fallback') || l.includes('snapshot'))
for (let i = 0; i < 8; i++) {
  await ev(`document.querySelector('.flip-fab.prev')?.click()`)
  await sleep(820)
}
const backLogs = logs.filter((l) => l.includes('fallback') || l.includes('snapshot'))
check('插图页翻页无空白降级', forwardLogs.length + backLogs.length === 0, `警告 ${forwardLogs.length + backLogs.length} 条`)

// the canvas must actually carry content while turning (not a flat sheet)
const content = JSON.parse(
  await ev(`(async()=>{
    document.querySelector('.flip-fab.next').click()
    await new Promise(r=>setTimeout(r, 300))
    const cv=document.querySelector('.curl-canvas')
    const tmp=document.createElement('canvas'); tmp.width=cv.width; tmp.height=cv.height
    tmp.getContext('2d').drawImage(cv,0,0)
    const d=tmp.getContext('2d').getImageData(0,0,tmp.width,tmp.height).data
    let opaque=0, sum=0, sum2=0, n=0
    for(let i=0;i<d.length;i+=4*7){ if(d[i+3]>10){ opaque++; const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; sum+=l; sum2+=l*l; n++ } }
    const mean=n?sum/n:0, sd=n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0
    return JSON.stringify({opaque, sd:+sd.toFixed(1)})
  })()`)
)
await sleep(1200)
check('翻转中画布有内容（非纯色纸）', content.opaque > 3000 && content.sd > 4, `不透明像素 ${content.opaque}，对比度 ${content.sd}`)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

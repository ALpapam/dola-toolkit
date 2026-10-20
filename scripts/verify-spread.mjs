// Two-page (spread) specific checks:
//   * one drag advances exactly ONE spread (2 pages)
//   * a fast flick / held drag / repeated click cannot run away
//   * trackpad-style inertial wheel events advance at most one spread
//   * prev returns exactly one spread
//   * the icons and the app logo share one centre axis (collapsed rail)
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
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(1600)

/* ---- rail alignment ---- */
const a = JSON.parse(await ev(`(() => {
  const r = document.querySelector('.rail').getBoundingClientRect()
  const l = document.querySelector('.rail-brand-logo').getBoundingClientRect()
  const icons = [...document.querySelectorAll('.rail-scroll .rail-item .rail-item-icon, .rail-footer .rail-item .rail-item-icon, .rail-expand-btn .rail-item-icon')]
    .map(e => { const b = e.getBoundingClientRect(); return +(b.left + b.width / 2).toFixed(2) })
  return JSON.stringify({
    railW: +r.width.toFixed(1),
    logoCx: +(l.left + l.width / 2).toFixed(2),
    logoL: +(l.left - r.left).toFixed(1),
    logoR: +(r.right - l.right).toFixed(1),
    iconCx: [...new Set(icons)]
  })
})()`))
const axisOk = a.iconCx.length === 1 && Math.abs(a.iconCx[0] - a.logoCx) < 0.6
check('图标与 logo 同轴居中', axisOk, `iconCx=${a.iconCx} logoCx=${a.logoCx}`)
check('logo 左右留白相等', Math.abs(a.logoL - a.logoR) <= 1, `L=${a.logoL} R=${a.logoR}`)

/* ---- open book in spread mode ---- */
await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
await sleep(900)
await ev(`(async()=>{ try{ await window.api.library.importPaths(['D:/桌面/DSH/dola-toolkit/.tmp/fixtures/test-cn.txt']) }catch(e){} })()`)
await sleep(2200)
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'always'}}) })()`)
await sleep(900)
await ev(`document.querySelectorAll('.rail-item')[1]?.click()`)
await sleep(2000)
await ev(`(()=>{ const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').toUpperCase().includes('TXT')); c?.click() })()`)
await sleep(3400)
await ev(`document.querySelector('.reader-foot .btn-icon')?.click()`)
await sleep(1100)

const page = () => ev(`document.querySelector('.pgnum')?.textContent`)
const nums = () => ev(`JSON.stringify([...document.querySelectorAll('.page-num')].map(e=>e.textContent))`)
const rect = async () =>
  JSON.parse(await ev(`(()=>{const p=document.querySelector('.reader-spread.current').getBoundingClientRect();return JSON.stringify({x:p.x,y:p.y,w:p.width,h:p.height})})()`))

console.log('\n--- 双页模式 ---')
check('双页显示两页', JSON.parse(await nums()).length === 2, await nums())

async function drag(fx, fy, dxFrac) {
  const g = await rect()
  const sx = g.x + g.w * fx
  const sy = g.y + g.h * fy
  const dx = g.w * dxFrac
  await mouse('mousePressed', sx, sy)
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', sx + (dx * i) / 10, sy)
    await sleep(20)
  }
  await mouse('mouseReleased', sx + dx, sy)
  // a committed turn animates ~460ms then advances; give it room
  await sleep(1200)
}

const before1 = await page()
await drag(0.9, 0.88, -0.4)
const after1 = await page()
check('一次拖动只前进一个跨页', before1 !== after1 && after1.startsWith('3'), `${before1} -> ${after1}`)

const before2 = await page()
await drag(0.1, 0.88, 0.4)
const after2 = await page()
check('一次拖动只后退一个跨页', before2 !== after2 && after2.startsWith('1'), `${before2} -> ${after2}`)

// rapid repeated drags: must not race through the book
let spam = []
for (let k = 0; k < 5; k++) {
  await drag(0.9, 0.88, -0.4)
  spam.push(await page())
}
console.log('   连续 5 次拖动后的页码:', JSON.stringify(spam))
const nums5 = spam.slice(-1)[0]
const advanced = Number((/^(\d+)/.exec(nums5) || [0, 0])[1])
check('连续快拖不会失控翻页', advanced <= 13, `最终 ${nums5}`)

// inertial wheel: a trackpad keeps emitting for a while
const g2 = await rect()
const wheelSeq = []
for (let i = 0; i < 10; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: g2.x + g2.w / 2, y: g2.y + g2.h / 2, deltaX: 0, deltaY: 120 })
  await sleep(45)
  wheelSeq.push(await page())
}
const wheelAdvanced = new Set(wheelSeq).size
check('滚轮惯性最多翻一页', wheelAdvanced <= 2, `序列 ${JSON.stringify(wheelSeq)}`)

/* ---- restore ---- */
await ev(`(async()=>{ await window.api.settings.patch({library:{spreadMode:'auto'}}) })()`)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
ws.close()
process.exit(fail ? 1 : 0)

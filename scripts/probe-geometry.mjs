// Probe the reader geometry at several window widths.
const PORT = Number(process.env.CDP_PORT ?? 9331)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find((x) => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result)
      pend.delete(m.id)
    }
  })
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value
  await send('Runtime.enable')

  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
  await sleep(900)
  console.log(
    'open:',
    await ev(`(() => {
      const c = [...document.querySelectorAll('.book-card')].find(x => (x.textContent||'').includes('长篇测试之书'))
      if (c) c.click()
      return c ? 'opened' : 'not found'
    })()`)
  )
  await sleep(2400)
  console.log('label:', await ev(`document.querySelector('.pgnum')?.textContent`))

  const probe = `(() => {
    const stage = document.querySelector('.reader-stage')
    const pages = [...document.querySelectorAll('.reader-page')]
    const sr = stage ? stage.getBoundingClientRect() : null
    const spread = document.querySelector('.reader-spread')
    return JSON.stringify({
      innerW: window.innerWidth,
      stageW: sr ? Math.round(sr.width) : null,
      stageH: sr ? Math.round(sr.height) : null,
      pageCount: pages.length,
      pageW: pages.map(p => Math.round(p.getBoundingClientRect().width)),
      pageH: pages.map(p => Math.round(p.getBoundingClientRect().height)),
      spreadW: spread ? Math.round(spread.getBoundingClientRect().width) : null,
      label: document.querySelector('.pgnum')?.textContent
    })
  })()`

  for (const w of [1280, 1100, 1000, 900, 860, 820, 760, 720]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 1, mobile: false })
    await sleep(1000)
    console.log(w, await ev(probe))
  }
  ws.close()
  process.exit(0)
}
main()

// Reader-focused capture: seeds a long book, verifies spread/single/zone flip.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const OUT = resolve(process.argv[2] ?? '.screenshots')
const PORT = Number(process.env.CDP_PORT ?? 9331)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : r(m.result)
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? ''))
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('shot ->', name)
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find((x) => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)

  console.log(
    await ev(
      cdp,
      `(async () => {
    const r = await window.api.library.importPaths(['D:/桌面/DSH/moebox/.tmp/fixtures/test-long.txt'])
    return 'seeded ' + r.added.length
  })()`
    )
  )
  await sleep(1500)

  // open library and reset to grid + all books
  await ev(cdp, `[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
  await sleep(1200)

  // find the long book card and open it
  const opened = await ev(
    cdp,
    `(() => {
    const cards = [...document.querySelectorAll('.book-card')]
    const c = cards.find(x => (x.textContent||'').includes('长篇测试之书'))
    if (!c) return 'not found: ' + cards.map(x=>x.textContent.slice(0,20)).join('|')
    c.click(); return 'ok'
  })()`
  )
  console.log('open long book:', opened)
  await sleep(2600)
  await shot(cdp, 'r1-reader-spread')

  const dims = await ev(
    cdp,
    `(() => {
    const pages = [...document.querySelectorAll('.reader-page')]
    const spread = document.querySelector('.reader-spread')
    const stage = document.querySelector('.reader-stage')
    const first = pages[0]
    return JSON.stringify({
      pageCount: pages.length,
      spreadW: spread ? Math.round(spread.getBoundingClientRect().width) : null,
      stageW: stage ? Math.round(stage.getBoundingClientRect().width) : null,
      pageW: first ? Math.round(first.getBoundingClientRect().width) : null,
      pageH: first ? Math.round(first.getBoundingClientRect().height) : null,
      twoUp: document.querySelectorAll('.reader-page').length === 2,
      label: document.querySelector('.pgnum')?.textContent
    })
  })()`
  )
  console.log('spread dims:', dims)

  // next page twice
  await ev(cdp, `document.querySelector('.flip-fab.next')?.click()`)
  await sleep(800)
  await ev(cdp, `document.querySelector('.flip-fab.next')?.click()`)
  await sleep(900)
  await shot(cdp, 'r2-reader-page3-4')
  console.log('after next:', await ev(cdp, `document.querySelector('.pgnum')?.textContent`))

  // zone click: bottom-right quarter of the stage
  await ev(
    cdp,
    `(() => {
    const stage = document.querySelector('.reader-stage')
    const r = stage.getBoundingClientRect()
    const x = r.left + r.width * 0.88
    const y = r.top + r.height * 0.9
    const el = document.elementFromPoint(x, y)
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
    return el ? el.className : 'no el'
  })()`
  )
  await sleep(900)
  await shot(cdp, 'r3-reader-zone-flip')
  console.log('after zone flip:', await ev(cdp, `document.querySelector('.pgnum')?.textContent`))

  // narrow window -> single page
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(1400)
  await shot(cdp, 'r4-reader-single')
  console.log(
    'narrow:',
    await ev(cdp, `JSON.stringify({pages: document.querySelectorAll('.reader-page').length, label: document.querySelector('.pgnum')?.textContent})`)
  )

  // wide again
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(1200)
  await shot(cdp, 'r5-reader-wide-again')

  // dark reader
  await ev(cdp, `window.api.settings.patch({appearance:{themeMode:'dark'}})`)
  await sleep(1400)
  await shot(cdp, 'r6-reader-dark')
  await ev(cdp, `window.api.settings.patch({appearance:{themeMode:'system'}})`)
  await sleep(600)

  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 10)))
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

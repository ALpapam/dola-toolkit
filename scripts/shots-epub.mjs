// Capture the epub.js reader on a text page and an illustration plate.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9360)
const OUT = resolve(process.argv[2] ?? '.shots-epub')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : r(m.result)
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

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
    return r.exceptionDetails ? null : r.result?.value
  }
  const shot = async (name) => {
    await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await sleep(320)
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log('shot', name)
  }
  await sleep(2000)

  // library
  await ev(`[...document.querySelectorAll('.rail-item')].find(x=>(x.textContent||'').includes('书库'))?.click()`)
  await sleep(1600)
  await shot('01-library')

  // open vol 01
  await ev(`(() => {
    const c=[...document.querySelectorAll('.book-card')].find(x=>{
      const e=x.querySelector('.book-title'); return e && e.textContent.includes('01 聽說')
    }); if(c)c.click(); return !!c
  })()`)
  await sleep(5000)
  await shot('02-reader-cover')

  // advance to a text chapter
  for (let i = 0; i < 6; i++) {
    await ev(`document.querySelector('.flip-fab.next')?.click()`)
    await sleep(700)
  }
  await shot('03-reader-text')

  // seek to an illustration via the slider sweep
  const found = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = () => document.querySelector('.reader-foot .slider')
    const setPct = (p) => {
      const el = s(); if (!el) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(el, String(p)); el.dispatchEvent(new Event('input',{bubbles:true}))
    }
    for (let i = 1; i <= 20; i++) {
      setPct(i/20)
      await sleep(500)
      const f = document.querySelector('.epub-host iframe')
      let doc=null; try { doc=f?.contentDocument } catch(e){}
      const imgs = doc ? [...doc.querySelectorAll('img')] : []
      const big = imgs.find(im => im.naturalWidth > 600)
      if (big) return 'found at ' + Math.round(i/20*100) + '%'
    }
    return 'none'
  })()`)
  console.log('illustration:', found)
  await sleep(900)
  await shot('04-reader-illustration')

  // dark mode
  await ev(`window.api.settings.patch({appearance:{themeMode:'dark'}})`)
  await sleep(1600)
  await shot('05-reader-dark')
  await ev(`window.api.settings.patch({appearance:{themeMode:'system'}})`)
  await sleep(800)

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})

// Reliable screenshots: wait for real paint before each capture.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9355)
const OUT = resolve(process.argv[2] ?? '.shots')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl)
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
  const send = (mm, p) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method: mm, params: p }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.exceptionDetails ? null : r.result?.value
  }

  /** Wait for two animation frames + compositor commit before capturing. */
  const settle = async (ms = 700) => {
    await sleep(ms)
    await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await sleep(260)
  }

  const shot = async (name) => {
    await settle(0)
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log('shot', name)
  }

  const rail = (label) =>
    ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').trim().includes(${JSON.stringify(label)}))?.click()`)
  const snav = (label) =>
    ev(`[...document.querySelectorAll('.snav')].find(b=>(b.textContent||'').includes(${JSON.stringify(label)}))?.click()`)

  await send('Runtime.enable')
  await send('Page.enable')

  // seed two demo books so the library shot is meaningful
  await ev(`(async () => {
    await window.api.library.importPaths([
      'D:/桌面/DSH/moebox/.tmp/fixtures/test-epub.epub',
      'D:/桌面/DSH/moebox/.tmp/fixtures/test-fb2.fb2',
      'D:/桌面/DSH/moebox/.tmp/fixtures/test-long.txt'
    ])
    return 1
  })()`)
  await settle(1600)

  await ev(`window.api.settings.patch({appearance:{themeMode:'light'}})`)
  await settle(1200)

  // 1. home with rail expanded
  await rail('Dola Toolkit')
  await settle(900)
  let expanded = await ev(`document.querySelector('.rail')?.classList.contains('expanded')`)
  if (!expanded) {
    await ev(`document.querySelector('.rail-expand-btn')?.click()`)
    await settle(900)
  }
  await shot('01-home-rail-expanded')

  // 2. rail collapsed
  await ev(`document.querySelector('.rail-expand-btn')?.click()`)
  await settle(900)
  await shot('02-home-rail-collapsed')

  // 3. proxy
  await rail('代理')
  await settle(1200)
  await shot('03-proxy')

  // 4. add node dialog
  await ev(`[...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes('添加节点'))?.click()`)
  await settle(900)
  await shot('04-proxy-add-node')
  await ev(`document.querySelector('.dialog-foot .btn-text')?.click()`)
  await settle(600)

  // 5. library grid
  await rail('书库')
  await settle(1600)
  await shot('05-library-grid')

  // 6. library list
  await ev(`(() => { const b=[...document.querySelectorAll('.icon-seg .btn-icon')]; const t=b.find(x=>x.title==='列表'); t?.click(); return !!t })()`)
  await settle(900)
  await shot('06-library-list')
  await ev(`(() => { const b=[...document.querySelectorAll('.icon-seg .btn-icon')]; const t=b.find(x=>x.title==='网格'); t?.click(); return !!t })()`)
  await settle(800)

  // 7. reader (double page)
  const opened = await ev(
    `(() => { const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').includes('长篇')); if(c) c.click(); return !!c })()`
  )
  console.log('reader opened:', opened)
  await settle(2800)
  await shot('07-reader-double-page')

  // 8. reader after flipping
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await settle(1100)
  await shot('08-reader-flipped')

  await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
  await settle(1000)

  // 9-12. settings sections
  await rail('设置')
  await settle(1200)
  await shot('09-settings-appearance')
  await snav('AI')
  await settle(900)
  await shot('10-settings-ai')
  await snav('WebDAV')
  await settle(900)
  await shot('11-settings-webdav')
  await snav('关于')
  await settle(900)
  await shot('12-settings-about')

  // 13-14. dark mode
  await ev(`window.api.settings.patch({appearance:{themeMode:'dark'}})`)
  await settle(1600)
  await snav('外观与取色')
  await settle(900)
  await shot('13-dark-appearance')
  await rail('书库')
  await settle(1500)
  await shot('14-dark-library')

  await ev(`window.api.settings.patch({appearance:{themeMode:'system'}})`)
  await settle(900)
  ws.close()
  process.exit(0)
}
main()

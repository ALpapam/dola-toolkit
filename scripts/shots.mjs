// Drive the running app over CDP and capture PNG screenshots of every page.
// Usage: node scripts/shots.mjs [outDir]   (app must be started via run-app.mjs)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve(process.argv[2] ?? '.tmp/shots')
const PORT = Number(process.env.CDP_PORT ?? 9331)
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await r.json()
  return list.find((t) => t.type === 'page')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else res(msg.result)
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.errors.push('EXC ' + (d.exception?.description ?? d.text))
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

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result?.value
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('shot ->', name)
}

const clickRail = (label) => `(() => {
  const items = [...document.querySelectorAll('.rail-item, .rail-expand-btn')]
  const el = items.find(b => (b.textContent || '').trim().includes(${JSON.stringify(label)}))
  if (!el) return 'NOT FOUND: ' + ${JSON.stringify(label)}
  el.click(); return 'ok'
})()`

const clickText = (sel, label) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(b => (b.textContent || '').includes(${JSON.stringify(label)}))
  if (!el) return 'NOT FOUND'
  el.click(); return 'ok'
})()`

/** Measure the rail: are icons really on one axis? */
const railGeometry = `(() => {
  const rail = document.querySelector('.rail')
  if (!rail) return { error: 'no rail' }
  const rr = rail.getBoundingClientRect()
  const cx = rr.left + rr.width / 2
  const measure = (sel) => [...document.querySelectorAll(sel)].map(el => {
    const b = el.getBoundingClientRect()
    const icon = el.querySelector('.rail-item-icon') || el
    const ib = icon.getBoundingClientRect()
    return { left: +b.left.toFixed(1), right: +b.right.toFixed(1),
             iconCx: +(ib.left + ib.width / 2).toFixed(1) }
  })
  const logo = document.querySelector('.rail-brand-logo')
  const lb = logo ? logo.getBoundingClientRect() : null
  return {
    railW: +rr.width.toFixed(1),
    railCx: +cx.toFixed(1),
    logoCx: lb ? +(lb.left + lb.width / 2).toFixed(1) : null,
    tools: measure('.rail-scroll .rail-item'),
    settings: measure('.rail-footer .rail-item'),
    expand: measure('.rail-expand-btn'),
    expanded: rail.classList.contains('expanded')
  }
})()`

async function main() {
  const target = await getTarget()
  if (!target) throw new Error('no devtools page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(1500)

  // seed a few books so the shelf is not empty
  await evaluate(
    cdp,
    `(async () => {
      try {
        await window.api.library.importPaths([
          '${resolve('.tmp/fixtures/test-epub.epub').replace(/\\/g, '/')}',
          '${resolve('.tmp/fixtures/test-cn.txt').replace(/\\/g, '/')}',
          '${resolve('.tmp/fixtures/test-fb2.fb2').replace(/\\/g, '/')}'
        ])
        return 'seeded'
      } catch (e) { return 'seed-failed: ' + e.message }
    })()`
  )
  await sleep(2500)

  console.log('\n--- rail geometry (collapsed) ---')
  console.log(JSON.stringify(await evaluate(cdp, railGeometry), null, 2))

  const steps = [
    ['01-home', null, 1200],
    ['02-home-rail-expanded', `document.querySelector('.rail-expand-btn').click()`, 900],
    ['03-proxy', clickRail('代理'), 1600],
    ['04-proxy-addnode', clickText('button', '添加节点'), 1000],
    ['05-proxy-addnode-form', `(() => { const b=[...document.querySelectorAll('.proto-btn')].find(x=>(x.textContent||'').includes('Trojan')); if(b){b.click(); return 'ok'} return 'no proto' })()`, 900],
    ['06-proxy-import', `(() => { document.querySelector('.dialog-foot .btn-text')?.click(); return 'closed' })()`, 500],
    ['07-proxy-import-dialog', clickText('button', '导入链接'), 900],
    ['08-library', `(() => { document.querySelector('.dialog-foot .btn-text')?.click(); const r=[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库')); r?.click(); return 'ok' })()`, 1800],
    ['09-library-list', `document.querySelector('.icon-seg .btn-icon[title="列表"]')?.click()`, 800],
    ['10-library-grid', `document.querySelector('.icon-seg .btn-icon[title="网格"]')?.click()`, 800],
    ['11-catalog', clickText('button', '免费书源'), 3000],
    ['12-catalog-close', `document.querySelector('.dialog-foot .btn-text')?.click()`, 500],
    ['13-reader', `document.querySelector('.book-card')?.click()`, 3000],
    ['14-reader-next', `document.querySelector('.flip-fab.next')?.click(); document.querySelector('.flip-fab.next')?.click()`, 1400],
    ['15-reader-close', `document.querySelector('.reader-bar .btn-icon')?.click()`, 1000],
    ['16-settings', clickRail('设置'), 1200],
    ['17-settings-presets', null, 400],
    ['18-settings-ai', clickText('.snav', 'AI'), 900],
    ['19-settings-sync', clickText('.snav', 'WebDAV'), 900],
    ['20-settings-library', clickText('.snav', '书库'), 900],
    ['21-settings-general', clickText('.snav', '通用'), 900],
    ['22-settings-about', clickText('.snav', '关于'), 900],
    ['23-dark-home', `(async () => {
        await window.api.settings.patch({ appearance: { themeMode: 'dark' } })
        const r = [...document.querySelectorAll('.rail-item')].find(b => (b.textContent||'').trim().includes('Dola') || b.getAttribute('aria-label') === '设置')
        document.querySelector('.rail-brand')?.click()
        return 'dark'
      })()`, 1600],
    ['24-dark-library', clickRail('书库'), 1600],
    ['25-dark-settings', clickRail('设置'), 1200],
    ['26-dark-settings-presets', clickText('.snav', '外观'), 900]
  ]

  for (const [name, script, wait] of steps) {
    if (script) {
      try {
        const res = await evaluate(cdp, script)
        if (typeof res === 'string' && res !== 'ok') console.log(`  [${name}] ${res}`)
      } catch (e) {
        console.log(`  [${name}] step error: ${e.message.split('\n')[0]}`)
      }
    }
    await sleep(wait)
    await shot(cdp, name)
  }

  // restore light theme
  await evaluate(cdp, `window.api.settings.patch({ appearance: { themeMode: 'light' } })`).catch(() => undefined)

  console.log('\n--- rail geometry (expanded) ---')
  console.log(JSON.stringify(await evaluate(cdp, railGeometry), null, 2))
  console.log('\nconsole errors:', JSON.stringify(cdp.errors.slice(0, 15), null, 2))
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

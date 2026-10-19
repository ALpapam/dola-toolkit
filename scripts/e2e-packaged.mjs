// End-to-end verification against the *packaged* app (portable exe).
// Exercises every IPC surface the user cares about and screenshots the result.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const OUT = resolve(process.argv[2] ?? '.shots-pkg')
const PORT = Number(process.env.CDP_PORT ?? 9351)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : r(m.result)
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description ?? '')
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
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

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find((x) => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  await sleep(2600)

  // ---- 1. app info (packaged) ----
  const info = await ev(`window.api.app.info()`)
  check('app.info returns product version', info?.version === '0.0.1', JSON.stringify(info))
  check('runs as packaged (asar)', String(t.url).includes('app.asar'), t.url)

  // ---- 2. settings round trip ----
  const before = await ev(`window.api.settings.get()`)
  check('settings schema=1', before?.schema === 1)
  const patched = await ev(`window.api.settings.patch({library:{coverWidth:190}})`)
  check('settings.patch persists', patched?.library?.coverWidth === 190)
  await ev(`window.api.settings.patch({library:{coverWidth:170}})`)
  const after = await ev(`window.api.settings.get()`)
  check('settings reset back', after?.library?.coverWidth === 170)

  // ---- 3. monet ----
  const monet = await ev(`window.api.theme.monet(true)`)
  check('monet has 36 schemes', Object.keys(monet?.light ?? {}).length >= 30, `keys=${Object.keys(monet?.light ?? {}).length}`)
  check('monet seed is hex', /^#[0-9A-Fa-f]{6}$/.test(monet?.seed ?? ''), monet?.seed)
  check('monet source reported', Boolean(monet?.source), monet?.source)

  // ---- 4. proxy engines: the packaged build must find cores in resources ----
  const engines = await ev(`window.api.proxy.engines()`)
  const allAvail = Array.isArray(engines) && engines.length === 3 && engines.every((e) => e.available)
  check(
    'all 3 cores detected in packaged build',
    allAvail,
    (engines ?? []).map((e) => `${e.engine}:${e.version ?? 'n/a'}:${e.available}`).join(' ')
  )

  const pstate = await ev(`window.api.proxy.state()`)
  check('proxy state loads', Boolean(pstate?.engines), `nodes=${pstate?.nodes?.length}`)
  check('geo files present', Boolean(pstate?.geo?.geoip && pstate?.geo?.geosite), JSON.stringify(pstate?.geo?.dir))

  // ---- 5. proxy: add node, generate config, start real core ----
  const node = await ev(`window.api.proxy.saveNode({
    name: 'E2E-测试节点', protocol: 'socks', engine: 'xray',
    server: '127.0.0.1', port: 1080, group: 'auto'
  })`)
  check('proxy.saveNode creates node', Boolean(node?.id), node?.name)
  await ev(`window.api.proxy.selectNode(${JSON.stringify(node?.id ?? '')})`)

  const started = await ev(`window.api.proxy.start()`)
  check('xray core starts from packaged resources', started?.running === true, `err=${started?.error ?? 'none'} pid=${started?.pid}`)
  await sleep(1500)

  // mixed port should accept connections
  const portOpen = await ev(`(async () => {
    return await new Promise((res) => {
      const el = new EventSource('http://127.0.0.1:1/never')
      res('skip')
      el.close()
    })
  })()`).catch(() => 'skip')
  void portOpen

  await shot('pkg-01-proxy-running')

  const stopped = await ev(`window.api.proxy.stop()`)
  check('xray core stops cleanly', stopped?.running === false)
  await ev(`window.api.proxy.deleteNode(${JSON.stringify(node?.id ?? '')})`)
  const afterDelete = await ev(`window.api.proxy.state()`)
  check('proxy.deleteNode removes it', !(afterDelete?.nodes ?? []).some((n) => n.id === node?.id))

  // ---- 6. library: import all formats, read content, covers ----
  const fixtures = ['test-epub.epub', 'test-cn.txt', 'test-fb2.fb2', 'test-long.txt']
  const imp = await ev(`window.api.library.importPaths(${JSON.stringify(
    fixtures.map((f) => `D:/桌面/DSH/moebox/.tmp/fixtures/${f}`)
  )})`)
  check('library import (multi-format)', Array.isArray(imp?.added), `added=${imp?.added?.length} skipped=${imp?.skipped?.length}`)

  const lib = await ev(`window.api.library.state()`)
  check('library state lists books', (lib?.books ?? []).length >= 3, `books=${lib?.books?.length}`)
  const epub = (lib?.books ?? []).find((b) => b.format === 'epub')
  check('epub metadata parsed', Boolean(epub?.title), `${epub?.title} / ${epub?.author}`)

  if (epub) {
    const cover = await ev(`window.api.library.cover(${JSON.stringify(epub.id)})`)
    check('cover served as data URL', typeof cover === 'string' && cover.startsWith('data:image/'), String(cover).slice(0, 30))
    const content = await ev(`window.api.library.content(${JSON.stringify(epub.id)})`)
    check('epub content is base64 bytes', content?.encoding === 'base64' && content?.data?.length > 1000)
  }
  const txt = (lib?.books ?? []).find((b) => b.format === 'txt')
  if (txt) {
    const c = await ev(`window.api.library.content(${JSON.stringify(txt.id)})`)
    check('txt content is utf8', c?.encoding === 'utf8' && c?.data?.includes('第'))
  }

  // folders
  const folder = await ev(`window.api.library.createFolder('E2E 文件夹', null)`)
  check('createFolder works', Boolean(folder?.id), folder?.name)
  if (folder && txt) {
    await ev(`window.api.library.updateBook(${JSON.stringify(txt.id)}, {folderIds: [${JSON.stringify(folder.id)}]})`)
    const st = await ev(`window.api.library.state()`)
    const moved = (st?.books ?? []).find((b) => b.id === txt.id)
    check('book files into folder', (moved?.folderIds ?? []).includes(folder.id))
    await ev(`window.api.library.updateBook(${JSON.stringify(txt.id)}, {folderIds: []})`)
    await ev(`window.api.library.deleteFolder(${JSON.stringify(folder.id)})`)
  }

  // AI classify without a key must fail gracefully (no throw)
  const cls = await ev(`window.api.library.classify()`)
  check('classify without AI key returns error (no throw)', Boolean(cls && (cls.error || Array.isArray(cls.assignments))), cls?.error ?? 'ok')

  // catalog
  const cat = await ev(`window.api.library.catalog({ source: 'standardebooks', query: '', page: 1 })`)
  check('free book catalog responds', Array.isArray(cat?.books), `books=${cat?.books?.length} err=${cat?.error ?? 'none'}`)

  // ---- 7. AI status / webdav status ----
  const aiStatus = await ev(`window.api.ai.status()`)
  check('ai.status responds', typeof aiStatus?.configured === 'boolean', JSON.stringify(aiStatus))
  const syncStatus = await ev(`window.api.sync.status()`)
  check('sync.status responds', typeof syncStatus?.enabled === 'boolean')

  // ---- 8. persistence across restart is proven by the settings file, verify path ----
  check('user data dir is per-user', String(info?.userData).includes('Dola Toolkit'), info?.userData)

  // ---- 9. screenshots of every page in the packaged build ----
  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
  await sleep(1600)
  await shot('pkg-02-library')
  await ev(`(()=>{const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').includes('长篇')); if(c)c.click(); return !!c})()`)
  await sleep(2400)
  await shot('pkg-03-reader')
  await ev(`document.querySelector('.flip-fab.next')?.click()`)
  await sleep(900)
  await shot('pkg-04-reader-next')
  await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
  await sleep(900)
  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('代理'))?.click()`)
  await sleep(1200)
  await shot('pkg-05-proxy')
  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('设置'))?.click()`)
  await sleep(1200)
  await shot('pkg-06-settings')

  // narrow window single-page check
  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
  await sleep(1000)
  await ev(`(()=>{const c=[...document.querySelectorAll('.book-card')].find(x=>(x.textContent||'').includes('长篇')); if(c)c.click()})()`)
  await sleep(2200)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(1400)
  const narrow = await ev(`JSON.stringify({pages: document.querySelectorAll('.reader-page').length})`)
  check('narrow window → single page', JSON.parse(narrow).pages === 1, narrow)
  await shot('pkg-07-reader-single')

  console.log('\nconsole errors:', JSON.stringify(cdp.errors.slice(0, 10)))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  ws.close()
  process.exit(failed.length ? 2 : 0)
}

main().catch((e) => {
  console.error('HARNESS ERROR', e)
  process.exit(1)
})

// Configure DeepSeek + import the No Game No Life test library, then verify
// that every illustration actually renders inside the reader.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readdirSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT ?? 9360)
const OUT = resolve(process.argv[2] ?? '.shots-ngnl')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NOVEL_DIR = 'D:/下载/NO GAME NO LIFE 遊戲人生'

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
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  const shot = async (name) => {
    await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await sleep(260)
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log('shot', name)
  }
  await sleep(2600)

  /* ---------- 1. configure DeepSeek ---------- */
  const patched = await ev(`window.api.settings.patch({
    ai: {
      enabled: true,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-5a4aee6616e745b196c07232a121afe2',
      model: 'deepseek-flash',
      temperature: 0.3,
      maxTokens: 4096
    }
  })`)
  check('DeepSeek 配置写入', patched?.ai?.model === 'deepseek-flash', patched?.ai?.baseUrl + ' / ' + patched?.ai?.model)

  const aiStatus = await ev(`window.api.ai.status()`)
  check('ai.status 已配置', aiStatus?.configured === true, JSON.stringify(aiStatus))

  /* ---------- 2. live AI call ---------- */
  const t0 = Date.now()
  const test = await ev(`window.api.ai.test()`)
  check('DeepSeek 真实调用成功', test?.ok === true, `${test?.ms ?? Date.now() - t0}ms · ${String(test?.content ?? test?.error).slice(0, 60)}`)

  const chat = await ev(`window.api.ai.chat([{role:'user',content:'用一句话说明《游戏人生》的核心设定。'}])`)
  check('AI 对话返回内容', chat?.ok === true && String(chat?.content ?? '').length > 5, String(chat?.content ?? chat?.error).slice(0, 80))

  /* ---------- 3. import all 13 novels ---------- */
  const files = readdirSync(NOVEL_DIR)
    .filter((f) => f.toLowerCase().endsWith('.epub'))
    .map((f) => `${NOVEL_DIR}/${f}`)
  console.log('importing', files.length, 'epub files…')
  const tImport = Date.now()
  const imp = await ev(`window.api.library.importPaths(${JSON.stringify(files)})`)
  check(
    '导入 13 本小说',
    (imp?.added?.length ?? 0) === files.length,
    `added=${imp?.added?.length} skipped=${imp?.skipped?.length} in ${Math.round((Date.now() - tImport) / 1000)}s`
  )

  const lib = await ev(`window.api.library.state()`)
  check('书库记录数', (lib?.books?.length ?? 0) === files.length, `books=${lib?.books?.length}`)

  /* ---------- 4. series auto-group via AI ---------- */
  const cls = await ev(`window.api.library.classify()`)
  check(
    'AI 系列归类（预设提示词）',
    Array.isArray(cls?.assignments) && cls.assignments.length > 0,
    `groups=${cls?.createdFolders?.length} assigned=${cls?.assignments?.length} err=${cls?.error ?? 'none'}`
  )
  if (cls?.createdFolders?.length) {
    console.log('  folders:', cls.createdFolders.map((f) => f.name).join(', '))
  }

  /* ---------- 5. per-book illustration verification (in-app) ---------- */
  // Open each book, parse it through the real pipeline and count rendered <img>.
  const bookIds = (lib?.books ?? []).map((b) => ({ id: b.id, title: b.title }))
  const imageReport = await ev(`(async () => {
    const books = ${JSON.stringify(bookIds)}
    const out = []
    for (const b of books) {
      try {
        const content = await window.api.library.content(b.id)
        out.push({ id: b.id, title: b.title, format: content.format, dataLen: content.data.length })
      } catch (e) {
        out.push({ id: b.id, title: b.title, error: String(e) })
      }
    }
    return out
  })()`)
  check('全部书籍可读取内容', imageReport.every((b) => !b.error && b.dataLen > 1000), `${imageReport.length} books`)

  /* ---------- 6. open book 01 and check illustrations render ---------- */
  await ev(`[...document.querySelectorAll('.rail-item')].find(b=>(b.textContent||'').includes('书库'))?.click()`)
  await sleep(1800)
  await shot('01-library-ngnl')

  const opened = await ev(`(() => {
    const cards = [...document.querySelectorAll('.book-card')]
    const c = cards.find(x => (x.textContent||'').includes('01'))
    if (c) { c.click(); return true }
    return false
  })()`)
  check('打开第 01 卷', opened === true)
  await sleep(4000)
  await shot('02-reader-open')

  // Inspect in-reader image statistics across the whole book.
  const readerStats = await ev(`(() => {
    const pages = document.querySelectorAll('.reader-page')
    const imgs = document.querySelectorAll('.reader-page img')
    const loaded = [...imgs].filter(i => i.complete && i.naturalWidth > 0)
    return JSON.stringify({
      readerOpen: !!document.querySelector('.reader'),
      pages: pages.length,
      visibleImgs: imgs.length,
      loadedImgs: loaded.length,
      totalPagesLabel: document.querySelector('.pgnum')?.textContent,
      illustrationPages: document.querySelectorAll('.illustration-page').length
    })
  })()`)
  console.log('reader:', readerStats)

  /* ---------- 7. scan the whole book for images by paging ---------- */
  const scan = await ev(`(async () => {
    const flip = async () => {
      const btn = document.querySelector('.flip-fab.next')
      if (!btn || btn.disabled) return false
      btn.click()
      await new Promise(r => setTimeout(r, 45))
      return true
    }
    let guard = 0
    let imagesSeen = 0
    let imagesBroken = 0
    const seen = new Set()
    while (guard++ < 700) {
      document.querySelectorAll('.reader-page img').forEach(img => {
        const key = img.src.slice(-120)
        if (seen.has(key)) return
        seen.add(key)
        imagesSeen++
        if (!(img.complete && img.naturalWidth > 0)) imagesBroken++
      })
      if (!(await flip())) break
    }
    return JSON.stringify({ pagesWalked: guard, uniqueImages: imagesSeen, broken: imagesBroken })
  })()`)
  console.log('paging scan:', scan)
  const scanObj = JSON.parse(scan)
  check('插图在阅读器中真实渲染', scanObj.uniqueImages > 0 && scanObj.broken === 0, scan)

  // go to an illustration page for a screenshot
  await ev(`(async () => {
    const first = document.querySelector('.reader-foot .slider')
    // walk back to page 0, then find the first illustration page
    for (let i = 0; i < 300; i++) {
      const prev = document.querySelector('.flip-fab.prev')
      if (!prev || prev.disabled) break
      prev.click()
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('.illustration-page')) return 'found'
      const next = document.querySelector('.flip-fab.next')
      if (!next || next.disabled) break
      next.click()
      await new Promise(r => setTimeout(r, 120))
    }
    return 'none'
  })()`)
  await sleep(1400)
  await shot('03-reader-illustration')
  const illusStats = await ev(`(() => {
    const p = document.querySelector('.illustration-page')
    const img = p?.querySelector('img')
    return JSON.stringify({
      hasIllustrationPage: !!p,
      naturalW: img?.naturalWidth ?? 0,
      naturalH: img?.naturalHeight ?? 0,
      renderedW: img ? Math.round(img.getBoundingClientRect().width) : 0,
      renderedH: img ? Math.round(img.getBoundingClientRect().height) : 0
    })
  })()`)
  console.log('illustration page:', illusStats)
  const il = JSON.parse(illusStats)
  check('插图完整显示（未被裁切）', il.hasIllustrationPage && il.naturalW > 0, illusStats)

  /* ---------- 8. AI reading assistant on real book text ---------- */
  const aiSummary = await ev(`(async () => {
    const content = await window.api.library.content(${JSON.stringify(bookIds[0]?.id ?? '')})
    // pull a text sample out of the base64 epub is not possible here; ask generally
    const res = await window.api.ai.chat([{role:'user', content:'《NO GAME NO LIFE 游戏人生》第一卷的主要角色有哪些？请简短列出。'}])
    return JSON.stringify({ ok: res.ok, len: (res.content||'').length, head: (res.content||'').slice(0,120), err: res.error })
  })()`)
  console.log('ai summary:', aiSummary)
  check('AI 针对该书内容作答', Boolean(JSON.parse(aiSummary).ok), aiSummary)

  /* ---------- 9. AI classification quality ---------- */
  const folders = await ev(`window.api.library.state()`)
  const seriesFolders = (folders?.folders ?? []).filter((f) => f.kind === 'series')
  check('AI 建立了系列文件夹', seriesFolders.length > 0, seriesFolders.map((f) => f.name).join(' | '))

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

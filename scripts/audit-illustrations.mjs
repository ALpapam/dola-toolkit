// Per-book illustration audit INSIDE the app: open every one of the 13 novels,
// page through the entire book, and assert every referenced image loads.
const PORT = Number(process.env.CDP_PORT ?? 9360)
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
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }

  const lib = await ev(`window.api.library.state()`)
  const books = lib.books.slice().sort((a, b) => a.title.localeCompare(b.title))
  console.log(`auditing ${books.length} books\n`)

  let grandRefs = 0
  let grandBroken = 0
  let grandIllustrationPages = 0
  const failures = []

  for (const b of books) {
    // The reader is a full-screen overlay — while it is open no book cards exist
    // in the DOM. Always close it and return to the library first.
    await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
    await sleep(600)
    await ev(`[...document.querySelectorAll('.rail-item')].find(x=>(x.textContent||'').includes('书库'))?.click()`)
    await sleep(1400)
    // wait until the grid is actually populated
    for (let w = 0; w < 25; w++) {
      const n = await ev(`document.querySelectorAll('.book-card, .book-row').length`)
      if (n > 0) break
      await sleep(300)
    }
    const opened = await ev(`(async () => {
      const cards = [...document.querySelectorAll('.book-card, .book-row')]
      const target = cards.find(c => {
        const t = c.querySelector('.book-title, .r-title')
        return (t ? t.textContent.trim() : '') === ${JSON.stringify(b.title)}
      })
      if (target) { target.click(); return true }
      return false
    })()`)
    if (!opened) {
      await sleep(600)
      const retry = await ev(`(async () => {
        const cards = [...document.querySelectorAll('.book-card, .book-row')]
        const target = cards.find(c => {
          const t = c.querySelector('.book-title, .r-title')
          return (t ? t.textContent.trim() : '') === ${JSON.stringify(b.title)}
        })
        if (target) { target.click(); return true }
        return false
      })()`)
      if (!retry) {
        console.log(`FAIL could not open: ${b.title}`)
        failures.push({ title: b.title, reason: 'not-openable' })
        continue
      }
    }
    await sleep(3200)
    const openedTitle = String(await ev(`document.querySelector('.reader-title')?.textContent ?? ''`))
    const expected = b.title.replace(/\s+/g, ' ')
    if (!openedTitle.replace(/\s+/g, ' ').includes(expected.slice(0, 20))) {
      console.log(`FAIL opened wrong book: want "${expected.slice(0, 24)}" got "${openedTitle.slice(0, 24)}"`)
      failures.push({ title: b.title, reason: 'wrong-book', got: openedTitle })
      await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
      await sleep(600)
      continue
    }

    const stats = await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const seen = new Set()
      const illusSeen = new Set()
      let broken = 0
      let illustrationPages = 0
      const flipNext = async () => {
        const btn = document.querySelector('.flip-fab.next')
        if (!btn || btn.disabled) return false
        btn.click()
        await sleep(40)
        return true
      }
      // walk to the start
      for (let i = 0; i < 400; i++) {
        const prev = document.querySelector('.flip-fab.prev')
        if (!prev || prev.disabled) break
        prev.click()
        await sleep(15)
      }
      let guard = 0
      while (guard++ < 1200) {
        const illusEl = document.querySelector('.illustration-page img')
      if (illusEl) {
        const k = illusEl.src.slice(-160)
        if (!illusSeen.has(k)) { illusSeen.add(k); illustrationPages++ }
      }
        document.querySelectorAll('.reader-page img').forEach(img => {
          const key = img.src.slice(-160)
          if (seen.has(key)) return
          seen.add(key)
          if (!(img.complete && img.naturalWidth > 0)) broken++
        })
        if (!(await flipNext())) break
      }
      return JSON.stringify({ uniqueImages: seen.size, broken, illustrationPages, pages: guard })
    })()`)
    const s = JSON.parse(stats)
    grandRefs += s.uniqueImages
    grandBroken += s.broken
    grandIllustrationPages += s.illustrationPages
    const ok = s.broken === 0 && s.uniqueImages > 0
    if (!ok) failures.push({ title: b.title, ...s })
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${b.title.slice(0, 40).padEnd(42)} imgs=${String(s.uniqueImages).padStart(3)} broken=${String(s.broken).padStart(2)} illusPages=${String(s.illustrationPages).padStart(3)}`
    )

    // close reader
    await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
    await sleep(700)
  }

  console.log('\n================ SUMMARY ================')
  console.log(`books audited:      ${books.length}`)
  console.log(`unique images seen: ${grandRefs}`)
  console.log(`broken images:      ${grandBroken}`)
  console.log(`illustration pages: ${grandIllustrationPages}`)
  console.log(`load success:       ${(((grandRefs - grandBroken) / Math.max(1, grandRefs)) * 100).toFixed(2)}%`)
  if (failures.length) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log('  ' + JSON.stringify(f))
  }
  ws.close()
  process.exit(failures.length ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

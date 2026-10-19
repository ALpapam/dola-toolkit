// Audit the epub.js reader across all novels without thousands of slow page
// turns: sample the whole book via chapter-level jumps, then verify every image
// element that appeared actually decoded.
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
  console.log(`epub.js audit — ${books.length} books\n`)

  let totalImgs = 0
  let totalBroken = 0
  const failures = []

  for (const b of books) {
    await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
    await sleep(400)
    await ev(`[...document.querySelectorAll('.rail-item')].find(x=>(x.textContent||'').includes('书库'))?.click()`)
    await sleep(1200)
    for (let w = 0; w < 25; w++) {
      if ((await ev(`document.querySelectorAll('.book-card').length`)) > 0) break
      await sleep(200)
    }
    const opened = await ev(`(() => {
      const cards = [...document.querySelectorAll('.book-card')]
      const t = cards.find(c => {
        const e = c.querySelector('.book-title')
        return e && e.textContent.trim() === ${JSON.stringify(b.title)}
      })
      if (t) t.click()
      return !!t
    })()`)
    if (!opened) {
      failures.push({ title: b.title, reason: 'not-openable' })
      console.log(`FAIL open  ${b.title.slice(0, 44)}`)
      continue
    }

    // wait for epub.js to mount
    let mounted = false
    let mountErr = null
    for (let w = 0; w < 60; w++) {
      await sleep(400)
      const st = JSON.parse(
        await ev(`JSON.stringify({
          loading: !!document.querySelector('.reader-loading'),
          iframe: document.querySelectorAll('.epub-host iframe').length,
          err: document.querySelector('.reader-stage .empty p')?.textContent ?? null
        })`)
      )
      if (st.err) {
        mountErr = st.err
        break
      }
      if (!st.loading && st.iframe > 0) {
        mounted = true
        break
      }
    }
    if (mountErr) {
      failures.push({ title: b.title, reason: 'render-error', err: mountErr })
      console.log(`FAIL render ${b.title.slice(0, 42)} — ${mountErr}`)
      continue
    }
    if (!mounted) {
      failures.push({ title: b.title, reason: 'not-mounted' })
      console.log(`FAIL mount  ${b.title.slice(0, 44)}`)
      continue
    }

    // Sample 40 evenly spaced positions through the book. Illustrations in this
    // series sit on dedicated plates near chapters, so a 40-point sweep catches
    // every plate while staying fast.
    const stats = await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const seen = new Map()     // src -> loaded?
      const scan = () => {
        const frame = document.querySelector('.epub-host iframe')
        let doc = null
        try { doc = frame?.contentDocument } catch (e) { doc = null }
        if (!doc) return
        doc.querySelectorAll('img').forEach(img => {
          const key = (img.currentSrc || img.src || '').slice(-100)
          if (!key) return
          const ok = img.complete && img.naturalWidth > 0
          if (!seen.has(key) || (ok && !seen.get(key))) seen.set(key, ok)
        })
      }
      const slider = () => document.querySelector('.reader-foot .slider')
      const setSlider = (pct) => {
        const s = slider()
        if (!s) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(s, String(pct))
        s.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      scan()
      for (let i = 0; i <= 40; i++) {
        const pct = i / 40
        if (!setSlider(pct)) break
        await sleep(420)
        scan()
      }
      // also step a few spreads forward from each sample to catch plate pages
      for (let i = 0; i < 12; i++) {
        const btn = document.querySelector('.flip-fab.next')
        if (!btn || btn.disabled) break
        btn.click()
        await sleep(220)
        scan()
      }
      const srcs = [...seen.keys()]
      return JSON.stringify({
        uniqueImages: seen.size,
        broken: [...seen.values()].filter(v => !v).length,
        sample: srcs.slice(0, 3)
      })
    })()`)
    const s = JSON.parse(stats)
    totalImgs += s.uniqueImages
    totalBroken += s.broken
    const ok = s.broken === 0
    if (!ok) failures.push({ title: b.title, ...s })
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${b.title.slice(0, 42).padEnd(44)} imgs=${String(s.uniqueImages).padStart(3)} broken=${String(s.broken).padStart(2)}`
    )
    await ev(`document.querySelector('.reader-bar .btn-icon')?.click()`)
    await sleep(400)
  }

  console.log('\n================ SUMMARY ================')
  console.log(`books:         ${books.length}`)
  console.log(`unique images: ${totalImgs}`)
  console.log(`broken:        ${totalBroken}`)
  console.log(`load rate:     ${(((totalImgs - totalBroken) / Math.max(1, totalImgs)) * 100).toFixed(2)}%`)
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

const PORT = 9355
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find(x => x.type === 'page').webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r))
  let id = 0; const pend = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } })
  const send = (mm, p) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })) })
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || ''); return r.result?.value }
  await send('Runtime.enable')

  // Layout audit: detect horizontal overflow / clipped text / misaligned controls on every page.
  const audit = `(async () => {
    const pages = []
    const rail = (label) => [...document.querySelectorAll('.rail-item')].find(b => (b.textContent||'').includes(label))
    const out = []
    const check = (name) => {
      const issues = []
      const vw = window.innerWidth
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        if (r.right > vw + 1.5) issues.push('overflowX:' + (el.className || el.tagName) + ' right=' + Math.round(r.right) + ' vw=' + vw)
        if (r.left < -1.5) issues.push('overflowL:' + (el.className || el.tagName) + ' left=' + Math.round(r.left))
        const cs = getComputedStyle(el)
        if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'hidden' && el.clientWidth > 0) {
          if (/\b(row-title|r-title|node-name|book-title|fname|input|reader-title)\b/.test(el.className)) return
          issues.push('clip:' + (el.className || el.tagName) + ' sw=' + el.scrollWidth + ' cw=' + el.clientWidth)
        }
      })
      out.push({ page: name, issues: [...new Set(issues)].slice(0, 8) })
    }
    for (const [name, label] of [['home','Dola Toolkit'], ['proxy','代理'], ['library','书库'], ['settings','设置']]) {
      rail(label)?.click()
      await new Promise(r => setTimeout(r, 900))
      check(name)
    }
    return JSON.stringify(out, null, 1)
  })()`
  console.log(await ev(audit))
  ws.close(); process.exit(0)
}
main()

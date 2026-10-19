import type { Block } from './formats'

export interface PaginationOptions {
  /** rendered width of one page's content box, in CSS px */
  width: number
  /** rendered height of one page's content box, in CSS px */
  height: number
  fontSize: number
  lineHeight: number
  /** horizontal + vertical padding inside .page-inner */
  padX: number
  padY: number
  /** CSS font-family for the reading text; must match the rendered page */
  fontFamily?: string
}

export interface PageSlice {
  start: number
  end: number
  /** blocks that fit, possibly a fragment of a single oversized block */
  html: string
  /** true when this page holds a full-page illustration */
  image?: boolean
}

/**
 * Greedy, measurement-based pagination.
 *
 * Every block is measured in a hidden probe element that has the exact width and
 * typography of a real page, then accumulated until the next block would
 * overflow. A block taller than a full page is split by binary-searching the
 * longest text prefix that still fits, so no content is ever clipped.
 */
export function paginate(blocks: Block[], opts: PaginationOptions): PageSlice[] {
  const { width, height, fontSize, lineHeight, padX, padY, fontFamily } = opts
  const probe = document.createElement('div')
  // NOTE: do not reuse the `.page-inner` class — it declares `position:absolute;
  // inset:0`, which collapses the probe's layout box and makes every paragraph
  // measure far taller than it really is (≈5× too many pages).
  probe.className = 'page-probe'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.left = '-10000px'
  probe.style.top = '0'
  probe.style.boxSizing = 'border-box'
  probe.style.width = `${width}px`
  probe.style.height = 'auto'
  probe.style.overflow = 'visible'
  probe.style.padding = `${padY}px ${padX}px`
  probe.style.fontSize = `${fontSize}px`
  probe.style.lineHeight = String(lineHeight)
  // the probe must use the exact same face as the rendered page, otherwise the
  // page count silently drifts once a custom font is selected
  if (fontFamily) probe.style.fontFamily = fontFamily
  document.body.appendChild(probe)

  const measure = (html: string): number => {
    probe.innerHTML = html
    // scrollHeight includes the probe's own padding, which the caller subtracts
    // as `availHeight`; that keeps both sides on the same accounting.
    return probe.scrollHeight
  }

  /**
   * The probe carries the same vertical padding as a real page, so its
   * `scrollHeight` is already "padding + content". A page's usable height is the
   * full page height, NOT `height - 2*padY` — subtracting again dropped ~2 lines
   * per page and inflated the page count by roughly a third.
   */
  const availHeight = Math.max(80, height)
  const pages: PageSlice[] = []
  let cur: Block[] = []
  let curHtml = ''
  let curHeight = 0

  const flush = (): void => {
    if (!cur.length) return
    pages.push({
      start: pages.length,
      end: pages.length,
      html: curHtml
    })
    cur = []
    curHtml = ''
    curHeight = 0
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // A full-page illustration must not share a page with body text, but it
    // should not leave a blank facing page either. Flush what we have, then
    // start a fresh page that holds only the artwork.
    if (block.kind === 'image') {
      flush()
      pages.push({
        start: pages.length,
        end: pages.length,
        html: `<div class="reader-illustration">${block.html}</div>`,
        image: true
      })
      continue
    }

    const single = measure(block.html)
    const joined = curHtml + block.html
    const joinedHeight = cur.length ? measure(joined) : single

    if (joinedHeight <= availHeight) {
      cur.push(block)
      curHtml = joined
      curHeight = joinedHeight
      continue
    }

    // does not fit together with what we already have
    if (cur.length) flush()
    if (single <= availHeight) {
      cur.push(block)
      curHtml = block.html
      curHeight = single
      continue
    }

    // a single block is taller than a page → split its text by binary search
    const pieces = splitTallBlock(block, availHeight, measure)
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p]
      const h = measure(piece)
      if (p === pieces.length - 1) {
        cur.push({ html: piece, text: '' })
        curHtml = piece
        curHeight = h
      } else {
        pages.push({ start: pages.length, end: pages.length, html: piece })
      }
    }
  }
  flush()
  probe.remove()

  if (!pages.length) pages.push({ start: 0, end: 0, html: '<p class="muted">（空）</p>' })
  // index them after the fact (splitting happens during the loop)
  pages.forEach((p, idx) => {
    p.start = idx
    p.end = idx
  })
  return pages
}

/**
 * Split one oversized block into page-sized html fragments.
 * The block is flattened to its text and re-emitted as paragraphs, which keeps
 * reading sane for pathological inputs (one giant <p> or a huge heading).
 */
function splitTallBlock(block: Block, availHeight: number, measure: (html: string) => number): string[] {
  const isHeading = /^\s*<h[1-6]/i.test(block.html)
  const tag = isHeading ? 'h2' : 'p'
  // Preserve the author's paragraph breaks: a long <p> may contain soft line
  // breaks that are meaningful, and re-emitting the whole block as one <p>
  // loses them (and produces one enormous line of text).
  const rawTexts: string[] = block.text
    ? block.text.split(/\n+/).filter((s) => s.trim())
    : (block.html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) ?? []).map((p) => p.replace(/<[^>]+>/g, '').trim())
  const pieces = rawTexts.length ? rawTexts : [block.html.replace(/<[^>]+>/g, '')]

  const wrap = (t: string): string =>
    t
      .split(/\n+/)
      .filter((s) => s.trim())
      .map((s) => `<${tag}>${escapeForReuse(s)}</${tag}>`)
      .join('') || `<${tag}></${tag}>`

  const out: string[] = []
  // Greedily pack whole paragraphs first; only split a paragraph when it alone
  // is taller than a page. This keeps normal prose intact instead of slicing it
  // at arbitrary character offsets.
  let buf: string[] = []
  const flushBuf = (): void => {
    if (!buf.length) return
    out.push(wrap(buf.join('\n')))
    buf = []
  }
  const pushText = (t: string): void => {
    const merged = buf.length ? `${buf.join('\n')}\n${t}` : t
    if (measure(wrap(merged)) <= availHeight) {
      buf.push(t)
      return
    }
    flushBuf()
    if (measure(wrap(t)) <= availHeight) {
      buf.push(t)
      return
    }
    // the paragraph itself overflows → binary-search a fitting prefix
    let rest = t
    let guard = 0
    while (rest.length && guard++ < 200) {
      if (measure(wrap(rest)) <= availHeight) {
        out.push(wrap(rest))
        rest = ''
        break
      }
      let lo = 1
      let hi = rest.length
      let best = 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (measure(wrap(rest.slice(0, mid))) <= availHeight) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      let cut = best
      const tail = rest.slice(Math.max(0, best - 60), best)
      const m = /[。！？；，、.!?;,\s](?![\s\S]*[。！？；，、.!?;,\s])/.exec(tail)
      if (m) cut = Math.max(0, best - 60) + m.index + 1
      if (cut < 20) cut = best
      out.push(wrap(rest.slice(0, cut)))
      rest = rest.slice(cut)
    }
  }

  for (const t of pieces) pushText(t)
  flushBuf()
  if (!out.length) out.push(wrap(pieces.join('\n').slice(0, 400)))
  return out
}

function escapeForReuse(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

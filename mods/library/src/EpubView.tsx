import { useEffect, useRef, useState } from 'react'
import { Icon } from './host'
import { Spinner } from './host'
import { useApp } from './host'
import { epubFontCss } from './fonts'
import { attachGestureBridge } from './useDragFlip'
import {
  configureRendition,
  openEpubFromBase64,
  MIN_SPREAD_WIDTH,
  type EpubBook,
  type EpubRendition
} from './epubjs'

const OPEN_TIMEOUT_MS = 25_000
const DISPLAY_TIMEOUT_MS = 20_000

/**
 * epub.js has no internal timeouts. A malformed book can leave `book.ready` or
 * `rendition.display()` pending forever (e.g. an archive whose spine uses `.html`
 * items with `duokan-page-fitwindow`). Racing a timer guarantees the reader
 * always reaches a terminal state instead of spinning forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export interface EpubViewHandle {
  next(): void
  prev(): void
  goTo(pct: number): void
  setSpread(mode: 'none' | 'auto' | 'both'): void
}

/**
 * EPUB renderer built on epub.js — the engine Cloudreve's built-in reader uses.
 *
 * Why epub.js instead of parsing the archive ourselves: it owns the zip, rewrites
 * every resource reference (`replacements: 'base64'`), and injects the chapter
 * into a sandboxed iframe. That is what guarantees illustrations resolve even
 * when the book stores them as `Text/../Images/001.jpg`.
 */
export function EpubView({
  base64,
  spread,
  theme,
  fontSize,
  fontFamily,
  startLocation,
  onLocation,
  onReady,
  onError
}: {
  base64: string
  spread: 'none' | 'auto' | 'both'
  theme: 'light' | 'dark'
  fontSize: number
  /** selected reader font id; resolved to a CSS family + injected @font-face */
  fontFamily: string
  startLocation: string | null
  onLocation: (pct: number, cfi: string) => void
  onReady: (handle: EpubViewHandle) => void
  onError: (message: string) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<EpubBook | null>(null)
  const renditionRef = useRef<EpubRendition | null>(null)
  const [loading, setLoading] = useState(true)
  const [progressText, setProgressText] = useState('')
  const [locationsReady, setLocationsReady] = useState(false)
  const [scrolledFallback, setScrolledFallback] = useState(false)
  const recoveredRef = useRef(false)
  const locationRef = useRef<string | null>(startLocation)
  // refs so the content hook (registered once) always sees current typography
  const fontFamilyRef = useRef(fontFamily)
  const fontSizeRef = useRef(fontSize)
  fontFamilyRef.current = fontFamily
  fontSizeRef.current = fontSize

  /* ---- create the book + rendition ---- */
  useEffect(() => {
    let cancelled = false
    const host = hostRef.current

    if (!host) return
    setLoading(true)

    void (async () => {
      try {
        const book = await withTimeout(openEpubFromBase64(base64), OPEN_TIMEOUT_MS, '解析 EPUB 超时')

        if (cancelled) {
          book.destroy()
          return
        }
        bookRef.current = book

        const stageRect = stageRef?.current?.getBoundingClientRect()
        const box = host.getBoundingClientRect()
        const viewW = Math.max(320, Math.floor(box.width || stageRect?.width || 900))
        const viewH = Math.max(320, Math.floor(box.height || stageRect?.height || 700))

        const rendition = book.renderTo(host, {
          width: viewW,
          height: viewH,
          spread,
          flow: 'paginated',
          allowScriptedContent: false
        })
        renditionRef.current = rendition
        configureRendition(rendition, {
          width: Math.floor(box.width) || 600,
          height: Math.floor(box.height) || 800,
          spread,
          theme,
          fontSize
        })

        // Verify every image inside a rendered chapter actually decoded; surface
        // a warning instead of silently showing a broken plate.
        rendition.hooks.content.register((contents: unknown) => {
          const doc = (contents as { document?: Document }).document
          if (!doc) return

          // epub.js renders each chapter in its own document: inject the selected
          // reader font (and its @font-face rules) so EPUB matches prose pages.
          try {
            const store = useApp.getState()
            const css = epubFontCss(fontFamilyRef.current, store.fonts, fontSizeRef.current)
            const styleId = 'dola-epub-font'
            let el = doc.getElementById(styleId) as HTMLStyleElement | null
            if (!el) {
              el = doc.createElement('style')
              el.id = styleId
              ;(doc.head ?? doc.documentElement).appendChild(el)
            }
            if (el.textContent !== css) el.textContent = css
          } catch {
            /* typography is cosmetic */
          }

          // Forward drag gestures out of the chapter so the reader can turn
          // pages by dragging the bottom corners of the sheet.
          //
          // Neither `eval` nor an injected inline <script> works here: the app
          // CSP forbids unsafe-eval and the chapter is a separate document.
          // Attaching a listener from the parent realm is a plain DOM operation
          // though, and it fires for events dispatched inside the iframe — so
          // the bridge is just a pair of cross-document listeners.
          try {
            attachGestureBridge(doc)
          } catch {
            /* gesture support is best effort */
          }

          const imgs = Array.from(doc.querySelectorAll('img'))
          let broken = 0
          for (const img of imgs) {
            if (!img.complete || img.naturalWidth === 0) {
              img.addEventListener('load', () => undefined, { once: true })
              img.addEventListener(
                'error',
                () => {
                  broken++
                  img.setAttribute('data-dola-broken', '1')
                },
                { once: true }
              )
            }
          }
          if (broken > 0) console.warn(`[reader] ${broken} illustration(s) failed to load`)
        })

        rendition.on('relocated', (location: unknown) => {
          const loc = location as {
            start?: { cfi?: string; percentage?: number; displayed?: { page?: number; total?: number } }
          }
          const cfi = loc?.start?.cfi ?? null
          const pct = typeof loc?.start?.percentage === 'number' ? loc.start.percentage : 0
          const page = loc?.start?.displayed?.page
          const total = loc?.start?.displayed?.total
          if (cfi) locationRef.current = cfi
          setProgressText(page && total ? `${page} / ${total}` : '')
          onLocation(pct, cfi ?? '')
        })

        // `display(undefined)` resolves "current location" before the spine is
        // ready and throws "No Section Found". Resolve an explicit target: the
        // saved CFI when it looks valid, otherwise the first spine item.
        const first = book.spine.get(0)
        const target = startLocation && startLocation.includes('epubcfi') ? startLocation : first?.href
        if (!target) throw new Error('这本 EPUB 没有可显示的内容')
        await withTimeout(rendition.display(target), DISPLAY_TIMEOUT_MS, '渲染章节超时')
        if (cancelled) return
        setLoading(false)

        // Percentage navigation (the footer slider) needs a location index.
        // Without this, `cfiFromPercentage()` always returns the first CFI and
        // the slider silently jumps nowhere. Generate it in the background so
        // opening a book stays fast.
        void book.locations
          .generate(1024)
          .then(() => {
            if (!cancelled) setLocationsReady(true)
          })
          .catch(() => undefined)

        onReady({
          next: () => void rendition.next(),
          prev: () => void rendition.prev(),
          goTo: (pct: number) => {
            const clamped = Math.min(1, Math.max(0, pct))
            if (book.locations.length() > 0) {
              const cfi = book.locations.cfiFromPercentage(clamped)
              if (cfi) {
                void rendition.display(cfi)
                return
              }
            }
            // locations not generated yet → approximate by spine position
            const total = book.spine.length
            if (!total) return
            const idx = Math.min(total - 1, Math.max(0, Math.round(clamped * (total - 1))))
            const section = book.spine.get(idx)
            if (section?.href) void rendition.display(section.href)
          },
          setSpread: (mode) => {
            rendition.spread(mode, MIN_SPREAD_WIDTH)
            const r = hostRef.current?.getBoundingClientRect()
            if (r) rendition.resize(Math.floor(r.width), Math.floor(r.height))
          }
        })
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)

        // A book whose spine epub.js cannot paginate (some Kindle/duokan
        // conversions) should still be readable. Retry once in scrolled flow,
        // which skips the paginator that is hanging.
        if (!recoveredRef.current && /超时/.test(msg) && bookRef.current) {
          recoveredRef.current = true
          try {
            const book = bookRef.current
            const box = host.getBoundingClientRect()
            const fallback = book.renderTo(host, {
              width: Math.floor(box.width) || 600,
              height: Math.floor(box.height) || 800,
              flow: 'scrolled-doc',
              allowScriptedContent: false
            })
            renditionRef.current = fallback
            configureRendition(fallback, {
              width: Math.floor(box.width) || 600,
              height: Math.floor(box.height) || 800,
              spread: 'none',
              theme,
              fontSize
            })
            const first = book.spine.get(0)
            await fallback.display(first?.href)
            if (cancelled) return
            setLoading(false)
            setScrolledFallback(true)
            onReady({
              next: () => undefined,
              prev: () => undefined,
              goTo: (pct: number) => {
                const total = book.spine.length
                if (!total) return
                const idx = Math.min(total - 1, Math.max(0, Math.round(pct * (total - 1))))
                const s = book.spine.get(idx)
                if (s?.href) void fallback.display(s.href)
              },
              setSpread: () => undefined
            })
            return
          } catch {
            /* fall through to the error state */
          }
        }
        setLoading(false)
        onError(msg)
      }
    })()

    return () => {
      cancelled = true
      try {
        renditionRef.current?.destroy()
      } catch {
        /* ignore */
      }
      try {
        bookRef.current?.destroy()
      } catch {
        /* ignore */
      }
      renditionRef.current = null
      bookRef.current = null
    }
    // Re-create only when the book itself changes; width/theme are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base64])

  /* ---- react to layout / theme changes without re-parsing the book ---- */
  useEffect(() => {
    const host = hostRef.current
    const rendition = renditionRef.current
    if (!host || !rendition) return
    renditionRef.current?.spread(spread, 820)
    renditionRef.current?.layout({ spread })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spread])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.themes.select(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.themes.fontSize(`${fontSize}px`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  /* keep epub.js sized to the container */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect()
      if (r.width < 50 || r.height < 50) return
      try {
        renditionRef.current?.resize(Math.floor(r.width), Math.floor(r.height))
      } catch {
        /* ignore */
      }
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="epub-host-wrap">
      <div ref={hostRef} className="epub-host" />
      {loading ? (
        <div className="reader-loading">
          <Spinner size={28} />
          <span>正在解析 EPUB…</span>
        </div>
      ) : null}
      {progressText ? <span className="epub-progress">{progressText}</span> : null}
    </div>
  )
}

export function EpubUnavailable({ message }: { message: string }): JSX.Element {
  return (
    <div className="empty">
      <span className="empty-glyph">
        <Icon name="error" size={48} />
      </span>
      <h3>无法打开这本 EPUB</h3>
      <p>{message}</p>
    </div>
  )
}

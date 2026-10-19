import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord, LibrarySettings } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon } from '../../ui/Icon'
import { IconButton, Slider, Spinner } from '../../ui/controls'
import { toast } from '../../ui/toast'
import { useHotkey } from '../../ui/hooks'
import { buildSource, type RenderSource } from './formats'
import { EpubView, type EpubViewHandle } from './EpubView'
import { paginate, type PageSlice } from './paginate'
import { useLibrary } from './store'

/* ------------------------------------------------------------------ */
/* PDF.js is loaded lazily so txt/epub readers never pay for it        */
/* ------------------------------------------------------------------ */
interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number }
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
async function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })()
  }
  return pdfjsPromise
}

async function loadPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const pdfjs = await getPdfjs()
  const task = pdfjs.getDocument({ data: bytes, cMapPacked: true })
  return (await task.promise) as unknown as PdfDoc
}

const FONT_SIZE = 17
const LINE_HEIGHT = 1.9
const PAD_X = 30
const PAD_Y = 34

export function Reader({ book, onClose }: { book: BookRecord; onClose: () => void }): JSX.Element {
  const settings = useApp((s) => s.settings)
  const lib = settings?.library
  const [source, setSource] = useState<RenderSource | null>(null)
  const [prosePages, setProsePages] = useState<PageSlice[]>([])
  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [spread, setSpread] = useState(1)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [turnDir, setTurnDir] = useState<'next' | 'prev'>('next')
  const [epubHandle, setEpubHandle] = useState<EpubViewHandle | null>(null)
  const [epubPct, setEpubPct] = useState(0)
  const epubCfi = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef(book)
  bookRef.current = book

  const spreadMode = lib?.spreadMode ?? 'auto'
  const themeMode = settings?.appearance.themeMode ?? 'system'
  const resolvedTheme: 'light' | 'dark' =
    themeMode === 'dark'
      ? 'dark'
      : themeMode === 'light'
        ? 'light'
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
  const flipMode = lib?.flipMode ?? 'both'

  /* page geometry is derived from the stage, not window.innerHeight, so the
     chrome (rail, title bar, header) never skews the aspect ratio test */
  const [geo, setGeo] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const w = Math.floor(r.width)
      const h = Math.floor(r.height)
      setGeo((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    // ResizeObserver can miss layout flushes caused by the OS/DPI or by a
    // maximize, so window resize is kept as a cheap, idempotent fallback.
    window.addEventListener('resize', measure)
    window.addEventListener('maximize', measure)
    window.addEventListener('unmaximize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('maximize', measure)
      window.removeEventListener('unmaximize', measure)
    }
  }, [])

  const twoUp = useMemo(() => {
    if (spreadMode === 'always') return true
    if (spreadMode === 'never') return false
    // "宽比例显示两页，窄比例显示一页": decide from the *stage* aspect ratio,
    // which already excludes the rail, title bar and reader chrome.
    if (geo.w < 40 || geo.h < 40) return false
    const ratio = geo.w / geo.h
    const wideEnough = ratio >= 1.15 && geo.w / 2 >= 330
    return wideEnough
  }, [spreadMode, geo.w, geo.h])

  /* ---------------- load content ---------------- */
  useEffect(() => {
    let cancelled = false
    setSource(null)
    setError(null)
    setProsePages([])
    setPdf(null)
    void (async () => {
      try {
        const content = await window.api.library.content(book.id)
        const src = await buildSource(content, book)
        if (cancelled) return
        setSource(src)
        if (src.kind === 'pdf' && src.bytes) {
          const doc = await loadPdf(src.bytes)
          if (cancelled) return
          setPdf(doc)
          const start = Number(book.lastLocation ?? 1) || 1
          setPdfPage(Math.min(Math.max(1, start), doc.numPages))
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [book.id])

  /* ---------------- page geometry ---------------- */
  // One page is always 2:3. The height that fits the stage caps the width, and
  // two pages plus the gutter must fit the stage *content* box — so the reader
  // shrinks the paper instead of overflowing it.
  const pageBox = useMemo(() => {
    const STAGE_PAD_X = 48 // .reader-stage horizontal padding (24px each side)
    const STAGE_PAD_Y = 38 // .reader-stage vertical padding (20 + 18)
    const GUTTER = 8
    const stageW = Math.max(120, geo.w - STAGE_PAD_X - (twoUp ? GUTTER : 0))
    const stageH = Math.max(120, geo.h - STAGE_PAD_Y)
    let h = stageH
    let w = (h * 2) / 3
    const maxW = twoUp ? Math.floor(stageW / 2) : stageW
    if (w > maxW) {
      w = maxW
      h = (w * 3) / 2
    }
    if (w > 760) {
      w = 760
      h = (w * 3) / 2
    }
    return { w: Math.floor(w), h: Math.floor(h) }
  }, [geo.w, geo.h, twoUp])

  /* ---------------- paginate prose ---------------- */
  useLayoutEffect(() => {
    if (!source || source.kind !== 'blocks') return
    if (pageBox.w < 100 || pageBox.h < 120) return
    const pages = paginate(source.blocks, {
      width: pageBox.w,
      height: pageBox.h,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      padX: PAD_X,
      padY: PAD_Y
    })
    setProsePages(pages)
    const saved = Number(bookRef.current.lastLocation ?? 0) || 0
    const aligned = twoUp ? saved - (saved % 2) : saved
    setIndex(Math.min(Math.max(0, aligned), Math.max(0, pages.length - 1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pageBox.w, pageBox.h, twoUp, book.id])

  const isEpub = source?.kind === 'epub'
  const totalPages = isEpub ? 0 : source?.kind === 'pdf' ? (pdf?.numPages ?? 0) : prosePages.length
  const step = twoUp && source?.kind !== 'pdf' ? 2 : 1
  const maxIndex = source?.kind === 'pdf' ? Math.max(0, totalPages - 1) : Math.max(0, totalPages - step)
  const logical = source?.kind === 'pdf' ? pdfPage - 1 : index
  const progress = totalPages > 0 ? Math.min(1, (logical + 1) / totalPages) : 0

  /* ---------------- progress persistence ---------------- */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persist = useCallback(
    (page: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        setSaving(true)
        const payload: Partial<BookRecord> =
          source?.kind === 'pdf'
            ? { lastLocation: String(page + 1), progress: (page + 1) / Math.max(1, totalPages) }
            : { lastLocation: String(page), progress: (page + 1) / Math.max(1, totalPages) }
        void window.api.library
          .updateBook(bookRef.current.id, payload)
          .catch(() => undefined)
          .finally(() => setSaving(false))
      }, 400)
    },
    [source?.kind, totalPages]
  )

  const goNext = useCallback(() => {
    setTurnDir('next')
    if (isEpub) {
      epubHandle?.next()
      return
    }
    if (source?.kind === 'pdf') {
      setPdfPage((p) => {
        const next = Math.min(totalPages, p + 1)
        persist(next - 1)
        return next
      })
      return
    }
    setIndex((i) => {
      const next = Math.min(maxIndex, i + step)
      persist(next)
      return next
    })
  }, [source?.kind, maxIndex, step, totalPages, persist, isEpub, epubHandle])

  const goPrev = useCallback(() => {
    setTurnDir('prev')
    if (isEpub) {
      epubHandle?.prev()
      return
    }
    if (source?.kind === 'pdf') {
      setPdfPage((p) => {
        const next = Math.max(1, p - 1)
        persist(next - 1)
        return next
      })
      return
    }
    setIndex((i) => {
      const next = Math.max(0, i - step)
      persist(next)
      return next
    })
  }, [source?.kind, step, persist, isEpub, epubHandle])

  const jumpTo = (page: number): void => {
    setTurnDir('next')
    if (source?.kind === 'pdf') {
      const p = Math.max(1, Math.min(totalPages, page + 1))
      setPdfPage(p)
      persist(p - 1)
    } else {
      const i = Math.max(0, Math.min(maxIndex, twoUp ? page - (page % 2) : page))
      setIndex(i)
      persist(i)
    }
  }

  useHotkey('arrowright', goNext)
  useHotkey('arrowleft', goPrev)
  useHotkey('escape', onClose)
  useHotkey(' ', goNext)

  /* wheel flips */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let lock = false
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 20) return
      e.preventDefault()
      if (lock) return
      lock = true
      if (e.deltaY > 0) goNext()
      else goPrev()
      setTimeout(() => {
        lock = false
      }, 320)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [goNext, goPrev])

  /* the spec: hold/click the BOTTOM quarter of the page, left = prev, right = next */
  const onStageClick = (e: React.MouseEvent): void => {
    if (flipMode === 'button') return
    const stage = stageRef.current
    if (!stage) return
    const r = stage.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (y < r.height * 0.75) return
    if (x < r.width * 0.25) goPrev()
    else if (x > r.width * 0.75) goNext()
  }

  const leftSlice = prosePages[index]
  const rightSlice = twoUp ? prosePages[index + 1] : undefined

  const toggleSpread = async (): Promise<void> => {
    if (!settings) return
    const next: LibrarySettings['spreadMode'] = twoUp ? 'never' : 'always'
    const patched = await window.api.settings.patch({ library: { spreadMode: next } })
    useApp.getState().setSettings(patched)
    toast.info(next === 'always' ? '已切换为双页' : '已切换为单页')
  }

  const flipZonesActive = flipMode !== 'button'

  return (
    <div className="reader">
      <div className="reader-bar">
        <IconButton icon="arrowBack" label="返回书库" onClick={onClose} />
        <div className="reader-title" title={book.title}>
          {book.title}
          {book.author ? (
            <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
              {' '}
              · {book.author}
            </span>
          ) : null}
        </div>
        {saving ? <Spinner size={13} /> : null}
        <IconButton
          icon={book.favorite ? 'star' : 'starOff'}
          label={book.favorite ? '取消收藏' : '收藏'}
          onClick={() => {
            void window.api.library.updateBook(book.id, { favorite: !book.favorite })
            toast.success(book.favorite ? '已取消收藏' : '已收藏')
          }}
        />
        <IconButton
          icon="dualScreen"
          label={twoUp ? '切换为单页' : '切换为双页'}
          active={twoUp}
          onClick={() => void toggleSpread()}
        />
        <IconButton
          icon="notes"
          label="阅读辅助"
          onClick={() => toast.info('在设置 → AI 助手中配置模型后可用')}
        />
      </div>

      <div
        className="reader-stage"
        ref={stageRef}
        onClick={onStageClick}
        style={{ cursor: flipZonesActive ? 'pointer' : 'default' }}
      >
        {error ? (
          <div className="empty">
            <span className="empty-glyph">
              <Icon name="error" size={48} />
            </span>
            <h3>无法打开这本书</h3>
            <p>{error}</p>
          </div>
        ) : !source ? (
          <div className="reader-loading">
            <Spinner size={28} />
            <span>正在排版…</span>
          </div>
        ) : source.kind === 'pdf' ? (
          <PdfStage doc={pdf} page={pdfPage} />
        ) : source.kind === 'epub' && source.epubBase64 ? (
          <EpubView
            base64={source.epubBase64}
            spread={twoUp ? 'auto' : 'none'}
            theme={resolvedTheme}
            fontSize={FONT_SIZE}
            startLocation={book.lastLocation}
            onLocation={(pct, cfi) => {
              setEpubPct(pct)
              if (cfi) epubCfi.current = cfi
              saveTimerRef.current && clearTimeout(saveTimerRef.current)
              saveTimerRef.current = setTimeout(() => {
                void window.api.library
                  .updateBook(bookRef.current.id, { lastLocation: cfi, progress: pct })
                  .catch(() => undefined)
              }, 600)
            }}
            onReady={setEpubHandle}
            onError={setError}
          />
        ) : (
          <div
            className="reader-spread"
            key={`${index}-${twoUp ? 'd' : 's'}`}
            style={{ ['--turn-dir' as string]: turnDir === 'next' ? '18px' : '-18px' }}
          >
            <div className={`reader-page ${twoUp ? 'left-page' : 'only'} page-turn ${leftSlice?.image ? 'illustration-page' : ''}`} style={{ width: pageBox.w, height: pageBox.h }}>
              <div className="page-inner" dangerouslySetInnerHTML={{ __html: leftSlice?.html ?? '' }} />
              <span className="page-num">{index + 1}</span>
            </div>
            {twoUp && rightSlice ? (
              <div className={`reader-page right-page page-turn ${rightSlice?.image ? 'illustration-page' : ''}`} style={{ width: pageBox.w, height: pageBox.h }}>
                <div className="page-inner" dangerouslySetInnerHTML={{ __html: rightSlice.html }} />
                <span className="page-num">{index + 2}</span>
              </div>
            ) : null}
          </div>
        )}

        {flipZonesActive ? (
          <>
            <div className="flip-zone left" aria-hidden />
            <div className="flip-zone right" aria-hidden />
          </>
        ) : null}

        {flipMode !== 'zone' ? (
          <>
            <button
              className="flip-fab prev"
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
              disabled={!isEpub && logical <= 0}
              title="上一页 (←)"
            >
              <Icon name="chevronUp" size={26} />
            </button>
            <button
              className="flip-fab next"
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
              disabled={!isEpub && logical >= Math.max(0, totalPages - 1)}
              title="下一页 (→)"
            >
              <Icon name="chevronDown" size={26} />
            </button>
          </>
        ) : null}
      </div>

      <div className="reader-foot">
        <IconButton icon="firstPage" small label="回封面" onClick={() => jumpTo(0)} />
        <IconButton icon="chevronLeft" small label="上一页" onClick={goPrev} disabled={!isEpub && logical <= 0} />
        {isEpub ? (
          <Slider
            value={epubPct}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => {
              setEpubPct(v)
              epubHandle?.goTo(v)
            }}
          />
        ) : (
          <Slider value={logical} min={0} max={Math.max(0, totalPages - 1)} onChange={(v) => jumpTo(v)} />
        )}
        <IconButton
          icon="chevronRight"
          small
          label="下一页"
          onClick={goNext}
          disabled={!isEpub && logical >= Math.max(0, totalPages - 1)}
        />
        <span className="pgnum">
          {isEpub
            ? `${Math.round(epubPct * 100)}%`
            : `${totalPages ? `${Math.min(logical + 1, totalPages)} / ${totalPages}` : '—'} · ${Math.round(progress * 100)}%`}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* PDF stage                                                           */
/* ------------------------------------------------------------------ */
function PdfStage({ doc, page }: { doc: PdfDoc | null; page: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!doc || !canvasRef.current || box.w === 0 || box.h === 0) return
    let cancelled = false
    void (async () => {
      try {
        const p = await doc.getPage(page)
        if (cancelled) return
        const base = p.getViewport({ scale: 1 })
        const scale = Math.min(box.w / base.width, box.h / base.height) * 0.98
        const viewport = p.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        await p.render({ canvasContext: ctx, viewport }).promise
      } catch (e) {
        console.error('pdf render failed', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page, box.w, box.h])

  return (
    <div ref={wrapRef} className="pdf-stage">
      {doc ? <canvas ref={canvasRef} className="pdf-canvas" /> : <Spinner size={26} />}
    </div>
  )
}

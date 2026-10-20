import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord, FlipAnimation, LibrarySettings } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon } from '../../ui/Icon'
import { IconButton, Slider, Spinner } from '../../ui/controls'
import { toast } from '../../ui/toast'
import { useHotkey } from '../../ui/hooks'
import { buildSource, type RenderSource } from './formats'
import { EpubView, type EpubViewHandle } from './EpubView'
import { paginate, type PageSlice } from './paginate'
import { useLibrary } from './store'
import { DEFAULT_READER_FONT_ID } from '@shared/fonts'
import {
  useDragFlip,
  useEpubGestureBridge,
  pageTurnStyle,
  TURN_DURATION,
  TURN_EASE_OUT,
  TURN_EASE_SPRING,
  SPRING_DURATION
} from './useDragFlip'

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

const PAD_X = 30
const PAD_Y = 34

export function Reader({ book, onClose }: { book: BookRecord; onClose: () => void }): JSX.Element {
  const settings = useApp((s) => s.settings)
  const lib = settings?.library
  const readerCfg = settings?.reader
  const FONT_SIZE = readerCfg?.fontSize ?? 17
  const LINE_HEIGHT = readerCfg?.lineHeight ?? 1.9
  const flipAnimation = readerCfg?.flipAnimation ?? 'cover'
  const fontId = readerCfg?.fontFamily ?? DEFAULT_READER_FONT_ID
  const readingFamily = useApp((s) => s.readingFamily)
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

  /* page geometry is derived from the stage, not window.innerHeight, so the
     chrome (rail, title bar, header) never skews the aspect ratio test */
  const [geo, setGeo] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let last = { w: 0, h: 0 }
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const w = Math.floor(r.width)
      const h = Math.floor(r.height)
      if (w === last.w && h === last.h) return
      last = { w, h }
      setGeo((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // the stage is sized by its ancestors; observing the reader root as well
    // catches window-level resizes that do not change the stage's own box
    const host = el.parentElement
    if (host) ro.observe(host)
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('maximize', measure)
    window.addEventListener('unmaximize', measure)
    // a maximized ↦ restored transition sometimes settles a frame late
    const t1 = window.setTimeout(measure, 120)
    const t2 = window.setTimeout(measure, 400)
    return () => {
      ro.disconnect()
      clearTimeout(t1)
      clearTimeout(t2)
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
  // Which book has had its saved position restored. Re-pagination must NOT
  // clobber the current page: a resize / font change / spread toggle re-runs
  // this effect, and restoring `lastLocation` there would teleport the reader
  // (and visibly undo a fresh page turn).
  const restoredForRef = useRef<string | null>(null)
  const indexRef = useRef(0)
  indexRef.current = index

  useLayoutEffect(() => {
    if (!source || source.kind !== 'blocks') return
    if (pageBox.w < 100 || pageBox.h < 120) return
    const pages = paginate(source.blocks, {
      width: pageBox.w,
      height: pageBox.h,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      padX: PAD_X,
      padY: PAD_Y,
      fontFamily: readingFamily
    })
    setProsePages(pages)
    const maxIndex = Math.max(0, pages.length - 1)

    if (restoredForRef.current !== book.id) {
      // first pagination for this book: honour the saved position
      restoredForRef.current = book.id
      const saved = Number(bookRef.current.lastLocation ?? 0) || 0
      const aligned = twoUp ? saved - (saved % 2) : saved
      setIndex(Math.min(Math.max(0, aligned), maxIndex))
      return
    }
    // already reading this book: keep the current position, just re-clamp it
    setIndex(Math.min(Math.max(0, indexRef.current), maxIndex))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pageBox.w, pageBox.h, twoUp, book.id, readingFamily, FONT_SIZE, LINE_HEIGHT])

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

  /**
   * Plays the page-turn animation for a CLICK / keyboard turn.
   *
   * Dragging animates from the finger's progress, but a button press or the
   * arrow keys have no gesture, so the sheet has to be driven from rest to the
   * end of the turn before the content is swapped. Without this, clicking `<`
   * or `>` snapped instantly (the user asked for the animation here too).
   */
  const animateClickTurn = useCallback((dir: 'next' | 'prev'): Promise<void> => {
    const mode = flipModeRef.current
    if (mode === 'none') return Promise.resolve()

    // EPUB has no per-page element: its turn is played on a dedicated overlay
    // that covers only the right half of the view and hinges on the gutter.
    const epubSheet = epubSheetRef.current
    if (epubSheet) {
      const host = epubSheet.parentElement
      const w = host ? host.getBoundingClientRect().width / 2 : pageBoxRef.current.w
      const duration = TURN_DURATION
      const start = performance.now()
      epubSheet.classList.add('is-turning')
      epubSheet.dataset.dir = dir
      return new Promise<void>((resolve) => {
        const step = (now: number): void => {
          const t = Math.min(1, (now - start) / duration)
          const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
          const style = pageTurnStyle(
            { progress: eased, dir, dragging: false, mode, hinge: 'left' },
            w
          )
          epubSheet.style.transform = style.transform ?? ''
          epubSheet.style.transformOrigin = (style.transformOrigin as string) ?? ''
          epubSheet.style.boxShadow = (style.boxShadow as string) ?? ''
          const shade = style['--turn-shade']
          if (shade !== undefined) epubSheet.style.setProperty('--turn-shade', String(shade))
          const curl = style['--turn-curl']
          if (curl !== undefined) epubSheet.style.setProperty('--turn-curl', String(curl))
          const lift = style['--turn-lift']
          if (lift !== undefined) epubSheet.style.setProperty('--turn-lift', String(lift))
          if (t < 1) requestAnimationFrame(step)
          else {
            epubSheet.classList.remove('is-turning')
            epubSheet.style.transform = ''
            epubSheet.style.boxShadow = ''
            epubSheet.style.setProperty('--turn-shade', '0')
            resolve()
          }
        }
        requestAnimationFrame(step)
      })
    }

    const w = pageBoxRef.current.w
    const el = turnableRef.current
    if (!el) return Promise.resolve()

    const duration = TURN_DURATION
    const start = performance.now()
    el.style.transition = 'none'
    return new Promise<void>((resolve) => {
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / duration)
        // easeInOutCubic: starts gently, accelerates through the fold, lands soft
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        const style = pageTurnStyle(
          { progress: eased, dir, dragging: false, mode, hinge: hingeRef.current },
          w
        )
        el.style.transform = style.transform ?? ''
        el.style.transformOrigin = (style.transformOrigin as string) ?? ''
        el.style.boxShadow = (style.boxShadow as string) ?? ''
        const shade = style['--turn-shade']
        if (shade !== undefined) el.style.setProperty('--turn-shade', String(shade))
        const flip = style['--turn-flip']
        if (flip !== undefined) el.style.setProperty('--turn-flip', String(flip))
        const curl = style['--turn-curl']
        if (curl !== undefined) el.style.setProperty('--turn-curl', String(curl))
        const lift = style['--turn-lift']
        if (lift !== undefined) el.style.setProperty('--turn-lift', String(lift))
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }, [])

  const goNext = useCallback(() => {
    setTurnDir('next')
    if (isEpub) {
      void animateClickTurn('next').then(() => epubHandle?.next())
      return
    }
    if (source?.kind === 'pdf') {
      void animateClickTurn('next').then(() =>
        setPdfPage((p) => {
          const next = Math.min(totalPages, p + 1)
          persist(next - 1)
          return next
        })
      )
      return
    }
    void animateClickTurn('next').then(() =>
      setIndex((i) => {
        const next = Math.min(maxIndex, i + step)
        persist(next)
        return next
      })
    )
  }, [source?.kind, maxIndex, step, totalPages, persist, isEpub, epubHandle, animateClickTurn])

  const goPrev = useCallback(() => {
    setTurnDir('prev')
    if (isEpub) {
      void animateClickTurn('prev').then(() => epubHandle?.prev())
      return
    }
    if (source?.kind === 'pdf') {
      void animateClickTurn('prev').then(() =>
        setPdfPage((p) => {
          const next = Math.max(1, p - 1)
          persist(next - 1)
          return next
        })
      )
      return
    }
    void animateClickTurn('prev').then(() =>
      setIndex((i) => {
        const next = Math.max(0, i - step)
        persist(next)
        return next
      })
    )
  }, [source?.kind, step, persist, isEpub, epubHandle, animateClickTurn])

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

  /* wheel flips — debounced hard so a trackpad's inertial scroll cannot rattle
     through several spreads at once. `lockUntil` ignores the whole momentum
     tail instead of re-arming every 320ms. */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let lockUntil = 0
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 12) return
      e.preventDefault()
      const now = performance.now()
      if (now < lockUntil) return
      lockUntil = now + 520
      if (e.deltaY > 0) goNext()
      else goPrev()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [goNext, goPrev])

  /* Clicking the page no longer turns it: page turning is drag-only (bottom-left
     / bottom-right drag on the sheet) plus the < > buttons and keyboard. */

  const leftSlice = prosePages[index]
  const rightSlice = twoUp ? prosePages[index + 1] : undefined

  /* ---------------- drag-to-turn ---------------- */
  // Grab the bottom-left / bottom-right corner of the sheet and pull: the page
  // follows the pointer, then commits or springs back (Tencent Reading style).
  const dragEnabled = (readerCfg?.dragFlip ?? true) && flipAnimation !== 'none'
  const [drag, setDrag] = useState<{ progress: number; dir: 'next' | 'prev'; engaged: boolean }>({
    progress: 0,
    dir: 'next',
    engaged: false
  })
  const [settling, setSettling] = useState(false)
  /** true while a committed turn animation is in flight */
  const turning = useRef(false)
  /** at most one turn queued behind the in-flight one */
  const pendingTurn = useRef<'next' | 'prev' | null>(null)

  // latest geometry/mode for the imperative painter (avoids stale closures)
  const pageBoxRef = useRef({ w: pageBox.w })
  const flipModeRef = useRef(flipAnimation)
  pageBoxRef.current = { w: pageBox.w }
  flipModeRef.current = flipAnimation

  // Live gesture visual is written straight to the DOM (transform on the
  // turnable page). Routing it through React state would re-render the whole
  // reader on every pointer move — and any unrelated re-render (a settings
  // broadcast, a font load) would snap the page back mid-gesture.
  const turnableRef = useRef<HTMLDivElement | null>(null)
  /** the pseudo-sheet used for EPUB turns (see .epub-turn-sheet) */
  const epubSheetRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef({ progress: 0, dir: 'next' as 'next' | 'prev', engaged: false })
  // Which edge the turning sheet is hinged on. A right-hand page (the sheet
  // that sweeps in a spread) hinges on its LEFT edge — the centre gutter — so
  // the paper peels off the binding instead of sliding off the screen edge.
  const hingeRef = useRef<'left' | 'right'>('left')
  hingeRef.current = 'left'

  const paintTurn = useCallback(
    (progress: number, dir: 'next' | 'prev', engaged: boolean) => {
      const el = turnableRef.current
      if (!el) return
      const width = engaged ? el.getBoundingClientRect().width : pageBoxRef.current.w
      const style = pageTurnStyle({ progress, dir, dragging: engaged, mode: flipModeRef.current, hinge: hingeRef.current }, width)
      if (engaged) {
        // tracking the pointer: no interpolation lag
        el.style.transition = 'none'
      } else if (progress === 0) {
        // Spring back to rest after a cancelled gesture. The reflow in between
        // is required for the same reason as in completeTurn: the gesture left
        // `transition: none` applied, so without a flush the browser would
        // resolve the change in one batch and the sheet would snap back.
        el.style.transition = 'none'
        void el.offsetWidth
        el.style.transition = `transform ${SPRING_DURATION}ms ${TURN_EASE_SPRING}, box-shadow ${SPRING_DURATION}ms linear, opacity ${SPRING_DURATION}ms linear`
      }
      el.style.transform = style.transform ?? ''
      el.style.transformOrigin = (style.transformOrigin as string) ?? ''
      el.style.boxShadow = (style.boxShadow as string) ?? ''
      el.style.opacity = (style.opacity as string) ?? ''
      // the light sweep is driven by CSS variables so it interpolates too
      const shade = style['--turn-shade']
      if (shade !== undefined) el.style.setProperty('--turn-shade', String(shade))
      const flip = style['--turn-flip']
      if (flip !== undefined) el.style.setProperty('--turn-flip', String(flip))
      const curl = style['--turn-curl']
      if (curl !== undefined) el.style.setProperty('--turn-curl', String(curl))
      const lift = style['--turn-lift']
      if (lift !== undefined) el.style.setProperty('--turn-lift', String(lift))
    },
    []
  )

  /**
   * Runs the *completion* half of a page turn.
   *
   * This is driven by requestAnimationFrame rather than a CSS transition on
   * purpose. The drag pins `transition: none` on the element, and once that
   * style has been resolved the browser coalesces a later
   * "transition + new value" write into a single style change — the sheet jumps
   * straight to the end instead of animating (which is exactly the "animation
   * is too hard / never plays" symptom). Driving every frame ourselves gives a
   * guaranteed smooth curve and lets the transform, the cast shadow and the
   * light sweep advance together.
   */
  const completeTurn = useCallback(
    (dir: 'next' | 'prev', mode: FlipAnimation, from: number) => {
      const el = turnableRef.current
      if (!el || mode === 'none') return Promise.resolve()

      const w = pageBoxRef.current.w
      const duration = TURN_DURATION
      const start = performance.now()
      el.style.transition = 'none'

      const apply = (p: number): void => {
        const style = pageTurnStyle({ progress: p, dir, dragging: false, mode, hinge: hingeRef.current }, w)
        el.style.transform = style.transform ?? ''
        el.style.transformOrigin = (style.transformOrigin as string) ?? ''
        el.style.boxShadow = (style.boxShadow as string) ?? ''
        const shade = style['--turn-shade']
        if (shade !== undefined) el.style.setProperty('--turn-shade', String(shade))
        const flip = style['--turn-flip']
        if (flip !== undefined) el.style.setProperty('--turn-flip', String(flip))
        const curl = style['--turn-curl']
        if (curl !== undefined) el.style.setProperty('--turn-curl', String(curl))
        const lift = style['--turn-lift']
        if (lift !== undefined) el.style.setProperty('--turn-lift', String(lift))
      }

      return new Promise<void>((resolve) => {
        const step = (now: number): void => {
          const t = Math.min(1, (now - start) / duration)
          // easeOutQuint — a long, soft landing instead of a hard stop
          const eased = 1 - Math.pow(1 - t, 5)
          // continue from wherever the finger left the sheet
          apply(from + (1 - from) * eased)
          if (t < 1) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
    },
    []
  )

  /** Springs the sheet back to rest when the gesture was below the threshold. */
  const springBack = useCallback((dir: 'next' | 'prev', from: number) => {
    const el = turnableRef.current
    if (!el) return Promise.resolve()
    const w = pageBoxRef.current.w
    const duration = SPRING_DURATION
    const start = performance.now()
    el.style.transition = 'none'
    return new Promise<void>((resolve) => {
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / duration)
        // gentle overshoot so the paper settles instead of stopping dead
        const eased = 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2)
        const p = Math.max(0, from * (1 - eased))
        const style = pageTurnStyle({ progress: p, dir, dragging: false, mode: flipModeRef.current, hinge: hingeRef.current }, w)
        el.style.transform = style.transform ?? ''
        el.style.transformOrigin = (style.transformOrigin as string) ?? ''
        el.style.boxShadow = (style.boxShadow as string) ?? ''
        const shade = style['--turn-shade']
        if (shade !== undefined) el.style.setProperty('--turn-shade', String(shade))
        const flip = style['--turn-flip']
        if (flip !== undefined) el.style.setProperty('--turn-flip', String(flip))
        const curl = style['--turn-curl']
        if (curl !== undefined) el.style.setProperty('--turn-curl', String(curl))
        const lift = style['--turn-lift']
        if (lift !== undefined) el.style.setProperty('--turn-lift', String(lift))
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }, [])

  const { onPointerDown } = useDragFlip({
    enabled: dragEnabled,
    threshold: readerCfg?.dragThreshold ?? 26,
    stageRef,
    pageWidth: twoUp ? pageBox.w * 2 + 8 : pageBox.w,
    zone: 'corners',
    onNext: goNext,
    onPrev: goPrev,
    onProgress: (progress, dir, engaged) => {
      dragState.current = { progress, dir, engaged }
      if (!drag.engaged && engaged) setDrag({ progress, dir, engaged })
      paintTurn(progress, dir, engaged)
    },
    onRelease: (committed) => {
      const dir = dragState.current.dir
      const from = dragState.current.progress
      dragState.current = { progress: 0, dir, engaged: false }
      setSettling(true)
      if (committed) {
        // Queue at most ONE pending turn. The committed animation holds the
        // page for ~460ms; without this, a trackpad or a fast repeated flick
        // could stack several turns and appear to "fly through the book".
        if (turning.current) {
          pendingTurn.current = dir
          setSettling(false)
          return
        }
        turning.current = true
        // finish the rotation, THEN advance the content — otherwise the page
        // snaps back to rest and the turn is invisible
        void completeTurn(dir, flipModeRef.current, from).then(() => {
          if (dir === 'next') goNext()
          else goPrev()
          turning.current = false
          // drain the single queued turn, if any
          const queued = pendingTurn.current
          pendingTurn.current = null
          setSettling(false)
          setDrag({ progress: 0, dir: 'next', engaged: false })
          paintTurn(0, 'next', false)
          if (queued) {
            turning.current = true
            void completeTurn(queued, flipModeRef.current, 0).then(() => {
              if (queued === 'next') goNext()
              else goPrev()
              turning.current = false
              setDrag({ progress: 0, dir: 'next', engaged: false })
              paintTurn(0, 'next', false)
            })
          }
        })
      } else {
        // under the threshold: spring back
        void springBack(dir, from).then(() => {
          setSettling(false)
          setDrag({ progress: 0, dir: 'next', engaged: false })
          paintTurn(0, 'next', false)
        })
      }
    }
  })

  // EPUB renders inside an iframe, so the same gesture arrives through a
  // bridge instead of the stage's pointer events.
  useEpubGestureBridge({
    enabled: dragEnabled && isEpub,
    stageRef,
    threshold: readerCfg?.dragThreshold ?? 26,
    onNext: goNext,
    onPrev: goPrev,
    onProgress: (progress, dir, engaged) => {
      if (!drag.engaged && engaged) setDrag({ progress, dir, engaged })
    },
    onRelease: (committed, dir) => {
      setSettling(true)
      const sheet = epubSheetRef.current
      const mode = flipModeRef.current

      /* The EPUB turn is played on the overlay sheet, never on the host: the
         host is the whole book view, so rotating it swung the entire page (and
         its next page) outside the stage's clipped box. The sheet only covers
         the right half and hinges on the gutter, matching a real page. */
      const animateSheet = (from: number, to: number, duration: number): Promise<void> => {
        if (!sheet || mode === 'none') return Promise.resolve()
        const host = sheet.parentElement
        const w = host ? host.getBoundingClientRect().width / 2 : pageBoxRef.current.w
        const start = performance.now()
        sheet.classList.add('is-turning')
        sheet.dataset.dir = dir
        return new Promise((resolve) => {
          const step = (now: number): void => {
            const t = Math.min(1, (now - start) / duration)
            const eased = 1 - Math.pow(1 - t, 5)
            const p = from + (to - from) * eased
            const style = pageTurnStyle({ progress: p, dir, dragging: false, mode, hinge: 'left' }, w)
            sheet.style.transform = style.transform ?? ''
            sheet.style.transformOrigin = (style.transformOrigin as string) ?? ''
            sheet.style.boxShadow = (style.boxShadow as string) ?? ''
            const shade = style['--turn-shade']
            if (shade !== undefined) sheet.style.setProperty('--turn-shade', String(shade))
            const curl = style['--turn-curl']
            if (curl !== undefined) sheet.style.setProperty('--turn-curl', String(curl))
            const lift = style['--turn-lift']
            if (lift !== undefined) sheet.style.setProperty('--turn-lift', String(lift))
            if (t < 1) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        })
      }

      const resetSheet = (): void => {
        if (!sheet) return
        sheet.classList.remove('is-turning')
        sheet.style.transform = ''
        sheet.style.boxShadow = ''
        sheet.style.setProperty('--turn-shade', '0')
      }

      if (committed) {
        void animateSheet(0, 1, TURN_DURATION).then(() => {
          if (dir === 'next') goNext()
          else goPrev()
          setSettling(false)
          setDrag({ progress: 0, dir: 'next', engaged: false })
          resetSheet()
        })
      } else {
        void animateSheet(0.35, 0, 280).then(() => {
          setSettling(false)
          setDrag({ progress: 0, dir: 'next', engaged: false })
          resetSheet()
        })
      }
    }
  })

  const toggleSpread = async (): Promise<void> => {
    if (!settings) return
    const next: LibrarySettings['spreadMode'] = twoUp ? 'never' : 'always'
    const patched = await window.api.settings.patch({ library: { spreadMode: next } })
    useApp.getState().setSettings(patched)
    toast.info(next === 'always' ? '已切换为双页' : '已切换为单页')
  }

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
        className={`reader-stage ${drag.engaged && !settling ? 'is-dragging' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
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
          <div className="epub-turn-host">
            <EpubView
              base64={source.epubBase64}
              spread={twoUp ? 'auto' : 'none'}
              theme={resolvedTheme}
              fontSize={FONT_SIZE}
              fontFamily={fontId}
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
            {/*
              The sheet that physically turns in EPUB mode.

              epub.js renders each chapter into an iframe that fills the whole
              host, so there is no per-page element to hinge. Instead this
              overlay mirrors the right half of the current view and rotates
              around ITS left edge — the centre gutter — which is exactly how a
              right-hand page peels in a real book. Its inner shadow is sampled
              from nothing: it is a translucent sheet, so the live page stays
              visible underneath and the turn cannot push content outside the
              stage box.
            */}
            <div ref={epubSheetRef} className="epub-turn-sheet" aria-hidden />
          </div>
        ) : (
          <div
            className="reader-spread-wrap"
            style={{ ['--reading-font' as string]: readingFamily }}
          >
            {/* the page being revealed underneath: shows the *next* spread so the
                drag feels like lifting a real sheet (Tencent Reading / Fanqie) */}
            <div
              className="reader-spread under"
              style={{ width: twoUp ? pageBox.w * 2 + 8 : pageBox.w, height: pageBox.h }}
              aria-hidden
            >
              {drag.dir === 'prev' && index > 0 ? (
                <div className="reader-page-nested">
                  <div
                    className="page-inner"
                    style={{ fontFamily: 'var(--reading-font, var(--font-reading))' }}
                    dangerouslySetInnerHTML={{
                      __html: prosePages[Math.max(0, index - step)]?.html ?? ''
                    }}
                  />
                </div>
              ) : (
                <div className="reader-page-nested">
                  <div
                    className="page-inner"
                    style={{ fontFamily: 'var(--reading-font, var(--font-reading))' }}
                    dangerouslySetInnerHTML={{
                      __html: prosePages[Math.min(prosePages.length - 1, index + step)]?.html ?? ''
                    }}
                  />
                </div>
              )}
              <div className="under-page-brand">
                <Icon name="bookOpen" size={30} />
                <span>{book.title}</span>
              </div>
            </div>

            <div
              className={`reader-spread current ${drag.engaged ? 'is-dragging' : ''}`}
              style={{
                ['--turn-dir' as string]: turnDir === 'next' ? '18px' : '-18px',
                ['--reading-font' as string]: readingFamily
              }}
            >
              <div
                ref={twoUp ? undefined : turnableRef}
                className={`reader-page ${twoUp ? 'left-page' : 'only'} page-turn ${leftSlice?.image ? 'illustration-page' : ''} ${drag.engaged && twoUp ? 'is-static-half' : ''} ${twoUp ? '' : 'reader-page-turnable'}`}
                style={{ width: pageBox.w, height: pageBox.h }}
              >
                <div className="page-inner" dangerouslySetInnerHTML={{ __html: leftSlice?.html ?? '' }} />
                <span className="page-num">{index + 1}</span>
              </div>
              {twoUp && rightSlice ? (
                <div
                  ref={turnableRef}
                  className={`reader-page right-page page-turn ${rightSlice?.image ? 'illustration-page' : ''} reader-page-turnable`}
                  style={{ width: pageBox.w, height: pageBox.h }}
                >
                  <div className="page-inner" dangerouslySetInnerHTML={{ __html: rightSlice.html }} />
                  <span className="page-num">{index + 2}</span>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* page-turn buttons are always available: the two ways to turn a page
            are these buttons and dragging the sheet */}
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
              <Icon name="chevronLeft" size={26} />
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
              <Icon name="chevronRight" size={26} />
            </button>
        </>
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

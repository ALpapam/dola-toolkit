import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FlipAnimation } from '@shared/types'

/* ------------------------------------------------------------------ */
/* Drag-to-turn page interaction                                       */
/*                                                                     */
/* Tencent Reading / Fanqie behaviour:                                 */
/*   * grab the BOTTOM-LEFT or BOTTOM-RIGHT corner of the sheet        */
/*   * the page follows the pointer 1:1 while dragging                  */
/*   * past the commit threshold (or a fast flick) the turn completes    */
/*   * otherwise it springs back                                        */
/*                                                                     */
/* Works for every renderer: prose/PDF listen on the stage, and EPUB    */
/* additionally accepts gestures that started inside its own iframe     */
/* (see attachEpubGestureBridge).                                      */
/* ------------------------------------------------------------------ */

/** bottom strip of the sheet that behaves as a corner grab handle */
const BOTTOM_ZONE_H = 0.4

export type DragZone = 'corners' | 'anywhere'

interface DragState {
  active: boolean
  /** where the pointer went down, in stage coordinates */
  startX: number
  startY: number
  /** which way the gesture is currently pulling */
  dir: 'next' | 'prev'
  /** 0..1 completion of the gesture */
  progress: number
  /** page width used to normalise progress */
  pageWidth: number
  /** true once the pointer moved past the slop threshold */
  engaged: boolean
}

export interface DragFlipOptions {
  /** disable entirely (settings) */
  enabled: boolean
  /** commit threshold as % of page width */
  threshold: number
  /** the element the page lives in — used for coordinates and width */
  stageRef: React.RefObject<HTMLDivElement | null>
  /** page width in px (used to normalise progress) */
  pageWidth: number
  /** 'corners' (default) requires the press to start in a bottom corner */
  zone?: DragZone
  /** clickable element that sits above the paper (buttons); presses on it are ignored */
  ignoreRef?: React.RefObject<HTMLElement | null>
  onNext: () => void
  onPrev: () => void
  /** called on every move with 0..1 and direction, for the visual layer */
  onProgress: (progress: number, dir: 'next' | 'prev', engaged: boolean) => void
  onRelease: (committed: boolean, dir: 'next' | 'prev') => void
}

const SLOP_PX = 6
const FLICK_VELOCITY = 0.45 // px per ms

/** The sheet currently on screen, or the stage itself when there is none. */
export function resolvePaper(stage: HTMLElement): HTMLElement {
  return (
    (stage.querySelector('.reader-spread.current') as HTMLElement | null) ??
    (stage.querySelector('.epub-host') as HTMLElement | null) ??
    (stage.querySelector('.pdf-stage') as HTMLElement | null) ??
    (stage.querySelector('.reader-page') as HTMLElement | null) ??
    stage
  )
}

export function useDragFlip({
  enabled,
  threshold,
  stageRef,
  pageWidth,
  zone = 'corners',
  ignoreRef,
  onNext,
  onPrev,
  onProgress,
  onRelease
}: DragFlipOptions): {
  dragging: boolean
  onPointerDown: (e: React.PointerEvent) => void
} {
  const [dragging, setDragging] = useState(false)
  const state = useRef<DragState | null>(null)
  const raf = useRef<number | null>(null)
  const last = useRef({ x: 0, t: 0, v: 0 })
  // callbacks + live threshold; a ref keeps long-lived listeners from seeing
  // stale values when settings change mid-session
  const cbRef = useRef({ onNext, onPrev, onProgress, onRelease, threshold })
  cbRef.current = { onNext, onPrev, onProgress, onRelease, threshold }
  const zoneRef = useRef<DragZone>(zone)
  zoneRef.current = zone

  /**
   * Attach move/up listeners when a gesture starts and detach them when it ends.
   * Doing this per-gesture (instead of one long-lived effect) means the handlers
   * always close over the *current* threshold and callbacks — a stale effect
   * closure silently swallowed gestures when settings changed.
   */
  const detachRef = useRef<(() => void) | null>(null)

  const detach = useCallback(() => {
    if (detachRef.current) {
      detachRef.current()
      detachRef.current = null
    }
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
  }, [])

  const finish = useCallback(
    (committed: boolean) => {
      detach()
      const s = state.current
      state.current = null
      if (!s || !s.engaged) {
        setDragging(false)
        return
      }
      // The consumer owns the turn itself: it must be free to run the
      // completion animation *first* and only then advance the page. Calling
      // onNext/onPrev here as well would turn two pages per gesture.
      cbRef.current.onRelease(committed, s.dir)
      setDragging(false)
    },
    [detach]
  )

  const beginGesture = useCallback(
    (startX: number, startY: number, width: number, dir: 'next' | 'prev') => {
      detach()
      state.current = {
        active: true,
        startX,
        startY,
        dir,
        progress: 0,
        pageWidth: width,
        engaged: false
      }
      last.current = { x: startX, t: performance.now(), v: 0 }

      const onMove = (e: PointerEvent): void => {
        const s = state.current
        if (!s || !s.active) return
        const dx = e.clientX - s.startX
        const dy = e.clientY - s.startY

        if (!s.engaged) {
          if (Math.abs(dx) < SLOP_PX) return
          // a mostly-vertical gesture belongs to text selection
          if (Math.abs(dy) > Math.abs(dx) * 1.4) {
            detach()
            state.current = null
            setDragging(false)
            return
          }
          s.engaged = true
          setDragging(true)
        }

        const dirNow: 'next' | 'prev' = dx < 0 ? 'next' : 'prev'
        s.dir = dirNow
        s.progress = Math.min(1, Math.abs(dx) / Math.max(120, s.pageWidth))

        const now = performance.now()
        const dt = Math.max(1, now - last.current.t)
        last.current.v = (e.clientX - last.current.x) / dt
        last.current.x = e.clientX
        last.current.t = now

        if (raf.current === null) {
          raf.current = requestAnimationFrame(() => {
            raf.current = null
            const cur = state.current
            if (cur) cbRef.current.onProgress(cur.progress, cur.dir, cur.engaged)
          })
        }
      }

      const onUp = (): void => {
        const s = state.current
        if (!s || !s.active) return
        const committed = s.progress >= cbRef.current.threshold / 100
        const flicked =
          Math.abs(last.current.v) > FLICK_VELOCITY && Math.abs(last.current.x - s.startX) > 24
        finish(committed || flicked)
      }

      const onCancel = (): void => {
        if (state.current) finish(false)
      }

      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
      detachRef.current = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('blur', onCancel)
      }
    },
    [detach, finish]
  )

  /* tear down if the feature is disabled mid-gesture */
  useEffect(() => {
    if (enabled) return
    detach()
    state.current = null
    setDragging(false)
  }, [enabled, detach])

  useEffect(() => detach, [detach])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      const stage = stageRef.current
      if (!stage) return
      if (e.button !== 0) return

      // Measure against the *paper*, never the stage, and never from e.target:
      // the page is centred in a much wider stage and the flip buttons overlay
      // it, so event targets are unreliable. Resolve the sheet from the DOM.
      const paper = resolvePaper(stage)
      const rect = paper.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      // ignore points outside the paper (side gutters, below the page)
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return

      // Only the BOTTOM corners are grab handles, matching a real book:
      //   bottom-left  → previous page
      //   bottom-right → next page
      // `cornerDrag` amounts to half the width / bottom 40% of the height.
      const inZone = zoneRef.current
      if (inZone === 'corners') {
        const bottom = y >= rect.height * (1 - BOTTOM_ZONE_H)
        const right = x >= rect.width * 0.5
        const left = x <= rect.width * 0.5
        if (!bottom) return
        if (!right && !left) return
      }

      // Text selection wins over the gesture.
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return

      // Suppress the browser's drag-to-select while the sheet is being pulled:
      // otherwise the gesture both turns the page AND paints a text selection.
      e.preventDefault()
      window.getSelection()?.removeAllRanges()

      beginGesture(e.clientX, e.clientY, pageWidth, x >= rect.width * 0.5 ? 'next' : 'prev')
    },
    [enabled, stageRef, pageWidth, beginGesture]
  )

  return { dragging, onPointerDown }
}

/* ------------------------------------------------------------------ */
/* Animation mode helpers                                              */
/* ------------------------------------------------------------------ */

export interface TurnVisual {
  /** 0..1 progress of the gesture being dragged */
  progress: number
  dir: 'next' | 'prev'
  /** true while the pointer is held */
  dragging: boolean
  /** animation style from settings */
  mode: FlipAnimation
  /**
   * Which edge of the TURNING page is the spine (its hinge).
   * A right-hand page hinges on its left edge; a left-hand page on its right.
   * Defaults to 'left'.
   */
  hinge?: 'left' | 'right'
}

/**
 * Computes the CSS transform/style for the outgoing page.
 *
 * cover — the sheet arcs up and rotates around its spine while a soft light
 *         sweep travels across it. This is the "paper" feel: the previous
 *         implementation rotated a flat rectangle with a hard inset shadow,
 *         which read as stiff and mechanical.
 * slide — the page slides straight out, exposing the next one underneath.
 * curl  — the page slides while a shadow band sweeps across its inner edge.
 *
 * The eased value also drives `--turn-shade`, a gradient overlay declared in
 * CSS that tints the sheet as it lifts away from the light.
 */

/** Soft landing for a completed turn (no bounce — the sheet is leaving). */
export const TURN_EASE_OUT = 'cubic-bezier(.22,1,.36,1)'
/** Gentle overshoot for a cancelled gesture springing back to rest. */
export const TURN_EASE_SPRING = 'cubic-bezier(.34,1.4,.64,1)'
export const TURN_DURATION = 460
export const SPRING_DURATION = 520

/** CSSProperties plus the custom properties the turn animation writes. */
export type TurnStyle = React.CSSProperties & {
  '--turn-shade'?: string | number
  '--turn-flip'?: string | number
  '--turn-curl'?: string | number
  '--turn-lift'?: string | number
}

export function pageTurnStyle(visual: TurnVisual, pageWidth: number): TurnStyle {
  const { progress, dir, dragging, mode } = visual
  const sign = dir === 'next' ? -1 : 1
  // `progress` is the single source of truth: 0 is the resting page. While the
  // pointer is down there is no transition (the page tracks the finger); on
  // release the CSS transition animates either back to 0 (cancelled) or the
  // committed page is replaced, which also renders at progress 0.
  const eased = Math.max(0, Math.min(1, progress))

  if (mode === 'none' || eased === 0) {
    return {
      ['--turn-shade' as string]: '0',
      ['--turn-flip' as string]: String(sign),
      ['--turn-curl' as string]: '0',
      ['--turn-lift' as string]: '0'
    }
  }

  // a bell curve: 0 at both ends, 1 in the middle — used for the arc/lift so the
  // sheet rises as it leaves and settles back down instead of pivoting flat
  const arc = Math.sin(eased * Math.PI)

  if (mode === 'slide') {
    return {
      transform: `translate3d(${sign * eased * pageWidth}px, ${-arc * 6}px, 0) scale(${1 - arc * 0.015})`,
      opacity: '1',
      ['--turn-shade' as string]: String(eased * 0.8),
      ['--turn-flip' as string]: String(sign),
      ['--turn-curl' as string]: '0',
      ['--turn-lift' as string]: String(arc),
      boxShadow: `0 ${arc * 22}px ${arc * 44}px -${arc * 20}px rgba(0,0,0,.38)`,
      willChange: 'transform',
      transition: dragging ? 'none' : `transform ${TURN_DURATION}ms ${TURN_EASE_OUT}`
    }
  }

  if (mode === 'curl') {
    return {
      transform: `translate3d(${sign * eased * pageWidth * 0.9}px, ${-arc * 10}px, 0) rotate(${sign * eased * 1.6}deg) scale(${1 - arc * 0.02})`,
      opacity: '1',
      ['--turn-shade' as string]: String(eased * 1.1),
      ['--turn-flip' as string]: String(sign),
      ['--turn-curl' as string]: String(eased),
      ['--turn-lift' as string]: String(arc),
      boxShadow: `inset ${-sign * eased * 46}px 0 52px -24px rgba(0,0,0,.5)`,
      willChange: 'transform',
      transition: dragging ? 'none' : `transform ${TURN_DURATION}ms ${TURN_EASE_OUT}`
    }
  }

  /* ---------------------------------------------------------------
     cover = a real book being opened (the PTQBookPageView / iOS feel)

     The hinge is the page's INNER edge — the gutter — not the outer edge
     of the window. The sheet is always the page on the spine side:
       · forward: the right page peels from the gutter, sweeps left, and
         covers the left page, revealing the next two pages
       · backward: the left page peels from the gutter and sweeps right

     `origin` therefore depends on WHICH PAGE is turning, which the reader
     tells us via `hinge`. When the hinge is on the right (a right page),
     rotating +angle swings it leftwards over the other half.
     --------------------------------------------------------------- */
  const hinge = visual.hinge ?? 'left'
  const origin = hinge === 'left' ? 'left center' : 'right center'
  // a right-hand page opens towards the left (negative rotation), and the
  // left-hand page opens towards the right
  const openSign = hinge === 'left' ? -1 : 1
  const angle = eased * 178 // lands almost flat on the far side
  // perspective tightens as the sheet turns edge-on, which gives the arc depth
  const persp = 1500 + arc * 1000

  return {
    transform:
      `perspective(${Math.round(persp)}px) ` +
      `translate3d(0, ${-arc * 8}px, 0) ` +
      `rotateY(${openSign * angle}deg)`,
    transformOrigin: origin,
    // no scale: scaling would break the hinge illusion
    ['--turn-shade' as string]: String(eased),
    ['--turn-flip' as string]: String(sign),
    ['--turn-curl' as string]: String(eased),
    ['--turn-lift' as string]: String(arc),
    // the shadow is cast onto the page underneath, strongest near the spine
    boxShadow: `${openSign * -1 * arc * 30}px ${arc * 12}px ${arc * 52}px -${arc * 18}px rgba(0,0,0,.5)`,
    willChange: 'transform',
    transition: dragging ? 'none' : `transform ${TURN_DURATION}ms ${TURN_EASE_OUT}`
  }
}

/** Tracks viewport width for gesture math without re-rendering on every move. */
/* ------------------------------------------------------------------ */
/* EPUB gesture bridge                                                 */
/* ------------------------------------------------------------------ */

/**
 * epub.js renders every chapter in its own sandboxed iframe, so pointer events
 * inside the book never reach the app document where useDragFlip listens.
 *
 * This script is injected into each chapter document by EpubView. While the
 * pointer is inside the chapter it forwards normalised coordinates to the parent
 * (same-origin, so parent is reachable) through a CustomEvent that the reader
 * listens for. That is what makes drag-to-turn work for EPUB too.
 */
/**
 * Bridges pointer gestures out of an epub.js chapter document.
 *
 * The chapter is a separate, same-origin document, so the parent may attach
 * listeners to it directly. This avoids eval / inline scripts entirely, which
 * the app CSP blocks.
 */
const bridgedDocs = new WeakSet<Document>()

export function attachGestureBridge(doc: Document): void {
  if (!doc || bridgedDocs.has(doc)) return
  bridgedDocs.add(doc)

  let dragging = false
  let lastX = 0
  let lastT = 0
  let vel = 0

  const frameRect = (): DOMRect | null => {
    try {
      const el = doc.defaultView?.frameElement
      return el ? el.getBoundingClientRect() : null
    } catch {
      return null
    }
  }

  const send = (type: string, cx: number, cy: number): void => {
    const r = frameRect()
    const detail = {
      type,
      x: (r ? r.left : 0) + cx,
      y: (r ? r.top : 0) + cy,
      v: vel
    }
    try {
      window.dispatchEvent(new CustomEvent('dola-epub-gesture', { detail }))
    } catch {
      /* ignore */
    }
  }

  doc.addEventListener(
    'pointerdown',
    (e) => {
      const ev = e as PointerEvent
      if (ev.button !== 0) return
      dragging = true
      lastX = ev.clientX
      lastT = performance.now()
      vel = 0
      send('down', ev.clientX, ev.clientY)
    },
    true
  )

  doc.addEventListener(
    'pointermove',
    (e) => {
      if (!dragging) return
      const ev = e as PointerEvent
      const now = performance.now()
      vel = (ev.clientX - lastX) / Math.max(1, now - lastT)
      lastX = ev.clientX
      lastT = now
      send('move', ev.clientX, ev.clientY)
    },
    true
  )

  const end = (e: Event): void => {
    if (!dragging) return
    dragging = false
    const ev = e as PointerEvent
    send('up', ev.clientX ?? 0, ev.clientY ?? 0)
  }
  doc.addEventListener('pointerup', end, true)
  doc.addEventListener('pointercancel', end, true)

  /*
   * Tap forwarding.
   *
   * Page turns are triggered by tapping the left/right third of the sheet, but
   * the chapter lives in its own document, so the tap never reaches the reader's
   * stage. Forward the tap with its position converted into the top window's
   * coordinates; the reader works out which third it landed in.
   */
  doc.addEventListener(
    'click',
    (e) => {
      const ev = e as MouseEvent
      const r = frameRect()
      const detail = { x: (r ? r.left : 0) + ev.clientX, y: (r ? r.top : 0) + ev.clientY }
      try {
        window.dispatchEvent(new CustomEvent('dola-epub-click', { detail }))
      } catch {
        /* ignore */
      }
    },
    true
  )
}
/**
 * Subscribes to gestures forwarded by the EPUB chapter script and replays them
 * into the same drag state machine the stage uses.
 */
export function useEpubGestureBridge(opts: {
  enabled: boolean
  stageRef: React.RefObject<HTMLDivElement | null>
  threshold: number
  onNext: () => void
  onPrev: () => void
  onProgress: (progress: number, dir: 'next' | 'prev', engaged: boolean) => void
  onRelease: (committed: boolean, dir: 'next' | 'prev') => void
}): void {
  const cb = useRef(opts)
  cb.current = opts

  useEffect(() => {
    const onGesture = (ev: Event): void => {
      const { enabled, stageRef, threshold } = cb.current
      if (!enabled) return
      const stage = stageRef.current
      if (!stage) return
      const detail = (ev as CustomEvent<{ type: string; x: number; y: number; v: number }>).detail
      if (!detail) return

      const paper = resolvePaper(stage)
      const rect = paper.getBoundingClientRect()
      if (rect.width < 40) return

      if (detail.type === 'down') {
        const y = detail.y - rect.top
        // bottom corners only, same rule as the stage gesture
        if (y < rect.height * (1 - BOTTOM_ZONE_H)) return
        epubState.current = {
          active: true,
          startX: detail.x,
          startY: detail.y,
          dir: detail.x - rect.left >= rect.width / 2 ? 'next' : 'prev',
          progress: 0,
          pageWidth: rect.width,
          engaged: false
        }
        return
      }

      const s = epubState.current
      if (!s || !s.active) return

      if (detail.type === 'move') {
        const dx = detail.x - s.startX
        if (!s.engaged) {
          if (Math.abs(dx) < SLOP_PX) return
          s.engaged = true
        }
        s.dir = dx < 0 ? 'next' : 'prev'
        s.progress = Math.min(1, Math.abs(dx) / Math.max(120, rect.width))
        cb.current.onProgress(s.progress, s.dir, true)
        return
      }

      // up
      const committed = s.progress >= threshold / 100 || Math.abs(detail.v) > FLICK_VELOCITY
      const dir = s.dir
      epubState.current = null
      // the consumer runs the completion animation and then advances the page
      cb.current.onRelease(committed, dir)
    }

    window.addEventListener('dola-epub-gesture', onGesture as EventListener)
    return () => window.removeEventListener('dola-epub-gesture', onGesture as EventListener)
  }, [])
}

const epubState = { current: null as DragState | null }

export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [ref])
  return useMemo(() => width, [width])
}

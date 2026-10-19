import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FlipAnimation } from '@shared/types'

/* ------------------------------------------------------------------ */
/* Drag-to-turn page interaction                                       */
/*                                                                     */
/* Tencent Reading / Fanqie behaviour:                                */
/*   * grab the left or right quarter of the page and drag sideways    */
/*   * the page follows the pointer 1:1 while dragging                 */
/*   * past the commit threshold (or a fast flick) the turn completes   */
/*   * otherwise it springs back                                       */
/*                                                                     */
/* Only prose/PDF stages use this; EPUB is driven by epub.js's own     */
/* iframe, so it keeps the simple click/button path.                   */
/* ------------------------------------------------------------------ */

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
  onNext: () => void
  onPrev: () => void
  /** called on every move with 0..1 and direction, for the visual layer */
  onProgress: (progress: number, dir: 'next' | 'prev', engaged: boolean) => void
  onRelease: (committed: boolean, dir: 'next' | 'prev') => void
}

const SLOP_PX = 6
const FLICK_VELOCITY = 0.45 // px per ms

export function useDragFlip({
  enabled,
  threshold,
  stageRef,
  pageWidth,
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
  const cbRef = useRef({ onNext, onPrev, onProgress, onRelease })
  cbRef.current = { onNext, onPrev, onProgress, onRelease }

  const finish = useCallback((committed: boolean) => {
    const s = state.current
    if (!s || !s.engaged) {
      state.current = null
      setDragging(false)
      return
    }
    cbRef.current.onRelease(committed, s.dir)
    if (committed) {
      if (s.dir === 'next') cbRef.current.onNext()
      else cbRef.current.onPrev()
    }
    state.current = null
    setDragging(false)
  }, [])

  useEffect(() => {
    if (!enabled) return

    const onMove = (e: PointerEvent): void => {
      const s = state.current
      if (!s || !s.active) return
      const dx = e.clientX - s.startX
      const dy = e.clientY - s.startY

      if (!s.engaged) {
        if (Math.abs(dx) < SLOP_PX) return
        // a mostly-vertical gesture belongs to text selection/scrolling
        if (Math.abs(dy) > Math.abs(dx) * 1.4) {
          state.current = null
          setDragging(false)
          return
        }
        s.engaged = true
        setDragging(true)
      }

      const w = Math.max(120, s.pageWidth)
      // dragging left (dx<0) advances; dragging right rewinds
      const dir: 'next' | 'prev' = dx < 0 ? 'next' : 'prev'
      const progress = Math.min(1, Math.abs(dx) / w)

      // velocity for flick detection
      const now = performance.now()
      const dt = Math.max(1, now - last.current.t)
      last.current.v = (e.clientX - last.current.x) / dt
      last.current.x = e.clientX
      last.current.t = now

      if (dir !== s.dir) {
        // direction changed mid-gesture — restart from the other side
        s.dir = dir
      }
      s.progress = progress

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
      const committed = s.progress >= threshold / 100
      // also commit on a fast flick toward either side
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
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (raf.current !== null) cancelAnimationFrame(raf.current)
      raf.current = null
    }
  }, [enabled, threshold, finish])

  /* cleanup when disabled mid-gesture */
  useEffect(() => {
    if (enabled) return
    state.current = null
    setDragging(false)
  }, [enabled])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      const stage = stageRef.current
      if (!stage) return
      if (e.button !== 0) return

      // Measure against the *paper*, never the stage. The page is centred in a
      // much wider stage, and the `.flip-zone` click overlays sit on top of it,
      // so `e.target` is often not a page element. Resolve the paper geometry
      // from the DOM instead of from the event target.
      const paper =
        (stage.querySelector('.reader-spread.current') as HTMLElement | null) ??
        (stage.querySelector('.reader-page') as HTMLElement | null) ??
        stage
      const rect = paper.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      // ignore points outside the paper (side gutters, below the page)
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return

      // A horizontal swipe anywhere on the sheet turns the page (Tencent
      // Reading behaves this way); the outer quarters additionally allow a
      // short pull without travelling far.
      // Text selection wins over the gesture.
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return

      state.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        dir: 'next',
        progress: 0,
        pageWidth,
        engaged: false
      }
      last.current = { x: e.clientX, t: performance.now(), v: 0 }
    },
    [enabled, stageRef, pageWidth]
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
}

/**
 * Computes the CSS transform/style for the outgoing page.
 *
 * cover — the page rotates around its spine like a real sheet being peeled,
 *         which is what Tencent Reading/Fanqie feel like.
 * slide — the page slides straight out, exposing the next one underneath.
 * curl  — the page slides while a shadow band sweeps across its inner edge.
 */
export function pageTurnStyle(visual: TurnVisual, pageWidth: number): React.CSSProperties {
  const { progress, dir, dragging, mode } = visual
  const sign = dir === 'next' ? -1 : 1
  // `progress` is the single source of truth: 0 is the resting page. While the
  // pointer is down there is no transition (the page tracks the finger); on
  // release the CSS transition animates either back to 0 (cancelled) or the
  // committed page is replaced, which also renders at progress 0.
  const eased = Math.max(0, Math.min(1, progress))

  if (mode === 'none' || eased === 0) return {}

  if (mode === 'slide') {
    return {
      transform: `translate3d(${sign * eased * pageWidth}px, 0, 0)`,
      opacity: '1',
      transition: dragging ? 'none' : 'transform 320ms cubic-bezier(.2,0,0,1), opacity 320ms linear',
      willChange: 'transform'
    }
  }

  if (mode === 'curl') {
    return {
      transform: `translate3d(${sign * eased * pageWidth * 0.92}px, 0, 0) skewY(${sign * eased * 1.2}deg)`,
      opacity: '1',
      transition: dragging ? 'none' : 'transform 360ms cubic-bezier(.2,0,0,1), opacity 360ms linear',
      boxShadow: `inset ${-sign * eased * 42}px 0 46px -22px rgba(0,0,0,.55)`,
      willChange: 'transform'
    }
  }

  // cover: rotate around the spine on the side we are leaving from
  const angle = eased * 78 // degrees
  const origin = dir === 'next' ? 'left center' : 'right center'
  return {
    transform: `perspective(1800px) rotateY(${dir === 'next' ? -angle : angle}deg)`,
    transformOrigin: origin,
    transition: dragging ? 'none' : 'transform 380ms cubic-bezier(.2,0,0,1)',
    boxShadow: `inset 0 0 ${eased * 40}px rgba(0,0,0,${0.28 * eased})`,
    willChange: 'transform'
  }
}

/** Tracks viewport width for gesture math without re-rendering on every move. */
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

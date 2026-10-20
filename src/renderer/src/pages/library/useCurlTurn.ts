// ---------------------------------------------------------------------------
// useCurlTurn — page turns for every format, driven by the Canvas 2D engine.
//
// One code path replaces the previous three (prose sheet, EPUB overlay, PDF):
// whatever is on screen is snapshotted once per turn, then bent as a sheet.
// Because the overlay is clipped to the stage box, nothing can ever be drawn
// outside the render frame — which is the bug the old CSS-transform approach
// kept producing for EPUB.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { CURL_QUALITY, PageCurlRenderer, type CurlDir } from './pageCurl'
import { TURN_DURATION, resolvePaper } from './useDragFlip'

/** how far the pointer must travel before a press counts as a drag */
const SLOP_PX = 6
/** px per ms — a quick flick commits even below the distance threshold */
const FLICK_VELOCITY = 0.45
/** only the bottom 40% of the sheet starts a turn (keeps text selectable) */
const BOTTOM_ZONE_H = 0.4

export interface CurlTurnOptions {
  /** the element the overlay covers (the reading stage) */
  stageRef: React.RefObject<HTMLElement | null>
  /** master switch: false when animation mode is 'none' */
  enabled: boolean
  /** GPU on -> high quality, GPU off -> cheap software-friendly profile */
  gpuAcceleration: boolean
  /** 0..1 of the page width the drag must cross to commit */
  threshold: number
  /** runs once the sheet has fully landed; advance the content here */
  onTurn: (dir: CurlDir) => void
}

export interface CurlTurnApi {
  /** true while a committed turn is playing (content must not change yet) */
  playing: boolean
  /** play a full turn for a button/keyboard press */
  play: (dir: CurlDir) => Promise<void>
  /** attach to the stage's onPointerDown */
  onPointerDown: (e: React.PointerEvent) => void
}

interface Geometry {
  canvasW: number
  canvasH: number
  /** the sheet (the half that turns) in canvas CSS px */
  sheet: { x: number; y: number; w: number; h: number }
}

export function useCurlTurn(opts: CurlTurnOptions): CurlTurnApi {
  const { stageRef, enabled, gpuAcceleration, threshold, onTurn } = opts
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<PageCurlRenderer | null>(null)
  const [playing, setPlaying] = useState(false)
  const busy = useRef(false)
  const snapshotCache = useRef<{ key: string; img: HTMLImageElement | null } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  /* ---- overlay lifecycle ------------------------------------------------ */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const canvas = document.createElement('canvas')
    canvas.className = 'curl-canvas'
    stage.appendChild(canvas)
    canvasRef.current = canvas
    const renderer = new PageCurlRenderer(canvas)
    rendererRef.current = renderer
    renderer.setQuality(gpuAcceleration ? CURL_QUALITY.high : CURL_QUALITY.low)

    const fit = (): void => {
      const r = stage.getBoundingClientRect()
      renderer.resize(r.width, r.height, window.devicePixelRatio || 1)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)

    return () => {
      ro.disconnect()
      canvas.remove()
      canvasRef.current = null
      rendererRef.current = null
    }
  }, [stageRef, gpuAcceleration])

  useEffect(() => {
    rendererRef.current?.setQuality(gpuAcceleration ? CURL_QUALITY.high : CURL_QUALITY.low)
  }, [gpuAcceleration])

  /** Sheet rectangle: in a spread only the half away from the gutter turns. */
  const geometry = useCallback((): Geometry | null => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return null
    const r = stage.getBoundingClientRect()
    const twoUp = !!stage.querySelector('.reader-page.right-page') || !!stage.querySelector('.reader-spread.current')
    const w = r.width
    const h = r.height
    // In a spread the turning half is the right side; in single-page mode the
    // whole width is the sheet, hinged on the gutter at the left.
    const sheetW = twoUp ? w / 2 : w
    return {
      canvasW: w,
      canvasH: h,
      sheet: { x: twoUp ? w / 2 : 0, y: 0, w: sheetW, h }
    }
  }, [stageRef])

  /**
   * Snapshot the stage so the sheet has real content.
   *
   * Cached per frame so a drag does not re-capture on every gesture; the key
   * includes the page index / progress text, which changes exactly when a new
   * page is shown.
   */
  const getSnapshot = useCallback(async (): Promise<HTMLImageElement | null> => {
    const stage = stageRef.current
    if (!stage) return null
    const key = `${stage.dataset.curlKey ?? ''}:${document.querySelector('.pgnum')?.textContent ?? ''}`
    if (snapshotCache.current?.key === key) return snapshotCache.current.img

    const r = stage.getBoundingClientRect()
    let img: HTMLImageElement | null = null
    try {
      const dataUrl = await window.api.app.capture({
        x: Math.max(0, Math.round(r.left)),
        y: Math.max(0, Math.round(r.top)),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height))
      })
      if (dataUrl) {
        img = await new Promise<HTMLImageElement | null>((resolve) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = () => resolve(null)
          el.src = dataUrl
        })
      }
    } catch {
      img = null
    }
    snapshotCache.current = { key, img }
    return img
  }, [stageRef])

  /** Runs one turn from `from` to 1 (committed) or back to 0 (cancelled). */
  const animate = useCallback(
    (dir: CurlDir, from: number, to: number, duration: number): Promise<void> => {
      const renderer = rendererRef.current
      const geo = geometry()
      if (!renderer || !geo) return Promise.resolve()
      const start = performance.now()
      return new Promise((resolve) => {
        const step = (now: number): void => {
          const t = Math.min(1, (now - start) / Math.max(1, duration))
          // easeOutQuint for a long, papery landing
          const eased = 1 - Math.pow(1 - t, 5)
          const progress = from + (to - from) * eased
          renderer.render({ progress, dir }, geo.sheet)
          if (t < 1) requestAnimationFrame(step)
          else {
            renderer.clear()
            resolve()
          }
        }
        requestAnimationFrame(step)
      })
    },
    [geometry]
  )

  /** Full turn triggered by a button / keyboard. */
  const play = useCallback(
    async (dir: CurlDir): Promise<void> => {
      if (!enabled || busy.current) return
      busy.current = true
      setPlaying(true)
      try {
        // Kick the snapshot request off but do NOT await it before the first
        // frame: the capture is an IPC round-trip (~50-120ms) and waiting made
        // the click feel dead. The engine draws honest paper until the real
        // page image arrives, then swaps it in mid-turn.
        const renderer = rendererRef.current
        renderer?.setImages(null, null)
        const snapshot = getSnapshot()
        void snapshot.then((img) => {
          if (img && rendererRef.current) rendererRef.current.setImages(img, null)
        })
        await animate(dir, 0, 1, TURN_DURATION)
        optsRef.current.onTurn(dir)
      } finally {
        // let the new page paint before releasing the overlay
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        snapshotCache.current = null
        busy.current = false
        setPlaying(false)
      }
    },
    [enabled, getSnapshot, animate]
  )

  /* ---- drag gesture ----------------------------------------------------- */
  const onPointerDown = useCallback(
    (e: React.PointerEvent): void => {
      if (!enabled || busy.current) return
      if (e.button !== 0) return
      const stage = stageRef.current
      if (!stage) return
      const paper = resolvePaper(stage)
      if (!paper) return
      const pr = paper.getBoundingClientRect()

      // only the bottom band of the sheet starts a turn, so text stays selectable
      const relY = (e.clientY - pr.top) / Math.max(1, pr.height)
      if (relY < 1 - BOTTOM_ZONE_H) return

      const startX = e.clientX
      const startT = performance.now()
      const dir: CurlDir = startX > pr.left + pr.width / 2 ? 'next' : 'prev'
      const geo = geometry()
      if (!geo) return

      // Begin the snapshot immediately: it is an async IPC round-trip, so doing
      // it on pointerdown means the image is ready by the first real movement.
      const snapshotPromise = getSnapshot()

      let moved = false
      let progress = 0
      const renderer = rendererRef.current

      const distFor = (): number => Math.max(80, geo.sheet.w)

      const paint = (p: number): void => {
        if (!renderer) return
        renderer.render({ progress: Math.max(0, Math.min(1, p)), dir }, geo.sheet)
      }

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const signed = dir === 'next' ? -dx : dx
        if (!moved && Math.abs(dx) < SLOP_PX) return
        moved = true
        progress = Math.max(0, Math.min(1, signed / distFor()))
        paint(progress)
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        stage.classList.remove('is-dragging')

        const elapsed = Math.max(1, performance.now() - startT)
        const velocity = (progress * distFor()) / elapsed
        const commit = progress * geo.sheet.w > threshold || velocity > FLICK_VELOCITY

        if (!moved) {
          renderer?.clear()
          return
        }
        busy.current = true
        setPlaying(true)
        void (async () => {
          try {
            // same as play(): never block the first frame on the capture
            void snapshotPromise.then((img) => {
              if (img) rendererRef.current?.setImages(img, null)
            })
            await animate(dir, progress, commit ? 1 : 0, commit ? TURN_DURATION : 320)
            if (commit) optsRef.current.onTurn(dir)
          } finally {
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
            snapshotCache.current = null
            busy.current = false
            setPlaying(false)
          }
        })()
      }

      stage.classList.add('is-dragging')
      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [enabled, stageRef, geometry, getSnapshot, animate, threshold]
  )

  return { playing, play, onPointerDown }
}

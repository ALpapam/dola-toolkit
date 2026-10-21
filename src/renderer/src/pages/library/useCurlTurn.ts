// ---------------------------------------------------------------------------
// useCurlTurn — page turns for every format, gated so the NEXT spread is already
// rendered before the sheet moves.
//
// Flow (this is what removes the "turn finishes, then content jumps" delay):
//   1. snapshot the stage as it looks now            (old pixels)
//   2. commit the page change immediately            (new spread renders)
//   3. draw the old half as an opaque base patch     (no early reveal)
//   4. bend the old sheet over it                    (the animation)
//   5. clear the canvas                              (new spread was there all along)
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { CURL_QUALITY, PageCurlRenderer, type CurlDir } from './pageCurl'
import { TURN_DURATION, resolvePaper } from './useDragFlip'

/** pointer travel (px) before a press counts as a drag */
const SLOP_PX = 6
/** px per ms — a flick commits even below the distance threshold */
const FLICK_VELOCITY = 0.45

export interface CurlTurnOptions {
  stageRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  gpuAcceleration: boolean
  /** 0..1 fraction of the sheet width the drag must cross to commit */
  threshold: number
  /**
   * Move the content by one page/spread. Called BEFORE the animation starts
   * (so the new page is already painted underneath) and again with the opposite
   * direction if the gesture is cancelled.
   */
  onAdvance: (dir: CurlDir) => void
}

export interface CurlTurnApi {
  playing: boolean
  play: (dir: CurlDir) => Promise<void>
  onPointerDown: (e: React.PointerEvent) => void
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function useCurlTurn(opts: CurlTurnOptions): CurlTurnApi {
  const { stageRef, enabled, gpuAcceleration, threshold, onAdvance } = opts
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<PageCurlRenderer | null>(null)
  const [playing, setPlaying] = useState(false)
  const busy = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  /* ---- overlay canvas ------------------------------------------------ */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const canvas = document.createElement('canvas')
    canvas.className = 'curl-canvas'
    stage.appendChild(canvas)
    canvasRef.current = canvas
    const renderer = new PageCurlRenderer(canvas)
    rendererRef.current = renderer
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
  }, [stageRef])

  useEffect(() => {
    rendererRef.current?.setQuality(gpuAcceleration ? CURL_QUALITY.high : CURL_QUALITY.low)
  }, [gpuAcceleration])

  /**
   * Rect of the thing that actually turns, in canvas coordinates.
   *
   * `next` turns the right page and keeps the left half visible as a base
   * patch; `prev` is the mirror image. Single-page mode has no second half, so
   * the whole page turns and no base patch is needed.
   */
  const layout = useCallback(
    (dir: CurlDir): { sheet: Rect; base: Rect | null; twoUp: boolean } | null => {
      const stage = stageRef.current
      if (!stage) return null
      const paper: HTMLElement | null = resolvePaper(stage)
      if (!paper) return null
      const st = stage.getBoundingClientRect()
      const pr = paper.getBoundingClientRect()
      if (pr.width < 4 || pr.height < 4) return null
      const twoUp = pr.width > pr.height * 0.95 && pr.width > 520
      // canvas-relative
      const px = pr.x - st.x
      const py = pr.y - st.y
      if (!twoUp) {
        return { sheet: { x: px, y: py, w: pr.width, h: pr.height }, base: null, twoUp: false }
      }
      const half = pr.width / 2
      const left: Rect = { x: px, y: py, w: half, h: pr.height }
      const right: Rect = { x: px + half, y: py, w: half, h: pr.height }
      return dir === 'next'
        ? { sheet: right, base: left, twoUp: true }
        : { sheet: left, base: right, twoUp: true }
    },
    [stageRef]
  )

  /** region of the stage to capture; smaller rect = faster IPC round-trip */
  const snapshot = useCallback(
    async (rect?: { x: number; y: number; width: number; height: number }): Promise<HTMLImageElement | null> => {
      const stage = stageRef.current
      if (!stage) return null
      const r = stage.getBoundingClientRect()
      const region = rect ?? {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
      try {
        const dataUrl = await window.api.app.capture({
          x: Math.max(0, region.x),
          y: Math.max(0, region.y),
          width: Math.max(1, region.width),
          height: Math.max(1, region.height)
        })
        if (!dataUrl) return null
        const img = await new Promise<HTMLImageElement | null>((res) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = () => res(null)
          im.src = dataUrl
        })
        if (!img) return null
        /*
         * Reject a blank capture.
         *
         * If the grab comes back as near-uniform white (window occluded, GPU
         * surface not ready, wrong rect) the curl would draw a sheet of empty
         * paper for the whole animation — exactly the "blank page until it
         * lands" symptom. Treat it as a failed capture so the caller can fall
         * back to a turn that keeps the real DOM text visible.
         */
        try {
          const probe = document.createElement('canvas')
          probe.width = 64
          probe.height = 64
          const pg = probe.getContext('2d')
          if (pg) {
            pg.drawImage(img, 0, 0, 64, 64)
            const d = pg.getImageData(0, 0, 64, 64).data
            let sum = 0
            let sum2 = 0
            let n = 0
            for (let i = 0; i < d.length; i += 4) {
              const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
              sum += l
              sum2 += l * l
              n++
            }
            const mean = sum / n
            const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
            if (sd < 3) {
              console.warn('[curl] blank snapshot (sd=' + sd.toFixed(1) + ') — using DOM fallback')
              return null
            }
          }
        } catch {
          /* probe is best-effort */
        }
        return img
      } catch {
        return null
      }
    },
    [stageRef]
  )

  /**
   * The reverse side of the leaf: the far half AFTER the content advanced.
   * For `next` that is the new spread's LEFT page (it becomes the back of the
   * sheet that just turned); for `prev` it is the new spread's RIGHT page.
   */
  const captureBack = useCallback(
    async (geo: { sheet: Rect; base: Rect | null }): Promise<{ img: HTMLImageElement | null; rect: Rect | null }> => {
      const stage = stageRef.current
      if (!stage || !geo.base) return { img: null, rect: null }
      const st = stage.getBoundingClientRect()
      const r = { x: st.left + geo.base.x, y: st.top + geo.base.y, width: geo.base.w, height: geo.base.h }
      return { img: await snapshot(r), rect: geo.base }
    },
    [stageRef, snapshot]
  )

  /** rAF loop that advances `progress` from `from` to `to`. */
  const animate = useCallback(
    (dir: CurlDir, from: number, to: number, duration: number): Promise<void> => {
      const renderer = rendererRef.current
      if (!renderer) return Promise.resolve()
      const start = performance.now()
      return new Promise((resolve) => {
        const step = (now: number): void => {
          const t = Math.min(1, (now - start) / Math.max(1, duration))
          const eased = 1 - Math.pow(1 - t, 5)
          renderer.render({ progress: from + (to - from) * eased, dir })
          if (t < 1) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
    },
    []
  )

  /** Waits for the browser to paint, so the newly committed spread is on screen. */
  const nextPaint = (): Promise<void> =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

  /**
   * Transform-only turn used when no snapshot is available.
   *
   * It cannot curl (the sheet shape needs page pixels) but it never shows a
   * blank sheet: the real pages stay in the DOM and simply slide/fade, so the
   * text is on screen the entire time.
   */
  const domFallbackTurn = useCallback(
    (dir: CurlDir): Promise<void> => {
      optsRef.current.onAdvance(dir)
      const stage = stageRef.current
      if (!stage) return Promise.resolve()
      const shift = dir === 'next' ? -5 : 5
      try {
        stage.animate(
          [
            { transform: `translateX(${shift}%)`, opacity: 0.72 },
            { transform: 'translateX(0)', opacity: 1 }
          ],
          { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' }
        )
      } catch {
        /* Element.animate unavailable: content already advanced, done */
      }
      return new Promise<void>((r) => setTimeout(r, 280))
    },
    [stageRef]
  )

  const play = useCallback(
    async (dir: CurlDir): Promise<void> => {
      if (!enabled || busy.current) return
      const renderer = rendererRef.current
      const geo = layout(dir)
      if (!renderer || !geo) return
      busy.current = true
      setPlaying(true)
      try {
        // 1. the leaf's front (as it looks now)
        // 2. advance the content and let it paint
        // 3. capture the far half — that is the leaf's printed reverse side
        // 4. bend the leaf over the already-rendered new page
        const front = await snapshot()
        if (!front) {
          /*
           * No snapshot (capture refused, DPI/scale mismatch, headless GPU…).
           * Drawing the curl with no page image would show a blank sheet of
           * paper, so fall back to a transform-only turn that always keeps the
           * real DOM text visible.
           */
          console.warn('[curl] snapshot unavailable — using DOM fallback turn')
          await domFallbackTurn(dir)
          return
        }
        renderer.setLayers(front, null, geo.sheet, geo.base, geo.base)
        optsRef.current.onAdvance(dir)
        await nextPaint()
        const back = await captureBack(geo)
        renderer.setLayers(front, back.img, geo.sheet, geo.base, back.rect)
        await animate(dir, 0, 1, TURN_DURATION)
      } finally {
        renderer.clear()
        busy.current = false
        setPlaying(false)
      }
    },
    [enabled, layout, snapshot, captureBack, animate, domFallbackTurn]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent): void => {
      if (!enabled || busy.current || e.button !== 0) return
      const stage = stageRef.current
      const renderer = rendererRef.current
      if (!stage || !renderer) return
      const paper = resolvePaper(stage)
      if (!paper) return
      const pr = paper.getBoundingClientRect()
      // The whole sheet starts a horizontal swipe. A plain click never turns a
      // page (the turn only commits once the pointer has actually travelled),
      // so there is no need to restrict the grab area to a bottom band — that
      // restriction is why swiping across the middle appeared to do nothing.
      if (e.clientX < pr.left || e.clientX > pr.right) return

      // which half turns is decided by where the gesture started
      const dir: CurlDir = e.clientX > pr.left + pr.width / 2 ? 'next' : 'prev'
      const geo = layout(dir)
      if (!geo) return

      const startX = e.clientX
      const startT = performance.now()
      const dist = Math.max(80, geo.sheet.w)

      // snapshot starts now; it is an async IPC round-trip
      const snapPromise = snapshot()
      let snapReady: HTMLImageElement | null = null
      let backReady: HTMLImageElement | null = null
      let backRect: Rect | null = geo.base
      let advanced = false
      /** true once we may paint: the reverse side must be captured first */
      let ready = false
      let moved = false
      let progress = 0

      void snapPromise.then((img) => {
        snapReady = img
      })

      const paint = (): void => {
        if (!ready || !snapReady) return
        renderer.setLayers(snapReady, backReady, geo.sheet, geo.base, backRect)
        renderer.render({ progress, dir })
      }

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        if (!moved && Math.abs(dx) < SLOP_PX) return
        if (!moved) {
          moved = true
          optsRef.current.onAdvance(dir)
          advanced = true
          /*
           * Capture the reverse side BEFORE painting the base patch: once the
           * base is on the canvas it would be part of the screenshot and the
           * leaf's back would show the OLD page. Painting is therefore held
           * for the duration of that one capture (~60-120ms) — imperceptible
           * at the start of a drag, and it keeps the back face correct.
           */
          void (async () => {
            await nextPaint()
            const back = await captureBack(geo)
            backReady = back.img
            backRect = back.rect
            ready = true
            paint()
          })()
        }
        const signed = dir === 'next' ? -dx : dx
        progress = Math.max(0, Math.min(1, signed / dist))
        paint()
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)

        if (!moved) {
          renderer.clear()
          return
        }
        const elapsed = Math.max(1, performance.now() - startT)
        const commit =
          progress * geo.sheet.w > threshold * geo.sheet.w || (progress * dist) / elapsed > FLICK_VELOCITY

        busy.current = true
        setPlaying(true)
        void (async () => {
          try {
            await nextPaint()
            // Wait for the front snapshot; the back may still be in flight and
            // will simply pop in mid-turn (paper until then).
            if (!snapReady) snapReady = await snapPromise
            renderer.setLayers(snapReady, backReady, geo.sheet, geo.base, backRect)
            await animate(dir, progress, commit ? 1 : 0, commit ? TURN_DURATION : 300)
            if (!commit && advanced) {
              // put the page back: the content had already moved
              optsRef.current.onAdvance(dir === 'next' ? 'prev' : 'next')
              await nextPaint()
            }
          } finally {
            renderer.clear()
            busy.current = false
            setPlaying(false)
          }
        })()
      }

      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [enabled, stageRef, layout, snapshot, captureBack, animate, threshold]
  )

  return { playing, play, onPointerDown }
}

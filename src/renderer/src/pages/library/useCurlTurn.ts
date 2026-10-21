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

export interface CurlTurnOptions {
  stageRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  gpuAcceleration: boolean
  /**
   * Whether the reader is showing a two-page spread. This comes from the reader
   * itself: guessing it from the paper's aspect ratio mis-classified a wide
   * single page as a spread, which made the turn hinge in the middle of it.
   */
  twoUp: boolean
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
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function useCurlTurn(opts: CurlTurnOptions): CurlTurnApi {
  const { stageRef, enabled, gpuAcceleration, twoUp, onAdvance } = opts
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<PageCurlRenderer | null>(null)
  const [playing, setPlaying] = useState(false)
  const busy = useRef(false)
  const twoUpRef = useRef(twoUp)
  twoUpRef.current = twoUp
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
      // canvas-relative
      const px = pr.x - st.x
      const py = pr.y - st.y
      if (!twoUpRef.current) {
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

  /**
   * Waits for the page's own images to finish decoding.
   *
   * Without this, a page whose content is an illustration could be captured
   * before the <img> paints: the screenshot then contains the bare background
   * and the leaf appears to flash or show an empty page for that turn.
   *
   * EPUB puts its illustrations inside the chapter iframe, which is not a
   * descendant of the paper element — those documents are same-origin, so they
   * are walked as well. Bound by a short timeout: a broken image must never
   * stall a page turn.
   */
  const settleImages = useCallback(async (paper: HTMLElement | null): Promise<void> => {
    const docs: Document[] = []
    const stage = stageRef.current
    for (const root of [paper, stage]) {
      if (!root) continue
      if (root.ownerDocument && !docs.includes(root.ownerDocument)) docs.push(root.ownerDocument)
      for (const frame of Array.from(root.querySelectorAll('iframe'))) {
        try {
          const doc = (frame as HTMLIFrameElement).contentDocument
          if (doc && !docs.includes(doc)) docs.push(doc)
        } catch {
          /* cross-origin frame: skip */
        }
      }
    }

    const imgs: HTMLImageElement[] = []
    for (const doc of docs) imgs.push(...Array.from(doc.images))
    if (imgs.length === 0) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      return
    }
    await Promise.all(
      imgs.map(
        (im) =>
          new Promise<void>((r) => {
            if (im.complete && im.naturalWidth > 0) {
              r()
              return
            }
            const done = (): void => r()
            im.addEventListener('load', done, { once: true })
            im.addEventListener('error', done, { once: true })
            setTimeout(done, 150)
          })
      )
    )
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
  }, [stageRef])

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
         * Reject only a genuinely empty capture.
         *
         * The earlier version downscaled the whole page to 64x64 before
         * measuring contrast — that averages the glyphs away, so an ordinary
         * text page scored sd ≈ 2 and was thrown out on every turn (which is
         * why the console filled with "blank snapshot" and the leaf kept
         * falling back). Contrast is now measured on full-resolution
         * horizontal bands, where text survives, and the threshold only trips
         * on an almost perfectly uniform image.
         */
        try {
          const bandH = 16
          const bands = [0.25, 0.5, 0.75]
          const probe = document.createElement('canvas')
          probe.width = Math.min(img.naturalWidth, 768)
          probe.height = bandH * bands.length
          const pg = probe.getContext('2d')
          if (pg) {
            bands.forEach((f, i) => {
              const sy = Math.min(
                Math.max(0, Math.round(img.naturalHeight * f) - bandH / 2),
                Math.max(0, img.naturalHeight - bandH)
              )
              // 1:1 vertically so glyph rows are preserved
              pg.drawImage(img, 0, sy, img.naturalWidth, bandH, 0, i * bandH, probe.width, bandH)
            })
            const d = pg.getImageData(0, 0, probe.width, probe.height).data
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
            if (sd < 0.8) {
              console.warn('[curl] empty snapshot (sd=' + sd.toFixed(2) + ') — using DOM fallback')
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
        /*
         * 1. snapshot the page while it is still the old one — nothing moves yet
         * 2. advance the content
         * 3. start turning IMMEDIATELY
         *
         * Step 3 is what removes the "content jumps, then the animation plays"
         * delay: there is no second screenshot any more. The leaf's front comes
         * from step 1 and its reverse side is simply the live new page showing
         * through the canvas, so nothing has to be captured after the advance.
         */
        await settleImages(stageRef.current ? resolvePaper(stageRef.current) : null)
        const front = await snapshot()
        if (!front) {
          console.warn('[curl] snapshot unavailable — using DOM fallback turn')
          await domFallbackTurn(dir)
          return
        }
        renderer.setLayers(front, geo.sheet, geo.base)
        optsRef.current.onAdvance(dir)
        // draw the flat old spread this frame so the new content never shows
        // before the leaf starts moving
        renderer.render({ progress: 0, dir })
        await animate(dir, 0, 1, TURN_DURATION)
      } finally {
        renderer.clear()
        busy.current = false
        setPlaying(false)
      }
    },
    [enabled, layout, snapshot, animate, domFallbackTurn, settleImages]
  )

  return { playing, play }
}
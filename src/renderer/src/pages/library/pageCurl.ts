// ---------------------------------------------------------------------------
// Dola Toolkit — paper-curl page turn renderer (Canvas 2D)
//
// A real book leaf has TWO faces:
//   front  the page you are looking at now
//   back   the page printed on the other side — which, in reading order, is the
//          page that ends up on the far half once the leaf has landed
// So the sheet must be drawn from two different images, not one mirrored onto
// itself. `front` and `back` are separate stage-sized snapshots.
//
// Strip seams: the sheet is bent by drawing vertical slices, but the slices are
// composited into an OFFSCREEN buffer first and shaded ONCE with a multi-stop
// gradient over the finished shape. Shading each slice individually (the old
// approach) leaves a visible band per slice — the "several vertical stripes"
// that stayed on screen for the whole animation.
//
// Geometry: the hinge is the binding. Slice angles increase away from it, the
// positions are integrated from those angles, so the free edge lags behind and
// the sheet arcs instead of pivoting like a card.
// ---------------------------------------------------------------------------

export type CurlDir = 'next' | 'prev'

export interface CurlFrame {
  /** 0 = sheet flat over its own half, 1 = sheet has landed on the far side */
  progress: number
  dir: CurlDir
}

export interface CurlQuality {
  strips: number
  shadow: boolean
  highlight: boolean
}

export const CURL_QUALITY: Record<'high' | 'low', CurlQuality> = {
  high: { strips: 128, shadow: true, highlight: true },
  // GPU off: fewer slices, no soft shadow / specular sweep
  low: { strips: 48, shadow: false, highlight: false }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const PAPER_FRONT = [255, 251, 254] as const
const PAPER_BACK = [236, 230, 239] as const

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private quality: CurlQuality = CURL_QUALITY.high

  /** the leaf's two faces, in the OLD orientation (before the turn landed) */
  private front: HTMLImageElement | null = null
  private back: HTMLImageElement | null = null
  /** region the `back` image was captured from (the far half, after commit) */
  private backRect: Rect | null = null
  private base: Rect | null = null
  private sheet: Rect = { x: 0, y: 0, w: 0, h: 0 }

  private off: HTMLCanvasElement
  private offCtx: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    this.off = document.createElement('canvas')
    const offCtx = this.off.getContext('2d')
    if (!offCtx) throw new Error('2D canvas unavailable')
    this.offCtx = offCtx
  }

  setQuality(q: CurlQuality): void {
    this.quality = q
  }

  /**
   * @param front stage snapshot BEFORE the turn (the page being lifted)
   * @param back  snapshot of the FAR half AFTER the content advanced — that half
   *              is the printed reverse side of the leaf
   * @param backRect the region `back` was captured from, in canvas coordinates
   */
  setLayers(
    front: HTMLImageElement | null,
    back: HTMLImageElement | null,
    sheet: Rect,
    base: Rect | null,
    backRect: Rect | null
  ): void {
    this.front = front
    this.back = back
    this.backRect = backRect
    this.sheet = sheet
    this.base = base
  }

  /** Late-arriving reverse side (the second capture is usually ready mid-turn). */
  setBack(img: HTMLImageElement | null): void {
    this.back = img
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = Math.max(1, Math.min(dpr, 2))
    const w = Math.max(1, Math.round(cssWidth * this.dpr))
    const h = Math.max(1, Math.round(cssHeight * this.dpr))
    this.canvas.width = w
    this.canvas.height = h
    this.canvas.style.width = `${cssWidth}px`
    this.canvas.style.height = `${cssHeight}px`
    this.off.width = w
    this.off.height = h
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private cssW(): number {
    return this.canvas.width / this.dpr
  }
  private cssH(): number {
    return this.canvas.height / this.dpr
  }

  /** Draws the still-old half so it does not reveal the new page too early. */
  private drawBase(): void {
    const { ctx, front, base } = this
    if (!front || !base) return
    const sx = front.naturalWidth / this.cssW()
    const sy = front.naturalHeight / this.cssH()
    ctx.drawImage(front, base.x * sx, base.y * sy, base.w * sx, base.h * sy, base.x, base.y, base.w, base.h)
  }

  render(frame: CurlFrame): void {
    const p = Math.max(0, Math.min(1, frame.progress))
    this.clear()
    if (p <= 0.0001) return

    const { ctx, offCtx: oc } = this
    const S = this.sheet
    const W = S.w
    const H = S.h
    const dir = frame.dir
    const strips = this.quality.strips

    // ---- 1. the half that has not been reached yet stays on the live page
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    this.drawBase()
    ctx.restore()

    // ---- 2. bend the leaf into an offscreen buffer, unshaded
    oc.setTransform(1, 0, 0, 1, 0, 0)
    oc.clearRect(0, 0, this.off.width, this.off.height)
    oc.save()
    oc.scale(this.dpr, this.dpr)

    const hingeX = dir === 'next' ? S.x : S.x + W
    const total = Math.PI * p
    // the free edge curls further than the hinge: that is what makes paper arc
    const CURL = 0.52 * Math.sin(Math.PI * Math.min(1, p * 1.1))

    const step = 1 / strips
    const pos = new Float64Array(strips + 1)
    const ang = new Float64Array(strips + 1)
    let cursor = 0
    for (let i = 0; i <= strips; i++) {
      const t = i / strips
      const a = total + CURL * Math.pow(t, 1.6)
      ang[i] = a
      pos[i] = cursor
      cursor += Math.cos(a) * step * W
    }

    const imgW = this.cssW()
    const imgH = this.cssH()
    const fScaleX = (this.front?.naturalWidth ?? 1) / imgW
    const fScaleY = (this.front?.naturalHeight ?? 1) / imgH



    for (let i = 0; i < strips; i++) {
      const a = ang[i]
      const x0 = pos[i]
      const x1 = pos[i + 1]
      const dw = x1 - x0
      if (Math.abs(dw) < 0.001) continue
      const t0 = i / strips
      const t1 = (i + 1) / strips
      const back = Math.cos(a) < 0

      // The leaf is drawn in "hinge space": +u goes away from the binding.
      // `next` runs towards -x on screen, `prev` towards +x.
      const place = (): void => {
        if (dir === 'next') {
          oc.translate(hingeX - x0, S.y)
          oc.scale(-1, 1)
        } else {
          oc.translate(hingeX + x0, S.y)
        }
        if (back) {
          oc.translate(Math.abs(dw), 0)
          oc.scale(-1, 1)
        }
      }

      oc.save()
      place()

      if (back) {
        /*
         * Looking at the printed reverse side. On the leaf, sheet distance u
         * maps to back-page coordinate v = W - u (the leaf's free edge becomes
         * the far page's outer edge once it has landed). Rendering that, plus
         * the mirror above, keeps the back page the right way round at the end
         * of the turn instead of showing the front page flipped.
         */
        const v0 = 1 - t1
        const v1 = 1 - t0
        const br = this.backRect
        const bScaleX = (this.back?.naturalWidth ?? 1) / (br?.w ?? W)
        const bScaleY = (this.back?.naturalHeight ?? 1) / (br?.h ?? H)
        if (this.back && this.back.naturalWidth > 0) {
          oc.drawImage(
            this.back,
            v0 * (br?.w ?? W) * bScaleX,
            0,
            Math.max(0.5, (v1 - v0) * (br?.w ?? W) * bScaleX),
            (br?.h ?? H) * bScaleY,
            0,
            0,
            Math.abs(dw) + 0.8,
            H
          )
        } else {
          oc.fillStyle = `rgb(${PAPER_BACK[0]},${PAPER_BACK[1]},${PAPER_BACK[2]})`
          oc.fillRect(-0.4, 0, Math.abs(dw) + 0.8, H)
        }
      } else {
        const sx = S.x * fScaleX + t0 * W * fScaleX
        const sw = Math.max(0.5, (t1 - t0) * W * fScaleX)
        if (this.front && this.front.naturalWidth > 0) {
          oc.drawImage(
            this.front,
            sx,
            S.y * fScaleY,
            sw,
            H * fScaleY,
            0,
            0,
            Math.abs(dw) + 0.8,
            H
          )
        } else {
          oc.fillStyle = `rgb(${PAPER_FRONT[0]},${PAPER_FRONT[1]},${PAPER_FRONT[2]})`
          oc.fillRect(-0.4, 0, Math.abs(dw) + 0.8, H)
        }
      }
      oc.restore()
    }

    // ---- 3. shade the finished shape in ONE pass (no per-slice banding)
    const shadeStops = 24
    const grad = oc.createLinearGradient(
      dir === 'next' ? hingeX : hingeX,
      dir === 'next' ? 0 : 0,
      dir === 'next' ? hingeX - W : hingeX + W,
      0
    )
    for (let k = 0; k <= shadeStops; k++) {
      const t = k / shadeStops
      const i = Math.min(strips, Math.round(t * strips))
      const facing = Math.abs(Math.cos(ang[i]))
      const isBack = Math.cos(ang[i]) < 0
      // the back of paper is duller and darker; the front darkens as it turns
      const alpha = isBack ? 0.16 + 0.3 * (1 - facing) : 0.4 * (1 - facing)
      const tint = isBack ? '96,86,104' : '0,0,0'
      // gradient runs from the hinge outwards; x is flipped for `next`
      const stop = dir === 'next' ? 1 - t : t
      grad.addColorStop(Math.max(0, Math.min(1, stop)), `rgba(${tint},${alpha.toFixed(3)})`)
    }
    oc.globalCompositeOperation = 'source-atop'
    const shadeX = dir === 'next' ? hingeX - W : hingeX
    oc.fillStyle = grad
    oc.fillRect(shadeX, S.y, W, H)

    // ---- 4. specular sweep right at the fold
    if (this.quality.highlight) {
      const gx0 = dir === 'next' ? hingeX : hingeX
      const gx1 = dir === 'next' ? hingeX - W * 0.35 : hingeX + W * 0.35
      const spec = oc.createLinearGradient(gx0, 0, gx1, 0)
      const a = 0.34 * Math.sin(Math.PI * p)
      spec.addColorStop(0, `rgba(255,255,255,${a})`)
      spec.addColorStop(1, 'rgba(255,255,255,0)')
      oc.fillStyle = spec
      oc.fillRect(Math.min(gx0, gx1), S.y, Math.abs(gx1 - gx0), H)
    }
    oc.globalCompositeOperation = 'source-over'
    oc.restore()

    // ---- 5. cast shadow of the sheet onto the page underneath
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    if (this.quality.shadow && p < 0.985) {
      const swing = dir === 'next' ? -1 : 1
      const reach = W * (0.26 + 0.12 * Math.sin(Math.PI * p))
      const edge = hingeX + swing * reach
      const g = ctx.createLinearGradient(hingeX, 0, edge, 0)
      const a = 0.03 + 0.22 * Math.sin(Math.PI * p)
      g.addColorStop(0, `rgba(0,0,0,${a})`)
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.45})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(Math.min(hingeX, edge), S.y, Math.abs(edge - hingeX), H)
    }

    // ---- 6. blit the warped leaf
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.off, 0, 0)
    ctx.restore()
  }
}

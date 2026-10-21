// ---------------------------------------------------------------------------
// Dola Toolkit — paper-curl page turn renderer (Canvas 2D)
//
// The model, written down once so it cannot drift again:
//
//   The turning leaf hinges on the BINDING. `u` is the distance along the leaf
//   from the hinge (u = 0 at the gutter, u = W at the free edge).
//     next → the right page, hinge on its left edge, leaf lies to +x
//     prev → the left page,  hinge on its right edge, leaf lies to -x
//
//   Each slice is rotated by θ(u) (growing with u) and positioned by
//   integrating the angles, so the free edge lags and the sheet arcs:
//       q(u) = ∫ cos θ ds
//       next: screen x = hingeX + q        prev: screen x = hingeX - q
//   p = 0 → leaf flat in its own half; p = 1 → leaf has landed on the far half.
//
//   FACES. While cos θ > 0 you look at the leaf's front (the page as it is now).
//   Past edge-on you look at its reverse side, which is a different page: the
//   one that ends up on the far half. That page is sampled straight from the
//   post-advance snapshot of the far half at the SAME screen position, so the
//   last frame is pixel-identical to the live page and the hand-off is seamless
//   — no mirroring, no scrambling.
//
// Shading is applied once to the finished shape (multi-stop gradient), never
// per slice, so there are no vertical seams.
// ---------------------------------------------------------------------------

export type CurlDir = 'next' | 'prev'

export interface CurlFrame {
  progress: number
  dir: CurlDir
}

export interface CurlQuality {
  strips: number
  shadow: boolean
  highlight: boolean
}

export const CURL_QUALITY: Record<'high' | 'low', CurlQuality> = {
  high: { strips: 160, shadow: true, highlight: true },
  // GPU off: fewer slices, no soft shadow / specular sweep
  low: { strips: 56, shadow: false, highlight: false }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const PAPER_FRONT: [number, number, number] = [255, 251, 254]
const PAPER_BACK: [number, number, number] = [234, 228, 237]

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private quality: CurlQuality = CURL_QUALITY.high

  /** the leaf front: snapshot of the page as it was before the turn */
  private front: HTMLImageElement | null = null
  /** the reverse side: the far half AFTER the content advanced */
  private back: HTMLImageElement | null = null
  private backRect: Rect | null = null
  /** the half the leaf still covers — kept on the old content */
  private base: Rect | null = null
  /** the turning half, canvas coordinates */
  private sheet: Rect = { x: 0, y: 0, w: 0, h: 0 }

  private off: HTMLCanvasElement
  private offCtx: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    this.off = document.createElement('canvas')
    const oc = this.off.getContext('2d')
    if (!oc) throw new Error('2D canvas unavailable')
    this.offCtx = oc
  }

  setQuality(q: CurlQuality): void {
    this.quality = q
  }

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

  setBack(img: HTMLImageElement | null, rect: Rect | null): void {
    this.back = img
    this.backRect = rect
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

  /** The half the leaf has not reached yet stays on the pre-turn content. */
  private drawBase(): void {
    const { ctx, front, base } = this
    if (!front || !base || front.naturalWidth === 0) return
    const kx = front.naturalWidth / this.cssW()
    const ky = front.naturalHeight / this.cssH()
    ctx.drawImage(front, base.x * kx, base.y * ky, base.w * kx, base.h * ky, base.x, base.y, base.w, base.h)
  }

  render(frame: CurlFrame): void {
    const p = Math.max(0, Math.min(1, frame.progress))
    this.clear()
    if (p <= 0.0005) {
      this.paintFlat()
      return
    }

    const { ctx, offCtx: oc } = this
    const S = this.sheet
    const W = S.w
    const H = S.h
    const dir = frame.dir
    const strips = this.quality.strips

    // ---- covered half: old content
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    this.drawBase()
    ctx.restore()

    // ---- bend the leaf into an offscreen buffer, unshaded
    oc.setTransform(1, 0, 0, 1, 0, 0)
    oc.clearRect(0, 0, this.off.width, this.off.height)
    oc.save()
    oc.scale(this.dpr, this.dpr)

    const hingeX = dir === 'next' ? S.x : S.x + W
    const total = Math.PI * p
    const CURL = 0.46 * Math.sin(Math.PI * Math.min(1, p * 1.05))

    const step = 1 / strips
    const q = new Float64Array(strips + 1)
    const ang = new Float64Array(strips + 1)
    let cursor = 0
    for (let i = 0; i <= strips; i++) {
      const t = i / strips
      const a = total + CURL * Math.pow(t, 1.7)
      ang[i] = a
      q[i] = cursor
      cursor += Math.cos(a) * step * W
    }

    const cssW = this.cssW()
    const cssH = this.cssH()
    const fkx = (this.front?.naturalWidth ?? 1) / cssW
    const fky = (this.front?.naturalHeight ?? 1) / cssH
    const far = this.backRect
    const farX = far?.x ?? S.x
    const farY = far?.y ?? S.y
    const bkx = (this.back?.naturalWidth ?? 1) / Math.max(1, far?.w ?? W)
    const bky = (this.back?.naturalHeight ?? 1) / Math.max(1, far?.h ?? H)

    for (let i = 0; i < strips; i++) {
      const u0 = (i / strips) * W
      const u1 = ((i + 1) / strips) * W
      const du = u1 - u0
      if (du <= 0) continue
      const a = ang[i]
      const q0 = q[i]
      const q1 = q[i + 1]
      const dw = q1 - q0
      if (Math.abs(dw) < 0.001) continue
      const isBack = Math.cos(a) < 0

      // where this slice sits on screen
      const s0 = dir === 'next' ? hingeX + q0 : hingeX - q0
      const s1 = dir === 'next' ? hingeX + q1 : hingeX - q1
      const left = Math.min(s0, s1)
      const width = Math.abs(dw) + 0.75

      oc.save()
      oc.beginPath()
      oc.rect(left, S.y, width, H)
      oc.clip()

      if (isBack) {
        /*
         * Reverse side: sample the post-advance far half at the SAME screen
         * position. At p = 1 this reproduces the live page exactly, so the
         * animation hands over to the DOM without any visual jump, and there is
         * nothing to mirror (a mirrored sample was what produced the garbled,
         * slice-shuffled look before).
         */
        if (this.back && this.back.naturalWidth > 0) {
          oc.drawImage(
            this.back,
            (left - farX) * bkx,
            (S.y - farY) * bky,
            Math.max(0.5, width * bkx),
            H * bky,
            left,
            S.y,
            width,
            H
          )
        } else {
          oc.fillStyle = `rgb(${PAPER_BACK[0]},${PAPER_BACK[1]},${PAPER_BACK[2]})`
          oc.fillRect(left, S.y, width, H)
        }
      } else {
        /*
         * Front face: sample the leaf along u from the hinge.
         *   next: u grows with x, so the slice is drawn un-flipped
         *   prev: u grows against x, so the slice is mirrored about itself
         */
        if (this.front && this.front.naturalWidth > 0) {
          const srcX = (S.x + u0) * fkx
          const srcW = Math.max(0.5, du * fkx)
          if (dir === 'next') {
            oc.drawImage(this.front, srcX, S.y * fky, srcW, H * fky, left, S.y, width, H)
          } else {
            oc.translate(left + width, 0)
            oc.scale(-1, 1)
            oc.drawImage(this.front, srcX, S.y * fky, srcW, H * fky, 0, S.y, width, H)
          }
        } else {
          oc.fillStyle = `rgb(${PAPER_FRONT[0]},${PAPER_FRONT[1]},${PAPER_FRONT[2]})`
          oc.fillRect(left, S.y, width, H)
        }
      }
      oc.restore()
    }

    // ---- shade the finished shape ONCE (no per-slice seams)
    const gx0 = dir === 'next' ? hingeX : hingeX - W
    const gx1 = dir === 'next' ? hingeX - W : hingeX + W
    const grad = oc.createLinearGradient(gx0, 0, gx1, 0)
    const stops = 32
    for (let k = 0; k <= stops; k++) {
      const t = k / stops
      const i = Math.min(strips, Math.round(t * strips))
      const facing = Math.abs(Math.cos(ang[i]))
      const isBack = Math.cos(ang[i]) < 0
      const alpha = isBack ? 0.12 + 0.28 * (1 - facing) : 0.32 * (1 - facing)
      const tint = isBack ? '94,84,102' : '0,0,0'
      const stop = dir === 'next' ? 1 - t : t
      grad.addColorStop(Math.max(0, Math.min(1, stop)), `rgba(${tint},${alpha.toFixed(3)})`)
    }
    oc.globalCompositeOperation = 'source-atop'
    oc.fillStyle = grad
    oc.fillRect(Math.min(gx0, gx1), S.y, W, H)

    if (this.quality.highlight) {
      const hx = dir === 'next' ? hingeX - W * 0.3 : hingeX + W * 0.3
      const spec = oc.createLinearGradient(hingeX, 0, hx, 0)
      const a = 0.28 * Math.sin(Math.PI * p)
      spec.addColorStop(0, `rgba(255,255,255,${a})`)
      spec.addColorStop(1, 'rgba(255,255,255,0)')
      oc.fillStyle = spec
      oc.fillRect(Math.min(hingeX, hx), S.y, Math.abs(hx - hingeX), H)
    }
    oc.globalCompositeOperation = 'source-over'
    oc.restore()

    // ---- shadow onto the page underneath, then blit the leaf
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    if (this.quality.shadow && p < 0.985) {
      const swing = dir === 'next' ? -1 : 1
      const reach = W * (0.24 + 0.12 * Math.sin(Math.PI * p))
      const edge = hingeX + swing * reach
      const g = ctx.createLinearGradient(hingeX, 0, edge, 0)
      const a = 0.03 + 0.2 * Math.sin(Math.PI * p)
      g.addColorStop(0, `rgba(0,0,0,${a})`)
      g.addColorStop(0.6, `rgba(0,0,0,${a * 0.4})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(Math.min(hingeX, edge), S.y, Math.abs(edge - hingeX), H)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.off, 0, 0)
    ctx.restore()
  }

  /** p = 0: the leaf flat in its own half, straight from `front`. */
  private paintFlat(): void {
    const { ctx, front } = this
    const S = this.sheet
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    this.drawBase()
    if (front && front.naturalWidth > 0) {
      const kx = front.naturalWidth / this.cssW()
      const ky = front.naturalHeight / this.cssH()
      ctx.drawImage(front, S.x * kx, S.y * ky, S.w * kx, S.h * ky, S.x, S.y, S.w, S.h)
    } else {
      ctx.fillStyle = `rgb(${PAPER_FRONT[0]},${PAPER_FRONT[1]},${PAPER_FRONT[2]})`
      ctx.fillRect(S.x, S.y, S.w, S.h)
    }
    ctx.restore()
  }
}

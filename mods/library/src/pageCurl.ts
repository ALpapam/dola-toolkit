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
//   p = 0 → leaf flat over its own half; p = 1 → landed on the far half.
//
// FACES — and why only ONE screenshot is needed:
//
//   · The FRONT face (cos θ > 0) is the page as it looked before the turn, so
//     it is drawn from a snapshot taken BEFORE the content advanced. That
//     snapshot is taken while the page is unchanged, so it never causes a
//     visible jump.
//   · The BACK face (cos θ < 0) is the printed reverse side, which is exactly
//     the page that now sits on the far half — already rendered in the DOM.
//     So it is simply LEFT TRANSPARENT and the live page shows through, with a
//     faint shadow to sell the paper. No second screenshot, which removes both
//     the "content jumps before the animation" gap and the grey blank sheet
//     that appeared when that capture was slow or rejected.
//   · The half not yet reached by the leaf is painted from the pre-turn
//     snapshot, CLIPPED to the area the leaf has not covered, so it stays on
//     the old content until the sheet sweeps over it.
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

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private quality: CurlQuality = CURL_QUALITY.high

  /** the leaf front: snapshot taken BEFORE the content advanced */
  private front: HTMLImageElement | null = null
  /** the half the leaf still covers — stays on the old content, clipped */
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

  setLayers(front: HTMLImageElement | null, sheet: Rect, base: Rect | null): void {
    this.front = front
    this.sheet = sheet
    this.base = base
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

  /**
   * Paints part of the pre-turn snapshot.
   * @param clip optional sub-rectangle of `rect` that may be drawn
   */
  private blitSnap(rect: Rect, clip?: Rect): void {
    const { ctx, front } = this
    if (!front || front.naturalWidth === 0) return
    const kx = front.naturalWidth / this.cssW()
    const ky = front.naturalHeight / this.cssH()
    ctx.save()
    if (clip) {
      ctx.beginPath()
      ctx.rect(clip.x, clip.y, Math.max(0, clip.w), Math.max(0, clip.h))
      ctx.clip()
    }
    ctx.drawImage(front, rect.x * kx, rect.y * ky, rect.w * kx, rect.h * ky, rect.x, rect.y, rect.w, rect.h)
    ctx.restore()
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

    /*
     * Single-page mode has no second half to catch the leaf, so its swept part
     * would otherwise fly out of the page into the stage margin — which reads as
     * "the turn starts in the middle of the window". Clipping every frame to the
     * page rectangle keeps the whole animation inside the paper: it peels from
     * the outer edge and folds away at the binding, the way a lone sheet does.
     */
    ctx.save()
    if (!this.base) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.beginPath()
      ctx.rect(S.x, S.y, S.w, S.h)
      ctx.clip()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }

    const hingeX = dir === 'next' ? S.x : S.x + W
    const total = Math.PI * p
    // the free edge curls further than the hinge — that is what makes paper arc
    const CURL = 0.46 * Math.sin(Math.PI * Math.min(1, p * 1.05))

    const step = 1 / strips
    const q = new Float64Array(strips + 1)
    const ang = new Float64Array(strips + 1)
    let cursor = 0
    let qMin = 0
    for (let i = 0; i <= strips; i++) {
      const t = i / strips
      const a = total + CURL * Math.pow(t, 1.7)
      ang[i] = a
      q[i] = cursor
      if (cursor < qMin) qMin = cursor
      cursor += Math.cos(a) * step * W
    }

    /* ---- 1. the half not yet reached: old content, clipped to the part the
       leaf has NOT covered. Past the leaf's leading edge the live (new) page
       must show, because that area is the leaf's reverse side. */
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    if (this.base) {
      const lead = hingeX + qMin // leftmost point reached by the leaf (next)
      if (dir === 'next') {
        const baseRight = this.base.x + this.base.w
        const uncoverW = Math.min(baseRight, lead) - this.base.x
        if (uncoverW > 0.5) this.blitSnap(this.base, { x: this.base.x, y: S.y, w: uncoverW, h: H })
      } else {
        const leadRight = hingeX - qMin
        const uncoverX = Math.max(this.base.x, leadRight)
        const uncoverW = this.base.x + this.base.w - uncoverX
        if (uncoverW > 0.5) this.blitSnap(this.base, { x: uncoverX, y: S.y, w: uncoverW, h: H })
      }
    }
    ctx.restore()

    /* ---- 2. bend the leaf front into an offscreen buffer (unshaded) */
    oc.setTransform(1, 0, 0, 1, 0, 0)
    oc.clearRect(0, 0, this.off.width, this.off.height)
    oc.save()
    oc.scale(this.dpr, this.dpr)

    const cssW = this.cssW()
    const cssH = this.cssH()
    const fkx = (this.front?.naturalWidth ?? 1) / cssW
    const fky = (this.front?.naturalHeight ?? 1) / cssH

    for (let i = 0; i < strips; i++) {
      const u0 = (i / strips) * W
      const u1 = ((i + 1) / strips) * W
      const du = u1 - u0
      if (du <= 0) continue
      const a = ang[i]
      // reverse side: leave it transparent so the live new page shows through
      if (Math.cos(a) < 0) continue
      const q0 = q[i]
      const q1 = q[i + 1]
      const dw = q1 - q0
      if (Math.abs(dw) < 0.001) continue

      const s0 = dir === 'next' ? hingeX + q0 : hingeX - q0
      const s1 = dir === 'next' ? hingeX + q1 : hingeX - q1
      const left = Math.min(s0, s1)
      const width = Math.abs(dw) + 0.75

      oc.save()
      oc.beginPath()
      oc.rect(left, S.y, width, H)
      oc.clip()
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
      oc.restore()
    }

    /* ---- 3. shade the front shape once (no per-slice seams) */
    const gx0 = dir === 'next' ? hingeX : hingeX - W
    const gx1 = dir === 'next' ? hingeX - W : hingeX + W
    const grad = oc.createLinearGradient(gx0, 0, gx1, 0)
    const stops = 32
    for (let k = 0; k <= stops; k++) {
      const t = k / stops
      const i = Math.min(strips, Math.round(t * strips))
      const facing = Math.abs(Math.cos(ang[i]))
      const alpha = 0.32 * (1 - facing)
      const stop = dir === 'next' ? 1 - t : t
      grad.addColorStop(Math.max(0, Math.min(1, stop)), `rgba(0,0,0,${alpha.toFixed(3)})`)
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

    /* ---- 4. shadow cast by the leaf onto the page underneath, then the leaf */
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
    // the reverse side: only a faint tint, so the new page behind stays legible
    const backSpan = dir === 'next' ? hingeX - (hingeX + qMin) : hingeX - qMin - hingeX
    const backX = dir === 'next' ? hingeX + qMin : hingeX
    if (backSpan > 1) {
      ctx.fillStyle = `rgba(90,80,98,${0.06 + 0.06 * Math.sin(Math.PI * p)})`
      ctx.fillRect(backX, S.y, backSpan, H)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.off, 0, 0)
    ctx.restore()
    // closes the single-page clip opened at the top of render()
    ctx.restore()
  }

  /** p = 0: the leaf flat over its own half — full coverage of the old spread. */
  private paintFlat(): void {
    const { ctx } = this
    const S = this.sheet
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    if (this.base) this.blitSnap(this.base)
    this.blitSnap(S)
    ctx.restore()
  }
}

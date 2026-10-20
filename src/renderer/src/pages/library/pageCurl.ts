// ---------------------------------------------------------------------------
// Dola Toolkit — paper-curl page turn renderer (Canvas 2D)
//
// Three layers, like a real book (and like SlimeNull/PageTurningEffect):
//
//   base patch  the half of the OLD spread that must stay visible while the
//               sheet sweeps over it (its source pixels are snapshotted before
//               the content advances)
//   sheet       the page being turned, drawn back as vertical strips whose
//               angles increase away from the binding, so it actually bends
//   live DOM    the ALREADY-RENDERED next spread, showing through wherever the
//               canvas is transparent
//
// The next spread is committed before the animation starts, so there is no
// "wait then jump" at the end — the new page is on screen the whole time.
//
// Everything is plain Canvas 2D and therefore works with hardware acceleration
// disabled; only the strip count and the soft shading change.
// ---------------------------------------------------------------------------

export type CurlDir = 'next' | 'prev'

export interface CurlFrame {
  /** 0 = sheet flat over its own half, 1 = sheet has landed on the far side */
  progress: number
  dir: CurlDir
}

export interface CurlQuality {
  /** vertical strips used to bend the sheet */
  strips: number
  /** draw the soft cast shadow on the page underneath */
  shadow: boolean
  /** draw the specular highlight along the fold */
  highlight: boolean
}

export const CURL_QUALITY: Record<'high' | 'low', CurlQuality> = {
  high: { strips: 110, shadow: true, highlight: true },
  // GPU off: far fewer strips and no soft shadow — those two dominate software
  // rasterisation cost. The motion is identical.
  low: { strips: 40, shadow: false, highlight: false }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const PAPER = '#fffbfe'
const PAPER_BACK = '#ece6ef'

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private quality: CurlQuality = CURL_QUALITY.high

  /** the snapshot the sheet and base patch are cut from */
  private snap: HTMLImageElement | null = null
  /** rect of the sheet (the half that turns) inside the canvas, CSS px */
  private sheet: Rect = { x: 0, y: 0, w: 0, h: 0 }
  /** rect of the base patch (the half that stays), CSS px */
  private base: Rect | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
  }

  setQuality(q: CurlQuality): void {
    this.quality = q
  }

  /**
   * @param snap  stage-sized screenshot taken BEFORE the page advanced
   * @param sheet the turning half, in canvas CSS px
   * @param base  the half that must keep showing the OLD content, or null
   */
  setLayers(snap: HTMLImageElement | null, sheet: Rect, base: Rect | null): void {
    this.snap = snap
    this.sheet = sheet
    this.base = base
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = Math.max(1, Math.min(dpr, 2))
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr))
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr))
    this.canvas.style.width = `${cssWidth}px`
    this.canvas.style.height = `${cssHeight}px`
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /** Draws the still-old half so it does not flick to the new page too early. */
  private drawBase(): void {
    const { ctx, snap, base } = this
    if (!snap || !base) return
    // the snapshot is stage-sized; work out the ratio between image and CSS px
    const sx = snap.naturalWidth / (this.canvas.width / this.dpr)
    const sy = snap.naturalHeight / (this.canvas.height / this.dpr)
    ctx.drawImage(
      snap,
      base.x * sx,
      base.y * sy,
      base.w * sx,
      base.h * sy,
      base.x,
      base.y,
      base.w,
      base.h
    )
  }

  render(frame: CurlFrame): void {
    const { ctx } = this
    const { strips, shadow, highlight } = this.quality
    const p = Math.max(0, Math.min(1, frame.progress))
    this.clear()
    if (p <= 0.0001) return

    ctx.save()
    ctx.scale(this.dpr, this.dpr)

    // --- old half stays put until the sheet sweeps over it
    this.drawBase()

    const S = this.sheet
    const W = S.w
    const H = S.h
    const dir = frame.dir

    /*
     * The hinge is the binding: the sheet's INNER edge.
     *   next — the right page: hinge at its left edge, lying to the +x side at
     *          rest and swinging over to the -x side as it turns
     *   prev — the left page:  hinge at its right edge, mirror image
     */
    const hingeX = dir === 'next' ? S.x : S.x + W

    /*
     * total rotation is half a turn; the free edge bends further so the paper
     * arcs. Angles are integrated to positions, which is what makes the sheet
     * read as curved rather than a rigid card.
     */
    const total = Math.PI * p
    const CURL = 0.5 * Math.sin(Math.PI * Math.min(1, p * 1.15))
    const step = 1 / strips
    const pos: number[] = new Array(strips + 1)
    const ang: number[] = new Array(strips + 1)
    let cursor = 0
    for (let i = 0; i <= strips; i++) {
      const t = i / strips
      const a = total + CURL * Math.pow(t, 1.6)
      ang[i] = a
      pos[i] = cursor
      cursor += Math.cos(a) * step * W
    }

    const snap = this.snap
    // snapshot is stage-sized; convert canvas CSS px -> image px
    const scaleX = snap ? snap.naturalWidth / (this.canvas.width / this.dpr) : 1
    const scaleY = snap ? snap.naturalHeight / (this.canvas.height / this.dpr) : 1
    const srcX = S.x * scaleX
    const srcY = S.y * scaleY
    const srcH = H * scaleY
    const colW = (W * scaleX) / strips

    // --- cast shadow, cast onto the half the sheet is sweeping over
    if (shadow && p < 0.98) {
      const reach = W * (0.22 + 0.1 * Math.sin(Math.PI * p))
      const swingSign = dir === 'next' ? -1 : 1
      const edge = hingeX + swingSign * reach
      const g = ctx.createLinearGradient(hingeX, 0, edge, 0)
      g.addColorStop(0, `rgba(0,0,0,${0.02 + 0.2 * Math.sin(Math.PI * p)})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(Math.min(hingeX, edge), S.y, Math.abs(edge - hingeX), H)
    }

    // --- the sheet, strip by strip
    for (let i = 0; i < strips; i++) {
      const a = ang[i]
      const x0 = pos[i]
      const x1 = pos[i + 1]
      const dw = x1 - x0
      if (Math.abs(dw) < 0.02) continue

      const back = Math.cos(a) < 0
      const facing = Math.abs(Math.cos(a))

      ctx.save()
      // Place the strip. `next` grows away from the hinge on +x; `prev` is the
      // mirror image, which is why it also needs the horizontal flip.
      if (dir === 'next') {
        ctx.translate(hingeX + x0, S.y)
      } else {
        ctx.translate(hingeX - x0, S.y)
        ctx.scale(-1, 1)
      }
      if (back) {
        // seeing the reverse side: mirror the strip about its own centre
        ctx.translate(Math.abs(dw), 0)
        ctx.scale(-1, 1)
      }

      if (snap && snap.naturalWidth > 0) {
        ctx.drawImage(snap, srcX + i * colW, srcY, Math.max(0.5, colW), srcH, 0, 0, Math.abs(dw) + 0.6, H)
        ctx.globalCompositeOperation = 'source-atop'
        if (back) {
          ctx.fillStyle = `rgba(118,108,124,${0.18 + 0.34 * (1 - facing)})`
        } else {
          ctx.fillStyle = `rgba(0,0,0,${(1 - facing) * 0.4})`
        }
        ctx.fillRect(-1, 0, Math.abs(dw) + 2, H)
        ctx.globalCompositeOperation = 'source-over'
      } else {
        // no snapshot yet: honest paper, so the motion still reads
        const lit = 0.45 + 0.55 * facing
        ctx.fillStyle = back
          ? PAPER_BACK
          : `rgb(${Math.round(255 * lit + 40 * (1 - lit))},${Math.round(251 * lit + 40 * (1 - lit))},${Math.round(254 * lit + 44 * (1 - lit))})`
        ctx.fillRect(-0.5, 0, Math.abs(dw) + 1, H)
      }

      // bright specular line right at the fold
      if (highlight && i < strips * 0.1) {
        const t = 1 - i / (strips * 0.1)
        ctx.fillStyle = `rgba(255,255,255,${0.4 * t * Math.sin(Math.PI * p)})`
        ctx.fillRect(-0.5, 0, Math.abs(dw) + 1, H)
      }
      ctx.restore()
    }

    ctx.restore()
  }
}

export { PAPER }

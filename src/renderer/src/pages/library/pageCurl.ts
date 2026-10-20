// ---------------------------------------------------------------------------
// Dola Toolkit — paper-curl page turn renderer (Canvas 2D)
//
// Why a rewrite: the previous implementation rotated a flat DOM rectangle with
// CSS 3D. That can only ever look like a card pivoting, and it forced ugly
// workarounds (a translucent overlay for EPUB, content escaping the stage box).
//
// This engine rasterises the page once per turn and then bends the sheet as a
// strip-wise curve, which is how a real book page behaves:
//   · the sheet is hinged at the gutter (its inner edge)
//   · each vertical strip is rotated a little more than the one before it, so
//     the free edge lags and the paper reads as curved
//   · strips facing away from the light are drawn as the page's BACK (mirrored
//     and darkened), so the flip-over is visible
//   · a soft shadow is cast onto the page underneath, strongest at the fold
//
// Everything is plain Canvas 2D, so it stays usable with hardware acceleration
// disabled (quality/strip count is the only thing that changes).
// ---------------------------------------------------------------------------

export type CurlDir = 'next' | 'prev'

export interface CurlFrame {
  /** 0 = flat, 1 = sheet has landed on the far side */
  progress: number
  dir: CurlDir
}

export interface CurlQuality {
  /** number of vertical strips used to bend the sheet */
  strips: number
  /** draw the cast shadow on the page underneath */
  shadow: boolean
  /** draw the specular highlight along the fold */
  highlight: boolean
}

export const CURL_QUALITY: Record<'high' | 'low', CurlQuality> = {
  // GPU on: plenty of strips, full shading
  high: { strips: 110, shadow: true, highlight: true },
  // GPU off: fewer strips and no soft shadow — the two things that dominate
  // software rasterisation cost — while keeping the motion identical
  low: { strips: 40, shadow: false, highlight: false }
}

/** Paper tone used for the back of the sheet and when no snapshot is available. */
const PAPER = '#fffbfe'
const PAPER_DARK = '#efe9f2'

function isBackFace(angle: number): boolean {
  // cos < 0 means the strip has turned past edge-on: we see the reverse side
  return Math.cos(angle) < 0
}

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private quality: CurlQuality = CURL_QUALITY.high

  /** the page being turned (front face) */
  private sheet: HTMLImageElement | null = null
  /** the page revealed underneath; not required, the live DOM shows through */
  private under: HTMLImageElement | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
  }

  setQuality(q: CurlQuality): void {
    this.quality = q
  }

  /** Images are optional: without them the sheet is drawn as plain paper. */
  setImages(sheet: HTMLImageElement | null, under: HTMLImageElement | null): void {
    this.sheet = sheet
    this.under = under
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

  /**
   * Draw one frame.
   *
   * `bounds` is the sheet's rectangle inside the canvas (CSS px): the right
   * half in a spread, the whole page when single.
   */
  render(frame: CurlFrame, bounds: { x: number; y: number; w: number; h: number }): void {
    const { ctx } = this
    const { strips, shadow, highlight } = this.quality
    const p = Math.max(0, Math.min(1, frame.progress))
    this.clear()

    if (p <= 0.0001) return

    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    ctx.translate(bounds.x, bounds.y)

    const W = bounds.w
    const H = bounds.h
    const dir = frame.dir

    /*
     * Total rotation of the hinge is PI (half a turn). The free edge bends a
     * further `CURL` radians so the sheet arcs instead of staying rigid.
     * `next` swings the right page leftwards over the left page; `prev` mirrors.
     */
    const total = Math.PI * p
    const CURL = 0.55 * Math.sin(Math.PI * Math.min(1, p * 1.15))

    // Integrate the strip angles into screen positions.
    const dStep = 1 / strips
    const xs: number[] = new Array(strips + 1)
    const angles: number[] = new Array(strips + 1)
    let cursor = 0
    for (let i = 0; i <= strips; i++) {
      const t = i / strips
      // near the hinge the sheet barely bends; the free edge curls the most
      const a = total + CURL * Math.pow(t, 1.6)
      angles[i] = a
      xs[i] = cursor
      cursor += Math.cos(a) * dStep * W
    }

    // The sheet is drawn in its own space where x grows away from the hinge.
    // For `prev` we mirror the whole thing so it peels from the other side.
    const mirrored = dir === 'prev'
    if (mirrored) {
      ctx.translate(W, 0)
      ctx.scale(-1, 1)
    }

    // ---- cast shadow on the page underneath (drawn first, behind the sheet)
    if (shadow && p < 0.98) {
      const foldX = xs[strips]
      const shade = ctx.createLinearGradient(Math.min(0, foldX) - W * 0.28, 0, Math.max(0, foldX), 0)
      shade.addColorStop(0, 'rgba(0,0,0,0)')
      shade.addColorStop(0.65, `rgba(0,0,0,${0.10 + 0.16 * Math.sin(Math.PI * p)})`)
      shade.addColorStop(1, `rgba(0,0,0,${0.06 + 0.12 * Math.sin(Math.PI * p)})`)
      ctx.fillStyle = shade
      ctx.fillRect(Math.min(0, foldX) - W * 0.3, 0, W * 0.3 + Math.abs(foldX) + W * 0.02, H)
    }

    // ---- the sheet itself, strip by strip
    for (let i = 0; i < strips; i++) {
      const x0 = xs[i]
      const x1 = xs[i + 1]
      const w = x1 - x0
      if (Math.abs(w) < 0.02) continue

      const a = angles[i]
      const back = isBackFace(a)
      // how squarely the strip faces the viewer: drives the shading
      const facing = Math.abs(Math.cos(a))

      const sx = (i / strips) * (this.sheet?.naturalWidth ?? 1)
      const sw = (1 / strips) * (this.sheet?.naturalWidth ?? 1)

      ctx.save()
      // Mirroring the strip when we see its reverse side is what makes the
      // page look like it flipped over rather than vanished.
      if (back) {
        ctx.translate(x0 + x1, 0)
        ctx.scale(-1, 1)
      }

      if (this.sheet && this.sheet.complete && this.sheet.naturalWidth > 0) {
        const srcH = this.sheet.naturalHeight
        const destH = H * (1 - 0.02 * Math.sin(Math.PI * p) * (i / strips))
        ctx.drawImage(this.sheet, sx, 0, sw, srcH, back ? 0 : x0, 0, Math.abs(w), destH)
        // the back of the paper is slightly darker / tinted
        if (back) {
          ctx.globalCompositeOperation = 'source-atop'
          ctx.fillStyle = `rgba(120,110,125,${0.22 + 0.3 * (1 - facing)})`
          ctx.fillRect(0, 0, Math.abs(w) + 1, H)
          ctx.globalCompositeOperation = 'source-over'
        } else if (facing < 0.999) {
          ctx.globalCompositeOperation = 'source-atop'
          ctx.fillStyle = `rgba(0,0,0,${(1 - facing) * 0.42})`
          ctx.fillRect(0, 0, Math.abs(w) + 1, H)
          ctx.globalCompositeOperation = 'source-over'
        }
      } else {
        // no snapshot: draw an honest paper sheet so the motion still reads
        const lit = 0.5 + 0.5 * facing
        ctx.fillStyle = back
          ? PAPER_DARK
          : mixHex(PAPER, '#000000', (1 - lit) * 0.35)
        ctx.fillRect(back ? 0 : x0, 0, Math.abs(w) + 0.6, H)
      }

      // specular band right at the fold
      if (highlight && i < strips * 0.12) {
        const t = 1 - i / (strips * 0.12)
        ctx.fillStyle = `rgba(255,255,255,${0.42 * t * Math.sin(Math.PI * p)})`
        ctx.fillRect(back ? 0 : x0, 0, Math.abs(w) + 0.6, H)
      }
      ctx.restore()
    }

    ctx.restore()
  }
}

/** Small hex lerp used for the fallback paper shading. */
function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * k)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * k)
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * k)
  return `rgb(${r},${g},${bl})`
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = Number.parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

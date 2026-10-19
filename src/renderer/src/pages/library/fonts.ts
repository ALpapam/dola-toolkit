// ---------------------------------------------------------------------------
// Dola Toolkit — reader font loading (renderer)
//
// Fonts are served from the custom `dola-font://` scheme by the main process.
// This module turns the current selection into:
//   * a CSS value for `--font-reading` (prose pages, probe, headers)
//   * an @font-face stylesheet string that is also injected into EPUB iframes
//     (epub.js Documents are separate documents — they do not inherit the
//      app stylesheet, so the family must be injected explicitly).
// ---------------------------------------------------------------------------

import type { FontFace } from '@shared/types'
import {
  DEFAULT_READER_FONT_FAMILY,
  DEFAULT_READER_FONT_ID,
  SYSTEM_FONT_ID,
  SYSTEM_READING_STACK,
  cssFamily
} from '@shared/fonts'

/** Structural superset of the store's LoadedFontInfo: only these fields matter. */
export interface LoadedFont {
  id: string
  name: string
  builtin: boolean
  format: string
  url?: string | null
  size?: number
  path?: string
  managed?: boolean
}

const STYLE_ID = 'dola-reader-fonts'

/** Google-fonts style URL for a font file: url + format hint. */
function srcFor(font: LoadedFont): string {
  if (!font.url) return ''
  const fmt =
    font.format === 'woff2'
      ? 'woff2'
      : font.format === 'woff'
        ? 'woff'
        : font.format === 'otf'
          ? 'opentype'
          : font.format === 'ttc'
            ? 'truetype'
            : 'truetype'
  return `url("${font.url}") format("${fmt}")`
}

/**
 * Builds @font-face rules for every available family.
 * Regular + bold faces are declared so `<strong>` renders natively.
 */
export function buildFontFaceCss(fonts: LoadedFont[]): string {
  const rules: string[] = []

  for (const font of fonts) {
    const src = srcFor(font)
    if (!src) continue
    const family = font.builtin ? DEFAULT_READER_FONT_FAMILY : font.name
    rules.push(
      `@font-face{font-family:${cssFamily(family)};src:${src};` +
        `font-weight:400;font-style:normal;font-display:swap}`
    )
    // The bundled family ships a real Bold file; user fonts just get synthetic bold.
    if (font.builtin && font.url) {
      const boldUrl = font.url.replace('-Regular.', '-Bold.')
      if (boldUrl !== font.url) {
        rules.push(
          `@font-face{font-family:${cssFamily(family)};src:` +
            `url("${boldUrl}") format("woff2");` +
            `font-weight:700;font-style:normal;font-display:swap}`
        )
      }
    }
  }
  return rules.join('\n')
}

/** Install/refresh the app-wide @font-face sheet and return the CSS text. */
export function installFontFaces(fonts: LoadedFont[]): string {
  const css = buildFontFaceCss(fonts)
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
  return css
}

/** The `font-family` value to apply to book text. */
export function resolveReadingFamily(familyId: string, fonts: LoadedFont[]): string {
  if (!familyId || familyId === SYSTEM_FONT_ID) return SYSTEM_READING_STACK
  const font = fonts.find((f) => f.id === familyId)
  if (!font) {
    // selection vanished (font deleted) → fall back to the bundled default
    const fallback = fonts.find((f) => f.id === DEFAULT_READER_FONT_ID)
    if (fallback) return `${cssFamily(DEFAULT_READER_FONT_FAMILY)}, ${SYSTEM_READING_STACK}`
    return SYSTEM_READING_STACK
  }
  const family = font.builtin ? DEFAULT_READER_FONT_FAMILY : font.name
  return `${cssFamily(family)}, ${SYSTEM_READING_STACK}`
}

/** CSS injected into every EPUB chapter document. */
export function epubFontCss(familyId: string, fonts: LoadedFont[], fontSize: number): string {
  const faces = buildFontFaceCss(fonts)
  const family = resolveReadingFamily(familyId, fonts)
  return [
    faces,
    `html, body, p, div, span, li, dd, dt, blockquote, td {`,
    `  font-family: ${family} !important;`,
    `}`,
    `body { font-size: ${fontSize}px; }`,
    `h1, h2, h3, h4, h5, h6 { font-family: ${family} !important; }`
  ].join('\n')
}

/**
 * Applies the selected family to the WHOLE application, not just books.
 *
 * The design tokens build `--font-ui` / `--font-display` / `--font-mono` /
 * `--font-reading` on top of `--app-font`, so setting that one variable
 * restyles the rail, title bar, settings, dialogs and the reader at once.
 * The system-font option clears it so the native stacks take over again.
 */
export function applyAppFont(familyId: string, fonts: LoadedFont[]): void {
  const root = document.documentElement
  if (!familyId || familyId === SYSTEM_FONT_ID) {
    root.style.setProperty('--app-font', '')
    return
  }
  const font = fonts.find((f) => f.id === familyId)
  const family = font ? (font.builtin ? DEFAULT_READER_FONT_FAMILY : font.name) : ''
  // quoted family with a trailing comma so it composes with the fallback stacks
  root.style.setProperty('--app-font', family ? `${cssFamily(family)},` : '')
}

export { DEFAULT_READER_FONT_ID, SYSTEM_FONT_ID }

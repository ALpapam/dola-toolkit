// ---------------------------------------------------------------------------
// Dola Toolkit — reader font constants (shared by main + renderer).
//
// The app ships one default family so first-run books already look right:
// the user-supplied JetBrains Maple Mono NF (a JetBrains Mono + Maple Mono
// Nerd Font merge with full CJK coverage).
// ---------------------------------------------------------------------------

/** id of the bundled default font; "system" means the built-in reading stack */
export const DEFAULT_READER_FONT_ID = 'builtin:jetbrains-maple-mono-nf'

/** pseudo-id for "use the system serif/sans stack" */
export const SYSTEM_FONT_ID = 'system'

/** family name declared in the bundled @font-face rules */
export const DEFAULT_READER_FONT_FAMILY = 'JetBrains Maple Mono NF'

/** Fallback reading stack used when the user picks the system font. */
export const SYSTEM_READING_STACK =
  "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', 'SimSun', Georgia, serif"

export const FONT_FILE_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2', '.ttc'] as const

/** Accepts a path and reports whether it is a supported font file. */
export function fontFormatOf(path: string): 'ttf' | 'otf' | 'woff' | 'woff2' | 'ttc' | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ttf')) return 'ttf'
  if (lower.endsWith('.otf')) return 'otf'
  if (lower.endsWith('.woff2')) return 'woff2'
  if (lower.endsWith('.woff')) return 'woff'
  if (lower.endsWith('.ttc')) return 'ttc'
  return null
}

/** Turns a family name into a CSS `font-family` entry. */
export function cssFamily(name: string): string {
  return `'${name.replace(/'/g, "\\'")}'`
}

// epub.js is loaded lazily and typed loosely: the shipped typings are incomplete
// and the library is untyped at runtime. Keeping the surface small here makes the
// reader code readable and keeps `any` out of the rest of the app.

/** Below this container width epub.js must render a single column. */
export const MIN_SPREAD_WIDTH = 900

export interface EpubRendition {
  display(target?: string | Element): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  destroy(): void
  themes: {
    register(themeObject: object): void
    select(name: string): void
    fontSize(size: string): void
    override(name: string, value: string): void
    default(theme: object | string): void
  }
  on(event: string, cb: (...args: unknown[]) => void): void
  hooks: {
    content: {
      register(cb: (contents: unknown) => void): void
    }
  }
  currentLocation(): unknown
  spread(mode: 'none' | 'auto' | 'both', min?: number): void
  flow(mode: string): void
  layout(settings: { flow?: string; spread?: string; width?: number; height?: number }): void
  resize(width?: number, height?: number): void
  book: unknown
}

export interface EpubBook {
  ready: Promise<void>
  loaded: { metadata: Promise<{ title?: string; creator?: string; language?: string }> }
  coverUrl(): Promise<string | null>
  renderTo(element: Element | string, options?: Record<string, unknown>): EpubRendition
  destroy(): void
  spine: {
    length: number
    each(cb: (item: { href: string; index: number }) => void): void
    get(target?: unknown): { href: string; index: number } | null
  }
  locations: {
    generate(chars: number): Promise<unknown>
    length(): number
    percentageFromCfi(cfi: string): number
    cfiFromPercentage(pct: number): string
    locationFromCfi(cfi: string): unknown
  }
}

interface EpubFactory {
  (opts: Record<string, unknown>): EpubBook
}

import Epub from 'epubjs'

/**
 * epub.js calls `btoa(content)` in `createBase64Url` when `replacements:'base64'`
 * is enabled. `btoa` only accepts Latin-1, so any stylesheet or SVG containing
 * CJK text throws `InvalidCharacterError` and the whole chapter fails to render
 * (this NGNL set has Chinese text inside its CSS). Installing a UTF-8 aware
 * `btoa` is the smallest correct fix and keeps epub.js' behaviour otherwise.
 */
function installUtf8Btoa(): void {
  const w = window as unknown as { btoa: (s: string) => string; __dolaBtoaPatched?: boolean }
  if (w.__dolaBtoaPatched) return
  const native = w.btoa.bind(window)
  w.btoa = (input: string): string => {
    // Fast path: pure Latin-1 can go straight through.
    if (/^[\u0000-\u00ff]*$/.test(input)) return native(input)
    const bytes = new TextEncoder().encode(input)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return native(binary)
  }
  w.__dolaBtoaPatched = true
}

installUtf8Btoa()

let factoryPromise: Promise<EpubFactory> | null = null

async function getFactory(): Promise<EpubFactory> {
  if (!factoryPromise) {
    // Static import is required: a bare `import('epubjs')` is left untouched by
    // the bundler's dynamic-import analysis and then fails at runtime with
    // "Failed to resolve module specifier".
    factoryPromise = Promise.resolve(Epub as unknown as EpubFactory)
  }
  return factoryPromise
}

/**
 * EPUB rendering is delegated to epub.js — the same engine Cloudreve's built-in
 * reader uses. It owns the archive and rewrites every resource reference, so
 * `../Images/001.jpg` style paths resolve correctly and illustrations load.
 *
 * `replacements: 'base64'` inlines each resource as a data URL, which is the
 * setting that makes image loading deterministic inside a `file://` page.
 */
export function configureRendition(
  rendition: EpubRendition,
  opts: { width: number; height: number; spread: 'none' | 'auto' | 'both'; theme: 'light' | 'dark'; fontSize: number }
): void {
  // Typography only. Geometry is owned by `rendition.resize()` / the manager:
  // passing an explicit width here made epub.js compute `columnWidth = width/2 - gap`
  // from the *container* width while the iframe was the full container, so the
  // columns overflowed sideways and the page looked blank.
  rendition.themes.register({
    light: { body: { color: '#1d1b20', background: 'transparent', 'font-family': 'serif' } },
    dark: { body: { color: '#e6e0e9', background: 'transparent', 'font-family': 'serif' } }
  })
  rendition.themes.select(opts.theme)
  rendition.themes.fontSize(`${opts.fontSize}px`)
  // minSpreadWidth keeps two columns from being forced into a narrow window.
  rendition.spread(opts.spread, MIN_SPREAD_WIDTH)
  rendition.flow('paginated')
  // Geometry must be given to epub.js here: the manager computes its column
  // widths from this call, and without it the first render can attach a view
  // with the wrong page size (blank paper until the next resize).
  rendition.layout({ flow: 'paginated', spread: opts.spread, width: opts.width, height: opts.height })
}

/** Open an EPUB held in memory (our managed-library copy, delivered as base64). */
export async function openEpubFromBase64(base64: string): Promise<EpubBook> {
  const factory = await getFactory()
  // `blobUrl` (epub.js' default) is deliberate:
  //  - it never calls btoa, so CJK inside stylesheets cannot throw
  //    InvalidCharacterError (the failure mode of `replacements: 'base64'`);
  //  - blob: URLs resolve inside the chapter iframe, so illustrations load;
  //  - it avoids inflating every image to base64 in memory (these books are
  //    ~10 MB each with 20+ full-page plates).
  const book = factory({ replacements: 'blobUrl' })
  const openable = book as unknown as { open?: (input: string, what?: string) => Promise<unknown> }
  if (typeof openable.open !== 'function') throw new Error('epub.js 未提供 open()')
  // ORDER MATTERS: `book.ready` is the promise of `open()`. Awaiting it before
  // calling open() deadlocks forever. Open first, then await.
  await openable.open(base64, 'base64')
  await book.ready
  return book
}

/** Open an EPUB from an http(s) URL (local Cloudreve direct link supported). */
export async function openEpubFromUrl(url: string): Promise<EpubBook> {
  const factory = await getFactory()
  const book = factory({ replacements: 'blobUrl' })
  const openable = book as unknown as { open?: (input: string, what?: string) => Promise<unknown> }
  if (typeof openable.open !== 'function') throw new Error('epub.js 未提供 open()')
  await openable.open(url, 'epub')
  await book.ready
  return book
}

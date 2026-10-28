// ---------------------------------------------------------------------------
// 书库 mod — entry point.
//
// The host loads this bundle with a plain <script> tag and then calls
// `__DOLA_MODS__["library"].mount(container)`. `mount` returns an unmount
// function so the host can tear the mod down (page switch, disable, reload).
//
// React comes from the host bridge through the `react` aliases in
// vite.config.ts; only the library's own code and its rendering deps (epub.js,
// pdf.js, jszip) are bundled.
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LibraryPage } from './LibraryPage'

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(LibraryPage))
  return () => root.unmount()
}

export interface LibraryMod {
  mount(container: HTMLElement): () => void
}

const mod: LibraryMod = { mount }

export default mod

// Register with the host. `??=` keeps a previously installed registry intact
// when the bundle is loaded twice (hot reload during development).
;(window.__DOLA_MODS__ ??= {})['library'] = mod

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
import { LibrarySettingsPage } from './settings'

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(LibraryPage))
  return () => root.unmount()
}

/**
 * Secondary settings screen.
 *
 * The host opens this from 设置 → 工具 → 设置 on this mod's row, so the 书库与阅读 and
 * 翻页 options ship with the tool instead of being baked into the shell.
 */
export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(LibrarySettingsPage))
  return () => root.unmount()
}

export interface LibraryMod {
  mount(container: HTMLElement): () => void
  mountSettings(container: HTMLElement): () => void
}

const mod: LibraryMod = { mount, mountSettings }

export default mod

// Register with the host. `??=` keeps a previously installed registry intact
// when the bundle is loaded twice (hot reload during development).
;(window.__DOLA_MODS__ ??= {})['library'] = mod

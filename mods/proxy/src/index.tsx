// ---------------------------------------------------------------------------
// 代理 mod — 入口
//
// Loaded by the host with <script src="dola-mod://proxy/index.js">, which then calls
// `__DOLA_MODS__['proxy'].mount(container)` for the tool and `.mountSettings(...)` for
// the secondary settings screen.
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProxyPage } from './ProxyPage'
import { ProxySettingsPage } from './settings'

interface ModModule {
  mount: (container: HTMLElement) => () => void
  mountSettings: (container: HTMLElement) => () => void
}

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(ProxyPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(ProxySettingsPage))
  return () => root.unmount()
}

const registry = ((window as unknown as { __DOLA_MODS__?: Record<string, ModModule> }).__DOLA_MODS__ ??= {})
registry['proxy'] = { mount, mountSettings }

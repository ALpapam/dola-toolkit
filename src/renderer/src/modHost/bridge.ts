// ---------------------------------------------------------------------------
// Dola Toolkit — mod host bridge
//
// Mods are plain IIFE bundles loaded with <script src="dola-mod://…">. They do not
// bundle their own React or UI kit; everything shared is read from this single global
// so a mod renders with the host's components, theme and store. Keeping one React
// instance also means hooks and context work across the boundary.
//
// The bridge is installed before the app renders, so a mod can never observe a
// partially populated global.
// ---------------------------------------------------------------------------

import React from 'react'
import ReactDOM from 'react-dom'
// React 19's `react-dom` entry does not export createRoot — only `react-dom/client`
// does. Merging both gives mods one object with createRoot, createPortal, flushSync…
import ReactDOMClient from 'react-dom/client'
import * as controls from '../ui/controls'
import { Icon } from '../ui/Icon'
import { toast } from '../ui/toast'
import { hashHue } from '../ui/format'
import { useHotkey } from '../ui/hooks'
import { useApp } from '../state/app'

export interface DolaHostBridge {
  React: typeof React
  /** react-dom and react-dom/client merged (createRoot lives only in the latter) */
  ReactDOM: typeof ReactDOM & typeof ReactDOMClient
  ReactDOMClient: typeof ReactDOMClient
  ui: typeof controls & {
    Icon: typeof Icon
    hashHue: typeof hashHue
    useHotkey: typeof useHotkey
  }
  toast: typeof toast
  useApp: typeof useApp
  version: string
}

declare global {
  interface Window {
    __DOLA__?: DolaHostBridge
    /** populated by mod bundles as `__DOLA_MODS__["<id>"]` */
    __DOLA_MODS__?: Record<string, unknown>
  }
}

export function installHostBridge(version: string): void {
  window.__DOLA__ = {
    React,
    ReactDOM: { ...ReactDOM, ...ReactDOMClient },
    ReactDOMClient,
    ui: { ...controls, Icon, hashHue, useHotkey },
    toast,
    useApp,
    version
  }
  window.__DOLA_MODS__ ??= {}
}

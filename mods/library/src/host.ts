// ---------------------------------------------------------------------------
// Dola Toolkit — 书库 mod host adapter
//
// A mod bundle never ships its own React, UI kit or app store: the host
// renderer installs one global (`window.__DOLA__`) before any mod script is
// evaluated, and everything shared is read from it. That keeps a single React
// instance (hooks/context work across the boundary), one UI kit, one theme and
// one app store.
//
// This module is the only place that knows about that global. Every other file
// in the mod imports from here, which keeps the bundle free of host code and
// makes the runtime contract explicit.
//
// The `@host/*` imports below are *type-only*: they are erased at build time and
// exist purely so TypeScript sees the host's real props/types. `@host` is an
// alias for `src/renderer/src` (see `tsconfig.mod.json`). Nothing from the host
// source tree is bundled.
// ---------------------------------------------------------------------------

import type { MenuItem } from '@host/ui/controls'
import type { IconName } from '@host/ui/Icon'

/** A single entry of the dropdown `Menu` control (re-exported for convenience). */
export type { MenuItem }
/** Name of an icon in the host's Material Symbols set. */
export type { IconName }

import type * as Controls from '@host/ui/controls'
import type * as HostIcon from '@host/ui/Icon'
import type * as HostToast from '@host/ui/toast'
import type * as HostFormat from '@host/ui/format'
import type * as HostHooks from '@host/ui/hooks'
import type * as HostApp from '@host/state/app'

/**
 * Shape of the global installed by `src/renderer/src/modHost/bridge.ts`.
 *
 * Kept structural (not imported from the host bridge module) so a half-edited
 * host file cannot break the mod's build; every member is still typed against
 * the real host modules through `typeof import(...)`.
 */
export interface DolaHostBridge {
  React: typeof import('react')
  ReactDOM: typeof import('react-dom') & Partial<typeof import('react-dom/client')>
  ui: typeof Controls & {
    Icon: typeof HostIcon.Icon
    hashHue: typeof HostFormat.hashHue
    useHotkey: typeof HostHooks.useHotkey
  }
  toast: typeof HostToast.toast
  useApp: typeof HostApp.useApp
  version: string
}

declare global {
  interface Window {
    __DOLA__?: DolaHostBridge
    /** mod bundles register themselves here as `__DOLA_MODS__["<id>"]` */
    __DOLA_MODS__?: Record<string, unknown>
  }
}

/** The host bridge, or a clear error when the mod was loaded outside the app. */
export function getHostBridge(): DolaHostBridge {
  const bridge = window.__DOLA__
  if (!bridge) {
    throw new Error('[library] 宿主桥未安装：window.__DOLA__ 缺失（mod 只能在 Dola Toolkit 渲染器中加载）')
  }
  return bridge
}

const bridge = getHostBridge()

/* ------------------------------------------------------------------ */
/* UI kit (src/renderer/src/ui/controls)                                */
/* ------------------------------------------------------------------ */
export const Button = bridge.ui.Button
export const IconButton = bridge.ui.IconButton
export const TextInput = bridge.ui.TextInput
export const Select = bridge.ui.Select
export const Slider = bridge.ui.Slider
export const Segmented = bridge.ui.Segmented
export const Tabs = bridge.ui.Tabs
export const Dialog = bridge.ui.Dialog
export const Menu = bridge.ui.Menu
export const Empty = bridge.ui.Empty
export const Spinner = bridge.ui.Spinner
export const SettingRow = bridge.ui.SettingRow
export const Switch = bridge.ui.Switch

/* ------------------------------------------------------------------ */
/* Icon / toast / format / hooks                                        */
/* ------------------------------------------------------------------ */
export const Icon = bridge.ui.Icon
export const toast = bridge.toast
export const hashHue = bridge.ui.hashHue
export const useHotkey = bridge.ui.useHotkey

/* ------------------------------------------------------------------ */
/* app store (src/renderer/src/state/app)                              */
/* ------------------------------------------------------------------ */
export const useApp = bridge.useApp

/** host application version, handy for diagnostics */
export const hostVersion: string = bridge.version

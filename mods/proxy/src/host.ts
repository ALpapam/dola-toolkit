// ---------------------------------------------------------------------------
// 代理 mod — 宿主适配层
//
// The mod never bundles React or the UI kit: everything shared is read from the
// single `window.__DOLA__` global the host installs before any mod script runs. This
// file is the only place that knows about that global.
//
// The `@host/*` imports are type-only (erased at build time); they exist so the props
// and icon names are checked against the host's real definitions.
// ---------------------------------------------------------------------------

import type { IconName } from '@host/ui/Icon'

export type { IconName }

import type * as Controls from '@host/ui/controls'
import type * as HostIcon from '@host/ui/Icon'
import type * as HostToast from '@host/ui/toast'
import type * as HostFormat from '@host/ui/format'
import type * as HostHooks from '@host/ui/hooks'
import type * as HostApp from '@host/state/app'

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
    __DOLA_MODS__?: Record<string, unknown>
  }
}

function bridge(): DolaHostBridge {
  const b = window.__DOLA__
  if (!b) throw new Error('[proxy] 宿主桥未安装：window.__DOLA__ 缺失（mod 只能在 Dola Toolkit 渲染器中加载）')
  return b
}

const host = bridge()

/* ---- UI kit ---- */
export const Button = host.ui.Button
export const IconButton = host.ui.IconButton
export const TextInput = host.ui.TextInput
export const TextArea = host.ui.TextArea
export const Select = host.ui.Select
export const Slider = host.ui.Slider
export const Segmented = host.ui.Segmented
export const Tabs = host.ui.Tabs
export const Dialog = host.ui.Dialog
export const Menu = host.ui.Menu
export const Empty = host.ui.Empty
export const Spinner = host.ui.Spinner
export const Switch = host.ui.Switch
export const SettingRow = host.ui.SettingRow
export const Badge = host.ui.Badge
export const Field = host.ui.Field
export const Chip = host.ui.Chip

/* ---- shared helpers ---- */
export const Icon = host.ui.Icon
export const toast = host.toast
export const hashHue = host.ui.hashHue
export const useHotkey = host.ui.useHotkey
export const useApp = host.useApp
export const hostVersion: string = host.version

/* ---- formatting helpers: pure functions, copied into the mod on purpose so it
   does not depend on host internals ---- */
export {
  engineLabel,
  fmtBytes,
  fmtDate,
  fmtClock,
  fmtDuration,
  formatProtocol
} from './format'
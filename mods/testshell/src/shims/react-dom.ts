// ---------------------------------------------------------------------------
// `react-dom` shim — portal/imperative APIs come from the host's renderer.
//
// Only `createPortal` (used by the host UI kit's Dialog/Menu) and the handful of
// DOM helpers are needed from the classic `react-dom` entry. `createRoot` lives
// in `react-dom/client`; see `react-dom-client.ts`.
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactDOMModule = typeof import('react-dom')

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReactDOM(): ReactDOMModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[library] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.ReactDOM
}

const D = hostReactDOM()

export default D

export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version
} = D

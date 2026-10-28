// ---------------------------------------------------------------------------
// `react-dom/client` shim — root creation through the host's renderer.
//
// React 19 does not export `createRoot` from the classic `react-dom` entry, so
// the host bridge is expected to merge `react-dom/client` into `ReactDOM`
// (or expose `ReactDOMClient`). Both shapes are accepted, and a missing export
// is reported with an actionable message instead of "createRoot is not a
// function".
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ClientModule = typeof import('react-dom/client')
type CreateRoot = ClientModule['createRoot']
type RootContainer = Parameters<CreateRoot>[0]
type RootOptions = Parameters<CreateRoot>[1]
type RootType = ReturnType<CreateRoot>

const host = window as Window & { __DOLA__?: DolaHostBridge }

function resolveCreateRoot(): CreateRoot | undefined {
  const bridge = host.__DOLA__
  if (!bridge) return undefined
  const dom = bridge.ReactDOM as Partial<ClientModule> & { ReactDOMClient?: Partial<ClientModule> }
  return dom.createRoot ?? dom.ReactDOMClient?.createRoot
}

export function createRoot(container: RootContainer, options?: RootOptions): RootType {
  const create = resolveCreateRoot()
  if (!create) {
    throw new Error(
      '[library] 宿主桥未暴露 createRoot：请让 window.__DOLA__.ReactDOM 合并 react-dom/client（或提供 ReactDOMClient）'
    )
  }
  return create(container, options)
}

export function hydrateRoot(
  container: Parameters<ClientModule['hydrateRoot']>[0],
  initialChildren: Parameters<ClientModule['hydrateRoot']>[1],
  options?: Parameters<ClientModule['hydrateRoot']>[2]
): ReturnType<ClientModule['hydrateRoot']> {
  const bridge = host.__DOLA__
  const hydrate = bridge?.ReactDOM.hydrateRoot
  if (!hydrate) throw new Error('[library] 宿主桥未暴露 hydrateRoot')
  return hydrate(container, initialChildren, options)
}

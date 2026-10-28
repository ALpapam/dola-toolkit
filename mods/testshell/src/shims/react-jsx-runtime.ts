// ---------------------------------------------------------------------------
// `react/jsx-runtime` shim — the automatic JSX transform target.
//
// The compiler emits `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'`
// (or `jsxDEV` from the dev runtime). Both specifiers are aliased here so the
// emitted element objects are created by the *host's* React instance, which is
// what makes host-provided components and the mod's components share one
// reconciler.
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactModule = typeof import('react')
type ElementType = import('react').ElementType

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReact(): ReactModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[library] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.React
}

const R = hostReact()

export const Fragment = R.Fragment

/**
 * `jsx(type, props, key)` / `jsxs(type, props, key)`.
 *
 * `key` is passed separately by the runtime and must be folded back into the
 * config object because `React.createElement` reads it from there. `children`
 * travels inside `props` (the automatic runtime never passes child arguments).
 */
function jsx(type: ElementType, props: unknown, key?: string | number | bigint | null): JSX.Element {
  const config =
    key === undefined
      ? props
      : { ...((props as Record<string, unknown> | null | undefined) ?? {}), key }
  return R.createElement(type, config as Parameters<ReactModule['createElement']>[1])
}

export { jsx, jsx as jsxs }

/** Dev-only runtime entry; the aliased dev specifier resolves here too. */
export function jsxDEV(
  type: ElementType,
  props: unknown,
  key?: string | number | bigint | null,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown
): JSX.Element {
  return jsx(type, props, key)
}

export default { jsx, jsxs: jsx, jsxDEV, Fragment }

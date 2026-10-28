// ---------------------------------------------------------------------------
// `react` shim — the mod must use the host's React instance.
//
// Vite aliases the bare `react` specifier to this file at build time, so every
// import (JSX runtime, hooks, zustand's internal `import React from 'react'`)
// resolves to the single React copy the host renderer already holds. Two React
// copies on one page is the classic "invalid hook call" trap; this avoids it.
//
// The `import type` below is erased at build time (it only gives us the exact
// typings), so there is no self-import in the emitted bundle.
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactModule = typeof import('react')

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReact(): ReactModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[library] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.React
}

const R = hostReact()

export default R

export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  ViewTransition,
  act,
  addTransitionType,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = R

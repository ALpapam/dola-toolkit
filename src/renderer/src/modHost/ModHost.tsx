// ---------------------------------------------------------------------------
// Dola Toolkit — mod runtime (renderer side)
//
// A mod is an IIFE bundle served over `dola-mod://`. Loading is:
//   <script src="dola-mod://<id>/<entry>">  →  bundle registers window.__DOLA_MODS__[id]
//   →  host calls mount(container)  →  returns an unmount function
//
// The bundle is cached per id+version, so switching pages does not re-execute it, and
// an upgraded mod replaces the old registration.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type { ModEntry } from '../state/app'
import { Spinner } from '../ui/controls'

interface ModModule {
  mount: (container: HTMLElement) => void | (() => void)
}

const loaded = new Map<string, Promise<ModModule>>()

function scriptUrl(mod: ModEntry): string {
  const entry = (mod.entry || 'index.js').replace(/^\/+/, '')
  return `dola-mod://${mod.id}/${entry}`
}

/**
 * Loads (once) and returns a mod's registered module.
 *
 * A script tag is used rather than dynamic import(): the bundle is a classic IIFE and
 * the custom scheme is not a module graph, so this avoids MIME/module resolution issues.
 */
function loadMod(mod: ModEntry): Promise<ModModule> {
  const key = `${mod.id}@${mod.version}`
  const cached = loaded.get(key)
  if (cached) return cached

  const promise = new Promise<ModModule>((resolve, reject) => {
    // an upgrade must not reuse the older registration
    if (window.__DOLA_MODS__) delete window.__DOLA_MODS__[mod.id]

    const script = document.createElement('script')
    script.src = scriptUrl(mod)
    script.async = true
    script.onload = () => {
      const registered = window.__DOLA_MODS__?.[mod.id] as ModModule | undefined
      if (registered && typeof registered.mount === 'function') resolve(registered)
      else reject(new Error('插件没有正确注册，可能不是有效的 Dola Toolkit 插件'))
    }
    script.onerror = () => reject(new Error('插件文件加载失败'))
    document.head.appendChild(script)
  })

  loaded.set(key, promise)
  // a failed load should be retryable
  promise.catch(() => loaded.delete(key))
  return promise
}

/** Forgets a mod so the next mount re-reads its bundle (after reinstall). */
export function invalidateMod(id: string): void {
  for (const key of [...loaded.keys()]) {
    if (key.startsWith(`${id}@`)) loaded.delete(key)
  }
}

interface Props {
  mod: ModEntry
}

/** Renders a mod's UI inside the page area. */
export function ModHost({ mod }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let disposed = false
    let unmount: (() => void) | void

    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const modModule = await loadMod(mod)
        if (disposed || !containerRef.current) return
        unmount = modModule.mount(containerRef.current)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '插件加载失败')
      } finally {
        if (!disposed) setLoading(false)
      }
    })()

    return () => {
      disposed = true
      try {
        if (typeof unmount === 'function') unmount()
      } catch {
        /* a mod that fails to clean up must not break navigation */
      }
    }
  }, [mod.id, mod.version])

  return (
    <div className="mod-page" style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      {loading ? (
        <div className="hstack" style={{ gap: 10, padding: 24, justifyContent: 'center' }}>
          <Spinner size={18} />
          <span className="muted">正在加载 {mod.name}…</span>
        </div>
      ) : null}
      {error ? (
        <div className="stack-sm" style={{ padding: 24 }}>
          <strong>无法加载「{mod.name}」</strong>
          <div className="muted tiny">{error}</div>
        </div>
      ) : null}
      <div ref={containerRef} style={{ height: '100%', minHeight: 0 }} />
    </div>
  )
}

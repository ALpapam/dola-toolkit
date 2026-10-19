import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from './state/app'
import { Icon } from './ui/Icon'
import { HomePage } from './pages/Home'
import { ProxyPage } from './pages/proxy/ProxyPage'
import { LibraryPage } from './pages/library/LibraryPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { ToastHost } from './ui/toast'
import { NavRail } from './shell/NavRail'
import { TitleBar } from './shell/TitleBar'
import { initThemeListeners, useTheme } from './theme/store'
import { installFontFaces, resolveReadingFamily } from './pages/library/fonts'

export default function App(): JSX.Element {
  const page = useApp((s) => s.page)
  const ready = useApp((s) => s.ready)
  const setSettings = useApp((s) => s.setSettings)
  const setReady = useApp((s) => s.setReady)
  const setFonts = useApp((s) => s.setFonts)
  const setReadingFamily = useApp((s) => s.setReadingFamily)
  const themeSettings = useTheme((s) => s.setSettings)
  const refresh = useTheme((s) => s.refresh)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const off = initThemeListeners()
    void (async () => {
      try {
        const settings = await window.api.settings.get()
        if (cancelled) return
        setSettings(settings)
        themeSettings(settings)
        // reader typography: install @font-face rules before the first paint so
        // an opened book never flashes the fallback serif
        try {
          const list = await window.api.fonts.list()
          if (!cancelled && list?.fonts) {
            setFonts(list.fonts)
            setReadingFamily(resolveReadingFamily(settings.reader.fontFamily, list.fonts))
            installFontFaces(list.fonts)
          }
        } catch {
          /* fonts are cosmetic — never block boot */
        }
        await refresh(false)
        setReady(true)
      } catch (e) {
        setBootError(String(e))
      }
    })()
    return () => {
      cancelled = true
      off()
    }
  }, [setSettings, setReady, setFonts, setReadingFamily, themeSettings, refresh])

  const onToastBridge = useEffectBridge()

  // Keep the store in sync for writes that did not come from this component's
  // own patch() call (main broadcasts on every settings write). Without this a
  // reader that is already on screen would keep the old font / flip animation.
  useEffect(() => {
    const off = window.api.settings.onChanged((next) => {
      setSettings(next)
      themeSettings(next)
      setReadingFamily(resolveReadingFamily(next.reader.fontFamily, useApp.getState().fonts))
    })
    return off
  }, [setSettings, themeSettings, setReadingFamily])

  if (bootError) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 40 }}>
        <div className="card" style={{ padding: 24, maxWidth: 520 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>启动失败</h2>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', color: 'var(--md-error)' }}>
            {bootError}
          </pre>
          <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            请查看日志目录，或重新启动 Dola Toolkit。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <NavRail />
      <div className="main-col">
        <TitleBar />
        <div className="page-host">
          {page === 'home' && <HomePage />}
          {page === 'proxy' && <ProxyPage />}
          {page === 'library' && <LibraryPage />}
          {page === 'settings' && <SettingsPage />}
          {!['home', 'proxy', 'library', 'settings'].includes(page) && <HomePage />}
        </div>
      </div>
      <ToastHost />
      {!ready ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--md-background)',
            zIndex: 500,
            transition: 'opacity .25s'
          }}
        >
          <div className="hstack" style={{ gap: 12 }}>
            <span className="spinner" />
            <span className="muted" style={{ fontSize: 13 }}>
              正在取色…
            </span>
          </div>
        </div>
      ) : null}
      {onToastBridge}
    </div>
  )
}

/** Bridges main-process toasts into the renderer toast host. */
function useEffectBridge(): ReactNode {
  useEffect(() => {
    const off = window.api.onToast((t) => {
      void import('./ui/toast').then((m) => m.useToasts.getState().push(t.kind, t.message))
    })
    return off
  }, [])
  return null
}

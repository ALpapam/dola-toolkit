import { useEffect, useState, type ReactNode } from 'react'
import { APP_VERSION_LABEL } from '@shared/version'
import { useApp } from './state/app'
import { Icon } from './ui/Icon'
import { HomePage } from './pages/Home'
import { ProxyPage } from './pages/proxy/ProxyPage'
import { AddToolPage } from './pages/AddToolPage'
import { ModHost } from './modHost/ModHost'
import { FirstRunGuide } from './modHost/FirstRunGuide'
import { SettingsPage } from './pages/settings/SettingsPage'
import { ToastHost } from './ui/toast'
import { Button, Dialog, Switch } from './ui/controls'
import { NavRail } from './shell/NavRail'
import { TitleBar } from './shell/TitleBar'
import { initThemeListeners, useTheme } from './theme/store'
import { applyAppFont, installFontFaces, resolveReadingFamily } from './lib/fonts'

export default function App(): JSX.Element {
  const page = useApp((s) => s.page)
  const mods = useApp((s) => s.mods)
  const refreshMods = useApp((s) => s.refreshMods)
  /** the mod rendered by this page, if the current page id is a mod */
  const mod = mods.find((m) => m.id === page && m.enabled) ?? null
  const ready = useApp((s) => s.ready)
  const setSettings = useApp((s) => s.setSettings)
  const setReady = useApp((s) => s.setReady)
  const setFonts = useApp((s) => s.setFonts)
  const setReadingFamily = useApp((s) => s.setReadingFamily)

  useEffect(() => {
    void refreshMods()
    // the main process pushes this after install/uninstall, so the rail never shows
    // a stale list (a mod added elsewhere appears immediately)
    return window.api.mods.onChanged(() => {
      void refreshMods()
    })
  }, [refreshMods])
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
            // the chosen family styles the entire UI, not only book text
            applyAppFont(settings.reader.fontFamily, list.fonts)
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
  const updateNudge = useUpdateNudge()

  // Keep the store in sync for writes that did not come from this component's
  // own patch() call (main broadcasts on every settings write). Without this a
  // reader that is already on screen would keep the old font / flip animation.
  useEffect(() => {
    const off = window.api.settings.onChanged((next) => {
      setSettings(next)
      themeSettings(next)
      const fonts = useApp.getState().fonts
      setReadingFamily(resolveReadingFamily(next.reader.fontFamily, fonts))
      applyAppFont(next.reader.fontFamily, fonts)
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
          {page === 'add-tool' && <AddToolPage />}
          {page === 'settings' && <SettingsPage />}
          {mod && <ModHost mod={mod} />}
          {!mod && !['home', 'proxy', 'add-tool', 'settings'].includes(page) && <HomePage />}
        </div>
      </div>
      <ToastHost />
      <FirstRunGuide />
      <ClosePrompt />
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
      {updateNudge}
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

/**
 * Background update nudge.
 *
 * Runs once per launch, a few seconds after the window is up so it never competes
 * with the first paint. A new app version produces a toast pointing at the About
 * page; an installed core that is behind simply gets a quieter note.
 *
 * The pending-update marker covers the other direction: when the previous session
 * installed an update, this launch confirms that it worked.
 */
function useUpdateNudge(): ReactNode {
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const toast = (await import('./ui/toast')).toast
        try {
          const pending = await window.api.app.takePendingUpdate()
          if (!cancelled && pending) {
            /*
             * Report what actually happened, not what was requested.
             *
             * The marker records the version that launched the installer, so this
             * session knows whether the new version really loaded. Claiming success
             * unconditionally hid a broken (truncated) installer completely: the app
             * restarted, said "updated", and was still running the old build.
             */
            if (pending.updated) {
              toast.success(`已更新到 ${APP_VERSION_LABEL}`)
            } else {
              toast.warn(`更新未生效，当前仍是 ${APP_VERSION_LABEL}。请在「设置 → 关于」重新下载`)
            }
          }
          const [app, cores] = await Promise.all([
            window.api.app.checkAppUpdate(),
            window.api.app.checkCoreUpdates()
          ])
          if (cancelled) return
          if (app.updateAvailable && app.latest) {
            toast.info(`发现新版本 ${app.latest}，可在「设置 → 关于」中更新`)
          }
          /*
           * Staged core binaries are applied during startup, so by now either the
           * swap worked or it did not. Say which — this is the last chance for the
           * user to learn that a core update silently failed.
           */
          const stagedNow = await window.api.app.stagedCores()
          if (stagedNow.length > 0) {
            toast.warn(`还有 ${stagedNow.length} 个内核等待重启后应用`)
          }
          const behind = cores.filter((c) => c.updateAvailable)
          if (behind.length > 0) {
            toast.info(`${behind.map((c) => c.label).join(' / ')} 内核可更新`)
          }
        } catch {
          /* offline or rate-limited — stay quiet */
        }
      })()
    }, 6000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])
  return null
}

/**
 * "Minimize to tray or quit?" prompt.
 *
 * The main process asks before the first close, because the boolean setting
 * alone cannot tell "never chose" apart from "chose to quit". Answering with
 * 「下次不再提示」 stores the choice, which is the same value the settings switch
 * shows — so the dialog and the switch stay in sync either way round.
 */
function ClosePrompt(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(true)
  const [trayOk, setTrayOk] = useState(true)

  useEffect(() => {
    const off = window.api.app.onCloseAsk(() => {
      setRemember(true)
      setOpen(true)
      // Only offer "minimize to tray" when an icon really exists: hiding with no
      // tray leaves the window unreachable.
      void window.api.app
        .trayAvailable()
        // an icon with no image renders as nothing, so treat that as unavailable
        .then((info) => setTrayOk(info.available && info.icon !== null))
        .catch(() => setTrayOk(false))
    })
    return off
  }, [])

  if (!open) return null

  const answer = (closeToTray: boolean): void => {
    setOpen(false)
    void window.api.app.resolveClose({ closeToTray, remember })
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="关闭 Dola Toolkit"
      subtitle={
        trayOk
          ? '你可以让它在后台继续运行，代理与同步不会中断'
          : '当前会话无法创建托盘图标，只能退出程序'
      }
      icon="chevronDown"
      width="slim"
      footer={
        <>
          <Button variant="text" onClick={() => answer(false)}>
            退出程序
          </Button>
          <Button
            variant="filled"
            icon="chevronDown"
            disabled={!trayOk}
            onClick={() => answer(true)}
          >
            最小化到托盘
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <div className="hstack" style={{ gap: 10, alignItems: 'flex-start' }}>
          <Switch checked={remember} onChange={setRemember} />
          <div>
            <div style={{ fontWeight: 500 }}>下次不再提示</div>
            <div className="tiny muted">
              会同时更新「设置 → 通用 → 关闭时最小化到后台」，之后按该开关执行
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

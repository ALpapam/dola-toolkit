// ---------------------------------------------------------------------------
// 主菜单
//
// Three full-height pages stacked vertically with scroll snapping:
//
//   1  welcome   logo, greeting, and a small down chevron
//   2  shortcuts installed tools as desktop-style icons (top-right first),
//                clicking one opens that tool
//   3  status    what the app is currently providing; mods can add rows through
//                window.__DOLA_STATUS__
//
// The chevron on page 1 moves to page 2, page 2 has its own chevron down to page 3.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AIStatus, ProxyState, SyncStatus } from '@shared/types'
import { useApp, BUILTIN_TOOLS } from '../state/app'
import { Icon, type IconName } from '../ui/Icon'
import { engineLabel } from '../ui/format'
import logoUrl from '../assets/logo-64.png'

interface StatusLine {
  id: string
  label: string
  value: string
  tone: 'ok' | 'idle' | 'warn'
  /** settings section this service belongs to; clicking the row opens it */
  section?: string
}

/** mods can contribute rows to the status page */
declare global {
  interface Window {
    __DOLA_STATUS__?: Record<
      string,
      { title: string; resolve: () => Promise<StatusLine[]> | StatusLine[] }
    >
  }
}

export function HomePage(): JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const mods = useApp((s) => s.mods)
  const homeOrder = useApp((s) => s.homeOrder)
  const openSettings = useApp((s) => s.openSettings)

  const [proxy, setProxy] = useState<ProxyState | null>(null)
  const [ai, setAi] = useState<AIStatus | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [modStatus, setModStatus] = useState<StatusLine[]>([])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [pageIndex, setPageIndex] = useState(0)

  useEffect(() => {
    const load = (): void => {
      void window.api.proxy.state().then(setProxy).catch(() => undefined)
      void window.api.ai.status().then(setAi).catch(() => undefined)
      void window.api.sync.status().then(setSync).catch(() => undefined)
    }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  /* mod-provided status rows */
  useEffect(() => {
    const resolve = async (): Promise<void> => {
      const registry = window.__DOLA_STATUS__
      if (!registry) return
      const rows: StatusLine[] = []
      for (const entry of Object.values(registry)) {
        try {
          rows.push(...(await entry.resolve()))
        } catch {
          /* a broken mod must not break the page */
        }
      }
      setModStatus(rows)
    }
    void resolve()
    const t = setInterval(resolve, 8000)
    return () => clearInterval(t)
  }, [])

  /* keep the page index in sync with the snapped scroll position */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      const i = Math.round(el.scrollTop / el.clientHeight)
      setPageIndex(Math.max(0, Math.min(2, i)))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const goTo = useCallback((index: number): void => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ top: index * el.clientHeight, behavior: 'smooth' })
  }, [])

  /**
   * Shortcut page contents, in their own order.
   *
   * This grid has its own layout — rearranging the sidebar must not shuffle it — so it
   * reads `homeOrder` and only falls back to built-ins followed by installed mods.
   */
  const shortcuts = (() => {
    const builtins = BUILTIN_TOOLS.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))
    const modEntries = mods.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name, icon: m.icon }))
    const all = [...builtins, ...modEntries]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ordered = homeOrder
      .map((id) => byId.get(id))
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
    for (const entry of all) if (!ordered.some((x) => x.id === entry.id)) ordered.push(entry)
    return ordered
  })()

  return (
    <div className="home-scroll" ref={scrollerRef}>
      {/* ---------------- page 1: welcome ---------------- */}
      <section className="home-page home-welcome">
        <div className="home-welcome-inner">
          <img className="home-logo" src={logoUrl} alt="" draggable={false} />
          <h1 className="home-greeting">欢迎使用 Dola Toolkit~φ(゜▽゜*)♪</h1>
        </div>
        <button type="button" className="home-chevron" onClick={() => goTo(1)} aria-label="下一页" title="下一页">
          <Icon name="expandMore" size={22} />
        </button>
      </section>

      {/* ---------------- page 2: shortcuts ---------------- */}
      <section className="home-page home-shortcuts">
        <header className="home-page-head">
          <span className="home-page-title">我的工具</span>
          <span className="tiny muted">点击图标进入工具，顺序与侧边栏一致</span>
        </header>
        <div className="shortcut-grid" role="list">
          {shortcuts.map((s) => (
            <button
              key={s.id}
              role="listitem"
              className="shortcut"
              onClick={() => setPage(s.id)}
              aria-label={s.name}
              title={s.name}
            >
              <span className="shortcut-icon">
                <Icon name={s.icon as IconName} size={26} />
              </span>
              <span className="shortcut-label">{s.name}</span>
            </button>
          ))}
          <button
            className="shortcut shortcut-add"
            onClick={() => setPage('add-tool')}
            aria-label="添加工具"
            title="添加工具"
          >
            <span className="shortcut-icon">
              <Icon name="add" size={26} />
            </span>
            <span className="shortcut-label">添加</span>
          </button>
        </div>
        <button type="button" className="home-chevron" onClick={() => goTo(2)} aria-label="下一页" title="下一页">
          <Icon name="expandMore" size={22} />
        </button>
      </section>

      {/* ---------------- page 3: status ---------------- */}
      <section className="home-page home-status">
        <header className="home-page-head">
          <span className="home-page-title">运行状态</span>
          <span className="tiny muted">当前软件提供的服务</span>
        </header>
        <div className="status-list">
          {buildStatus(proxy, ai, sync, mods.length).map((row) => (
            <button
              key={row.id}
              type="button"
              className="status-row"
              onClick={() => openSettings(row.section)}
              title={`打开${row.label}设置`}
            >
              <span className={`status-dot ${row.tone}`} />
              <span className="status-label">{row.label}</span>
              <span className="status-value">{row.value}</span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
          {modStatus.map((row) => (
            <div key={row.id} className="status-row static">
              <span className={`status-dot ${row.tone}`} />
              <span className="status-label">{row.label}</span>
              <span className="status-value">{row.value}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="home-chevron up"
          onClick={() => goTo(0)}
          aria-label="回到顶部"
          title="回到顶部"
        >
          <Icon name="expandMore" size={22} />
        </button>
      </section>
    </div>
  )
}

/** Rows describing what the app is currently doing. */
function buildStatus(
  proxy: ProxyState | null,
  ai: AIStatus | null,
  sync: SyncStatus | null,
  modCount: number
): StatusLine[] {
  const running = proxy?.engines.find((e) => e.running) ?? null
  return [
    {
      id: 'proxy',
      label: '代理服务',
      value: running ? `运行中 · ${engineLabel(running.engine)}` : '未启动',
      tone: running ? 'ok' : 'idle',
      section: 'proxy'
    },
    {
      id: 'nodes',
      label: '节点',
      value: proxy ? `${proxy.nodes?.length ?? 0} 个` : '—',
      tone: proxy ? 'ok' : 'idle',
      section: 'proxy'
    },
    {
      id: 'ai',
      label: 'AI 助手',
      value: ai?.configured ? `已配置${ai.model ? ` · ${ai.model}` : ''}` : '未配置',
      tone: ai?.configured ? 'ok' : 'idle',
      section: 'ai'
    },
    {
      id: 'sync',
      label: 'WebDAV 同步',
      value: sync?.configured ? '已配置' : '未配置',
      tone: sync?.configured ? 'ok' : 'idle',
      section: 'sync'
    },
    {
      id: 'mods',
      label: '工具数量',
      value: `${modCount + BUILTIN_TOOLS.length} 个（含内置 ${BUILTIN_TOOLS.length}）`,
      tone: 'ok',
      section: 'tools'
    }
  ]
}

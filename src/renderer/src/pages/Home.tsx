import { useEffect, useState } from 'react'
import type { AIStatus, AppInfo, ProxyState, SyncStatus } from '@shared/types'
import { useApp, BUILTIN_TOOLS } from '../state/app'
import { APP_VERSION_LABEL } from '@shared/version'
import { useTheme } from '../theme/store'
import { Icon, type IconName } from '../ui/Icon'
import { Badge, Empty } from '../ui/controls'
import { engineLabel } from '../ui/format'

export function HomePage(): JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const monet = useTheme((s) => s.monet)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [proxy, setProxy] = useState<ProxyState | null>(null)
  const [ai, setAi] = useState<AIStatus | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)

  useEffect(() => {
    void window.api.app.info().then(setInfo).catch(() => undefined)
    const load = (): void => {
      void window.api.proxy.state().then(setProxy).catch(() => undefined)
      void window.api.ai.status().then(setAi).catch(() => undefined)
      void window.api.sync.status().then(setSync).catch(() => undefined)
    }
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [])

  const running = proxy?.engines.find((e) => e.running) ?? null
  const node = proxy?.nodes.find((n) => n.id === proxy.selectedNodeId) ?? null

  return (
    <div className="home">
      <section className="home-hero">
        <div className="home-hero-logo">
          <Icon name="bookOpen" size={38} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>Dola Toolkit</h1>
          <p>
            一个 Material You 风格的桌面工具箱。左侧可拖拽排序工具，取色跟随壁纸莫奈调色，
            设置永久驻留在工具栏底部。当前版本 <b>{APP_VERSION_LABEL}</b>。
          </p>
        </div>
        <div className="hstack" style={{ gap: 10, flexShrink: 0 }}>
          <div className="palette-strip" style={{ maxWidth: 210, justifyContent: 'flex-end' }}>
            {[monet.light.primary, monet.light.secondary, monet.light.tertiary, monet.light.primaryContainer, monet.dark.primary].map(
              (c, i) => (
                <span key={i} className="sw" style={{ background: c }} title={c} />
              )
            )}
          </div>
        </div>
      </section>

      <div className="home-section-title">工具</div>
      <div className="tool-cards">
        {BUILTIN_TOOLS.map((t) => (
          <button key={t.id} className="tool-card" onClick={() => setPage(t.id)}>
            <span className="tool-card-glyph">
              <Icon name={t.icon as IconName} size={26} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3>{t.name}</h3>
              <p>{t.desc}</p>
            </div>
          </button>
        ))}
        <button className="tool-card" onClick={() => setPage('settings')}>
          <span className="tool-card-glyph" style={{ background: 'var(--md-tertiary-container)', color: 'var(--md-on-tertiary-container)' }}>
            <Icon name="settings" size={26} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h3>设置</h3>
            <p>取色、AI、WebDAV 同步与关于</p>
          </div>
        </button>
      </div>

      <div className="home-section-title">状态</div>
      <div className="grid-3" style={{ gap: 12 }}>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="hstack" style={{ gap: 8, marginBottom: 8 }}>
            <Icon name="proxy" size={18} />
            <span className="strong" style={{ fontSize: 13 }}>
              代理
            </span>
            <span className="spacer" />
            {running ? <Badge tone="ok" dot>运行中</Badge> : <Badge>未启动</Badge>}
          </div>
          <div className="tiny muted">内核：{running ? engineLabel(running.engine) : '—'}</div>
          <div className="tiny muted" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            节点：{node?.name ?? '未选择'}
          </div>
          <div className="tiny muted" style={{ marginTop: 2 }}>
            端口：{proxy?.settings.mixedPort ?? '—'} · 节点数 {proxy?.nodes.length ?? 0}
          </div>
        </div>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="hstack" style={{ gap: 8, marginBottom: 8 }}>
            <Icon name="autoAi" size={18} />
            <span className="strong" style={{ fontSize: 13 }}>
              AI
            </span>
            <span className="spacer" />
            {ai?.configured ? <Badge tone="ok">已配置</Badge> : <Badge tone="warn">未配置</Badge>}
          </div>
          <div className="tiny muted" style={{ wordBreak: 'break-all' }}>{ai?.model || '—'}</div>
          <div className="tiny muted" style={{ marginTop: 2, wordBreak: 'break-all' }}>{ai?.baseUrl || '—'}</div>
        </div>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="hstack" style={{ gap: 8, marginBottom: 8 }}>
            <Icon name="cloudSync" size={18} />
            <span className="strong" style={{ fontSize: 13 }}>
              WebDAV
            </span>
            <span className="spacer" />
            {sync?.configured ? <Badge tone="ok">已配置</Badge> : <Badge>未配置</Badge>}
          </div>
          <div className="tiny muted">上次同步：{sync?.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : '从未'}</div>
          <div className="tiny muted" style={{ marginTop: 2 }}>{info ? `v${info.version} · Electron ${info.electron}` : '—'}</div>
        </div>
      </div>

      {!info ? <Empty icon="info" title="正在读取信息" /> : null}
    </div>
  )
}

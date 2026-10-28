import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CoreId, CoreLogEvent, EngineCapability, NodeTestResult, ProxyNode, ProxyState } from '@shared/types'
import { Button, Empty, IconButton, Badge, Chip, Spinner, Switch } from './host'
import { Icon } from './host'
import { toast } from './host'
import { engineLabel, fmtDuration, formatProtocol } from './host'
import { AddNodeDialog } from './AddNodeDialog'
import { ImportDialog } from './ImportDialog'
import { GeoDialog } from './GeoDialog'
import { CoreUpdateDialog } from './CoreUpdateDialog'

export function ProxyPage(): JSX.Element {
  const [state, setState] = useState<ProxyState | null>(null)
  const [engines, setEngines] = useState<EngineCapability[]>([])
  const [logs, setLogs] = useState<CoreLogEvent[]>([])
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, NodeTestResult>>({})
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  /** node currently being edited; null = the dialog creates a new one */
  const [editing, setEditing] = useState<ProxyNode | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [geoOpen, setGeoOpen] = useState(false)
  const [filter, setFilter] = useState('')
  /** core update dialog + how many cores are behind (badge on the chip) */
  const [coreUpdateOpen, setCoreUpdateOpen] = useState(false)
  const [coreUpdates, setCoreUpdates] = useState(0)

  const load = useCallback(async () => {
    try {
      const s = await window.api.proxy.state()
      setState(s)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void load()
    void window.api.proxy.engines().then(setEngines).catch(() => undefined)
    const offState = window.api.proxy.onState(setState)
    const offLog = window.api.proxy.onLog((e) => setLogs((prev) => [...prev.slice(-399), e]))
    const t = setInterval(() => {
      void window.api.proxy.state().then(setState).catch(() => undefined)
    }, 3000)
    return () => {
      offState()
      offLog()
      clearInterval(t)
    }
  }, [load])

  /**
   * How many cores are behind — shown on the 内核更新 chip so it is obvious at a
   * glance whether anything needs attention. Silent on failure (offline).
   */
  const refreshCoreUpdates = useCallback(async () => {
    try {
      const list = await window.api.app.checkCoreUpdates()
      setCoreUpdates(list.filter((c) => c.updateAvailable).length)
    } catch {
      /* offline or rate-limited */
    }
  }, [])

  useEffect(() => {
    void refreshCoreUpdates()
  }, [refreshCoreUpdates])

  const activeStatus = state?.engines.find((e) => e.running) ?? null
  const selected = state?.nodes.find((n) => n.id === state.selectedNodeId) ?? null
  const filtered = useMemo(() => {
    if (!state) return []
    const q = filter.trim().toLowerCase()
    if (!q) return state.nodes
    return state.nodes.filter(
      (n) => n.name.toLowerCase().includes(q) || n.server.toLowerCase().includes(q) || n.protocol.includes(q)
    )
  }, [state, filter])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await window.api.proxy.start()
      await load()
      if (st.error) toast.error(st.error)
      else toast.success(`${engineLabel(st.engine)} 已启动 · 混合端口 ${st.mixedPort}`)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.proxy.stop()
      await load()
      toast.info('代理已停止')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const selectNode = async (id: string): Promise<void> => {
    const s = await window.api.proxy.selectNode(id)
    setState(s)
  }

  const testNode = async (id: string): Promise<void> => {
    setTesting((t) => ({ ...t, [id]: true }))
    try {
      const r = await window.api.proxy.testNode(id)
      setResults((prev) => ({ ...prev, [id]: r }))
      if (r.ok) toast.success(`${r.delayMs ?? '?'} ms${r.exitIp ? ` · ${r.exitIp}` : ''}`)
      else toast.error(r.error ?? '测试失败')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setTesting((t) => ({ ...t, [id]: false }))
    }
  }

  const removeNode = async (n: ProxyNode): Promise<void> => {
    if (!confirm(`确定删除节点「${n.name}」？`)) return
    await window.api.proxy.deleteNode(n.id)
    await load()
    toast.info('已删除')
  }

  const toggleSystemProxy = async (on: boolean): Promise<void> => {
    await window.api.proxy.setSystemProxy(on)
    await load()
  }

  if (!state) {
    return (
      <div className="page">
        <Empty title="正在加载代理状态…" />
      </div>
    )
  }

  return (
    <div className="page proxy-page">
      <div className="page-header">
        <div>
          <h1>
            <Icon name="proxy" size={22} /> 代理
          </h1>
          <div className="sub">支持 Xray / Mihomo / Sing-box 内核 · 自动生成配置 · 系统代理一键接管</div>
        </div>
        <div className="page-header-actions">
          <Button variant="text" icon="link" onClick={() => setImportOpen(true)}>
            导入链接
          </Button>
          <Button variant="text" icon="cloudDownload" onClick={() => setGeoOpen(true)}>
            路由文件
          </Button>
          <Button variant="filled" icon="add" onClick={() => setAddOpen(true)}>
            添加节点
          </Button>
        </div>
      </div>

      <div className="proxy-hero">
        <div className="power-wrap">
          <button
            className={`power-btn ${activeStatus ? 'on' : ''}`}
            onClick={() => (activeStatus ? void stop() : void start())}
            disabled={busy || (!selected && !activeStatus)}
            title={activeStatus ? '停止代理' : '启动代理'}
          >
            {busy ? <Spinner size={30} /> : <Icon name="power" size={34} />}
          </button>
        </div>
        <div className="power-meta">
          <h2>
            {activeStatus ? '代理运行中' : '代理未启动'}
            {activeStatus ? <Badge tone="ok" dot>已连接</Badge> : null}
          </h2>
          <div className="node-name">
            {selected ? `${selected.name} · ${formatProtocol(selected.protocol)} · ${selected.server}:${selected.port}` : '尚未选择节点'}
          </div>
          <div className="hstack" style={{ marginTop: 8, gap: 10, flexWrap: 'wrap' }}>
            <Chip icon="lan" selected={state.systemProxy} onClick={() => void toggleSystemProxy(!state.systemProxy)}>
              系统代理
            </Chip>
            {/* 分流模式：复活内核后生效 */}
            <Chip
              icon="language"
              selected={state.settings.routingMode === 'bypass'}
              onClick={() =>
                void window.api.settings.patch({ proxy: { routingMode: 'bypass' } }).then(() => {
                  toast.info('已切换为绕过大陆，重新启动内核后生效')
                  void load()
                })
              }
            >
              绕过大陆
            </Chip>
            <Chip
              icon="globe"
              selected={state.settings.routingMode === 'global'}
              onClick={() =>
                void window.api.settings.patch({ proxy: { routingMode: 'global' } }).then(() => {
                  toast.info('已切换为全局代理，重新启动内核后生效')
                  void load()
                })
              }
            >
              全局
            </Chip>
            <Chip
              icon="memory"
              onClick={() => {
                const ids: CoreId[] = ['xray', 'mihomo', 'singbox']
                const next = ids[(ids.indexOf(state.activeEngine) + 1) % 3]
                window.api.settings.patch({ proxy: { defaultEngine: next } }).then(() => load())
              }}
            >
              内核：{engineLabel(state.activeEngine)}
            </Chip>
            <Chip icon="update" onClick={() => setCoreUpdateOpen(true)}>
              内核更新
              {coreUpdates > 0 ? ` · ${coreUpdates}` : ''}
            </Chip>
          </div>
        </div>
        <div className="power-stats">
          <div className="pstat">
            <div className="k">混合端口</div>
            <div className="v">{state.settings.mixedPort}</div>
          </div>
          <div className="pstat">
            <div className="k">运行时长</div>
            <div className="v">
              {activeStatus?.startedAt ? fmtDuration(Date.now() - activeStatus.startedAt) : '—'}
            </div>
          </div>
          <div className="pstat">
            <div className="k">节点</div>
            <div className="v">{state.nodes.length}</div>
          </div>
        </div>
      </div>

      <div className="proxy-split">
        <section className="panel">
          <div className="panel-head">
            <h3>节点列表</h3>
            <span className="count">{filtered.length}</span>
            <span className="spacer" />
            <IconButton icon="refresh" small label="刷新" onClick={() => void load()} />
          </div>
          <div style={{ padding: '8px 10px 4px' }}>
            <div className="input-wrap" style={{ minHeight: 38, borderRadius: 999 }}>
              <span className="icon-prefix">
                <Icon name="search" size={18} />
              </span>
              <input
                className="input"
                placeholder="搜索节点"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ height: 36, fontSize: 13 }}
              />
            </div>
          </div>
          <div className="panel-scroll">
            {filtered.length === 0 ? (
              <Empty
                icon="proxy"
                title={state.nodes.length === 0 ? '还没有节点' : '没有匹配的节点'}
                desc={state.nodes.length === 0 ? '点击右上角「添加节点」，或从剪贴板导入分享链接。' : undefined}
              />
            ) : (
              filtered.map((n) => {
                const res = results[n.id]
                return (
                  <div
                    key={n.id}
                    className={`node-row ${state.selectedNodeId === n.id ? 'active' : ''}`}
                    onClick={() => void selectNode(n.id)}
                    onDoubleClick={() => void testNode(n.id)}
                  >
                    <span
                      className={`node-dot ${res ? (res.ok ? 'on' : 'err') : state.selectedNodeId === n.id ? 'on' : ''}`}
                    />
                    <div className="node-meta">
                      <div className="node-name">{n.name}</div>
                      <div className="node-sub">
                        <span className="proto-tag">{formatProtocol(n.protocol)}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.server}:{n.port}</span>
                        {res?.delayMs ? <span style={{ marginLeft: 'auto' }}>{res.delayMs}ms</span> : null}
                      </div>
                    </div>
                    <div className="row-actions">
                      <IconButton
                        icon="settings"
                        small
                        label="修改节点设置"
                        className="node-edit"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing(n)
                        }}
                      />
                      <IconButton
                        icon={testing[n.id] ? 'timer' : 'speed'}
                        small
                        label="测试延迟"
                        onClick={(e) => {
                          e.stopPropagation()
                          void testNode(n.id)
                        }}
                      />
                      <IconButton
                        icon="delete"
                        small
                        label="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          void removeNode(n)
                        }}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="detail-panel">
          <div className="detail-card">
            <h4>内核状态</h4>
            <div className="engine-grid">
              {(['xray', 'mihomo', 'singbox'] as CoreId[]).map((id) => {
                const cap = engines.find((e) => e.engine === id)
                const st = state.engines.find((e) => e.engine === id)
                const current = state.activeEngine === id
                // Only a RUNNING core gets the filled highlight. Selection is a
                // lighter outline: using the strong style for "selected" made the
                // card look active before the proxy was ever started.
                const running = st?.running === true
                return (
                  <button
                    key={id}
                    className={`engine-card ${running ? 'running' : ''} ${current && !running ? 'sel' : ''}`}
                    onClick={() => {
                      void window.api.settings.patch({ proxy: { defaultEngine: id } }).then(() => load())
                    }}
                    title={current ? '当前使用的内核' : '点击切换内核'}
                  >
                    <div className="en">
                      {engineLabel(id)}
                      {running ? <span className="node-dot on" /> : null}
                    </div>
                    <div className="ev">
                      {running ? '运行中' : cap?.available ? cap.version ?? '已就绪' : '未找到内核'}
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="hstack" style={{ marginTop: 12, gap: 16, flexWrap: 'wrap' }}>
              <div className="hstack" style={{ gap: 8 }}>
                <span className="tiny muted">系统代理</span>
                <Switch checked={state.systemProxy} onChange={(v) => void toggleSystemProxy(v)} />
              </div>
              <div className="hstack" style={{ gap: 8 }}>
                <span className="tiny muted">允许局域网</span>
                <Switch
                  checked={state.settings.allowLan}
                  onChange={(v) => void window.api.settings.patch({ proxy: { allowLan: v } }).then(() => load())}
                />
              </div>
              <div className="hstack" style={{ gap: 8 }}>
                <span className="tiny muted">启动时自动开启</span>
                <Switch
                  checked={state.settings.autoStart}
                  onChange={(v) => void window.api.settings.patch({ proxy: { autoStart: v } }).then(() => load())}
                />
              </div>
            </div>
          </div>

          {selected ? (
            <div className="detail-card">
              <h4>节点详情</h4>
              <div className="kv-grid">
                <span className="k">名称</span>
                <span className="v">{selected.name}</span>
                <span className="k">协议</span>
                <span className="v">{formatProtocol(selected.protocol)}</span>
                <span className="k">服务器</span>
                <span className="v">{selected.server}:{selected.port}</span>
                <span className="k">内核</span>
                <span className="v">{engineLabel(selected.engine)}</span>
                <span className="k">传输</span>
                <span className="v">{selected.network ?? 'tcp'}{selected.security && selected.security !== 'none' ? ` · ${selected.security}` : ''}</span>
                {selected.sni ? (
                  <>
                    <span className="k">SNI</span>
                    <span className="v">{selected.sni}</span>
                  </>
                ) : null}
                {selected.path ? (
                  <>
                    <span className="k">路径</span>
                    <span className="v">{selected.path}</span>
                  </>
                ) : null}
                {selected.uuid ? (
                  <>
                    <span className="k">UUID</span>
                    <span className="v">{selected.uuid}</span>
                  </>
                ) : null}
                {selected.method ? (
                  <>
                    <span className="k">加密</span>
                    <span className="v">{selected.method}</span>
                  </>
                ) : null}
              </div>
              <div className="hstack" style={{ marginTop: 12 }}>
                <Button size="sm" variant="tonal" icon="speed" onClick={() => void testNode(selected.id)}>
                  测试延迟
                </Button>
                <Button
                  size="sm"
                  variant="text"
                  icon="refresh"
                  onClick={async () => {
                    await window.api.settings.patch({ proxy: { defaultEngine: selected.engine } })
                    toast.info('已应用内核选择')
                    await load()
                  }}
                >
                  设为当前内核
                </Button>
              </div>
            </div>
          ) : null}

          {/* 内核日志：卡片本身是 flex 容器，日志框必须作为它的子项并被其高度约束，
              否则 .console 的 min-height 会把黑框顶到卡片外面 */}
          <div className="detail-card log-card">
            <div className="hstack" style={{ marginBottom: 8, flex: '0 0 auto' }}>
              <h4 style={{ margin: 0 }}>内核日志</h4>
              <span className="spacer" />
              <IconButton
                icon="delete"
                small
                label="清空"
                onClick={() => {
                  setLogs([])
                  void window.api.proxy.clearLogs(state.activeEngine)
                }}
              />
            </div>
            <div className="console">
              {logs.length === 0 ? (
                <div className="ln" style={{ opacity: 0.5 }}>
                  等待内核输出…
                </div>
              ) : (
                logs.slice(-120).map((l, i) => (
                  <div key={i} className={`ln ${l.level}`}>
                    <span className="ts">{new Date(l.at).toLocaleTimeString()}</span>
                    {l.line}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>

      <AddNodeDialog
        open={addOpen || editing !== null}
        onClose={() => {
          setAddOpen(false)
          setEditing(null)
        }}
        engines={engines}
        defaultEngine={state.activeEngine}
        editing={editing}
        onSaved={() => {
          setAddOpen(false)
          setEditing(null)
          void load()
        }}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          setImportOpen(false)
          void load()
        }}
      />
      <GeoDialog open={geoOpen} onClose={() => setGeoOpen(false)} state={state} onChanged={load} />
      <CoreUpdateDialog
        open={coreUpdateOpen}
        onClose={() => setCoreUpdateOpen(false)}
        onFinished={() => {
          void refreshCoreUpdates()
          void load()
        }}
      />
    </div>
  )
}

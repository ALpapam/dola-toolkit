// ---------------------------------------------------------------------------
// 主菜单
//
// Three full-height pages with scroll snapping:
//
//   1  welcome   logo + greeting + a small down chevron
//   2  shortcuts installed tools as desktop icons, DRAGGABLE to reorder
//   3  status    what the app is currently providing; mods add rows via
//                window.__DOLA_STATUS__
//
// Two gestures change page: the wheel, and dragging the page up/down with the mouse
// (press anywhere that is not a shortcut, pull, release to snap).
//
// The shortcut grid keeps its own order (`homeOrder`), independent of the sidebar.
// Reordering uses FLIP: positions are snapshotted before the array changes, each
// displaced tile is transformed back to where it was, then released into its new slot.
// The dragged tile follows the pointer using a delta captured at drag start — never a
// live getBoundingClientRect of itself, which would feed the transform back into its
// own position and make it drift.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

interface Shortcut {
  id: string
  name: string
  icon: string
}

type AiState = AIStatus | null
type SyncState = SyncStatus | null

export function HomePage(): JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const mods = useApp((s) => s.mods)
  const homeOrder = useApp((s) => s.homeOrder)
  const setHomeOrder = useApp((s) => s.setHomeOrder)
  const openSettings = useApp((s) => s.openSettings)

  const [proxy, setProxy] = useState<ProxyState | null>(null)
  const [ai, setAi] = useState<AiState>(null)
  const [sync, setSync] = useState<SyncState>(null)
  const [modStatus, setModStatus] = useState<StatusLine[]>([])

  const scrollerRef = useRef<HTMLDivElement | null>(null)

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

  const goTo = useCallback((index: number): void => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ top: index * el.clientHeight, behavior: 'smooth' })
  }, [])

  /*
   * ---- drag the page up/down to change page ----
   *
   * Snapping fights a drag: `scroll-snap-type: y mandatory` re-snaps the programmatic
   * `scrollTop` on the next frame, so the page springs back mid-gesture. The class
   * `dragging-page` disables snapping for the duration, and the target page is derived
   * from the drag distance rather than from the (unstable) final scroll offset.
   */
  const pageDrag = useRef<{ startY: number; lastY: number; startScroll: number; moved: boolean } | null>(null)
  const [pageDragging, setPageDragging] = useState(false)

  const onPagePointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    // the shortcut grid owns its own drag gesture
    if ((e.target as Element).closest('.shortcut')) return
    const el = scrollerRef.current
    if (!el) return
    pageDrag.current = { startY: e.clientY, lastY: e.clientY, startScroll: el.scrollTop, moved: false }
  }

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = pageDrag.current
      const el = scrollerRef.current
      if (!drag || !el) return
      drag.lastY = e.clientY
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dy) > 4) {
        drag.moved = true
        setPageDragging(true)
      }
      if (!drag.moved) return
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.max(0, Math.min(max, drag.startScroll - dy))
    }
    const onUp = (): void => {
      const drag = pageDrag.current
      pageDrag.current = null
      setPageDragging(false)
      const el = scrollerRef.current
      if (!drag || !el || !drag.moved) return
      // how far the drag travelled, in pages, from where it started: dragging up
      // (negative dy) must advance to the next page
      const travelled = (drag.startY - drag.lastY) / el.clientHeight
      const startIndex = Math.round(drag.startScroll / el.clientHeight)
      goTo(Math.max(0, Math.min(2, Math.round(startIndex + travelled))))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [goTo])

  /* ---- shortcuts: own order first, then anything newly installed ---- */
  const allShortcuts: Shortcut[] = [
    ...BUILTIN_TOOLS.map((t) => ({ id: t.id, name: t.name, icon: t.icon })),
    ...mods.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name, icon: m.icon }))
  ]
  const shortcutOrder: string[] = (() => {
    const known = new Set(allShortcuts.map((s) => s.id))
    const ordered = homeOrder.filter((id) => known.has(id))
    for (const s of allShortcuts) if (!ordered.includes(s.id)) ordered.push(s.id)
    return ordered
  })()
  const shortcuts = shortcutOrder
    .map((id) => allShortcuts.find((s) => s.id === id))
    .filter((s): s is Shortcut => Boolean(s))

  return (
    <div
      className={`home-scroll ${pageDragging ? 'dragging-page' : ''}`}
      ref={scrollerRef}
      onPointerDown={onPagePointerDown}
    >
      <WelcomePage onNext={() => goTo(1)} />
      <ShortcutPage
        shortcuts={shortcuts}
        onOpen={setPage}
        onAdd={() => setPage('add-tool')}
        onReorder={setHomeOrder}
        onNext={() => goTo(2)}
      />
      <StatusPage
        proxy={proxy}
        ai={ai}
        sync={sync}
        modCount={mods.length}
        extra={modStatus}
        onOpenSettings={openSettings}
        onOpenPage={setPage}
        onTop={() => goTo(0)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* page 1                                                              */
/* ------------------------------------------------------------------ */

function WelcomePage({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <section className="home-page home-welcome">
      <div className="home-welcome-inner">
        <img className="home-logo" src={logoUrl} alt="" draggable={false} />
        <h1 className="home-greeting">欢迎使用 Dola Toolkit~φ(゜▽゜*)♪</h1>
      </div>
      <button type="button" className="home-chevron" onClick={onNext} aria-label="下一页" title="下一页">
        <Icon name="expandMore" size={22} />
      </button>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* page 2 — draggable shortcut grid                                    */
/* ------------------------------------------------------------------ */

interface ShortcutPageProps {
  shortcuts: Shortcut[]
  onOpen: (id: string) => void
  onAdd: () => void
  onReorder: (ids: string[]) => void
  onNext: () => void
}

function ShortcutPage({ shortcuts, onOpen, onAdd, onReorder, onNext }: ShortcutPageProps): JSX.Element {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef(new Map<string, HTMLButtonElement>())
  /** positions captured before a reorder, consumed by the FLIP effect below */
  const flipRef = useRef<Map<string, DOMRect>>(new Map())
  /** the live order, so the pointerup handler never closes over a stale array */
  const orderRef = useRef<string[]>([])
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)

  const [dragId, setDragId] = useState<string | null>(null)
  /** pointer position and grab offset, so the dragged tile can be re-anchored each frame */
  const pointerRef = useRef({ x: 0, y: 0 })
  const grabRef = useRef({ dx: 0, dy: 0 })
  // a counter used only to force a render on each pointer move
  const [, setTick] = useState(0)
  /** set after a drag that moved: the click Chromium fires next must not open the tool */
  const suppressClick = useRef(false)

  useEffect(() => {
    orderRef.current = shortcuts.map((s) => s.id)
  }, [shortcuts])

  /** Apply the inverse offset, then release it so tiles slide into their new slot. */
  useLayoutEffect(() => {
    const prev = flipRef.current
    if (prev.size === 0) return
    flipRef.current = new Map()
    for (const [id, el] of tileRefs.current) {
      const before = prev.get(id)
      if (!before) continue
      const after = el.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (!dx && !dy) continue
      el.style.transition = 'none'
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = ''
      })
    }
  })

  /*
   * Keep the dragged tile under the cursor.
   *
   * A fixed `translate(dx, dy)` measured from drag start drifts: reordering changes the
   * tile's LAYOUT slot, so the same offset is applied on top of a moving base and the
   * icon escapes the pointer further with every swap. Here the transform is recomputed
   * from the tile's current layout box on every frame, which is self-correcting.
   */
  useLayoutEffect(() => {
    if (!dragId) return
    const el = tileRefs.current.get(dragId)
    if (!el) return
    const p = pointerRef.current
    const g = grabRef.current
    // read the untransformed box, then place it under the pointer
    el.style.transform = 'none'
    const box = el.getBoundingClientRect()
    const dx = p.x - g.dx - box.left
    const dy = p.y - g.dy - box.top
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.06)`
    el.style.transition = 'none'
    el.style.zIndex = '3'
  })

  const snapshot = (skipId: string | null): void => {
    const map = new Map<string, DOMRect>()
    for (const [id, el] of tileRefs.current) {
      // the dragged tile is following the pointer; its rect would poison the FLIP maths
      if (id === skipId) continue
      map.set(id, el.getBoundingClientRect())
    }
    flipRef.current = map
  }

  /**
   * Slot index under the pointer, derived from the GRID's geometry.
   *
   * Hit-testing the tiles themselves caused the jitter: the dragged tile carries a
   * transform that follows the pointer, so its own rect kept moving with the cursor and
   * repeatedly "won" the nearest-centre test — the order then flip-flopped every frame.
   * Reading columns/gaps from the container is stable regardless of transforms.
   */
  const slotAt = (x: number, y: number): number | null => {
    const grid = gridRef.current
    const count = orderRef.current.length
    if (!grid || count === 0) return null
    const rect = grid.getBoundingClientRect()
    const style = getComputedStyle(grid)
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean)
    const cols = Math.max(1, columns.length)
    const gapX = parseFloat(style.columnGap) || 0
    const gapY = parseFloat(style.rowGap) || 0
    const cellW = (rect.width - gapX * (cols - 1)) / cols

    // tile height is uniform; take it from any rendered tile
    const sample = tileRefs.current.get(orderRef.current[0] ?? '')
    const cellH = (sample?.offsetHeight ?? 88) + gapY

    const localX = x - rect.left
    const localY = y - rect.top + grid.scrollTop
    const col = Math.max(0, Math.min(cols - 1, Math.floor(localX / (cellW + gapX))))
    const row = Math.max(0, Math.floor(localY / cellH))
    return Math.max(0, Math.min(count - 1, row * cols + col))
  }

  const endDrag = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    suppressClick.current = Boolean(drag?.moved)
    if (drag?.moved) {
      window.setTimeout(() => {
        suppressClick.current = false
      }, 350)
    }
    setDragId(null)
  }

  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      drag.moved = true
      pointerRef.current = { x: e.clientX, y: e.clientY }
      setTick((n) => n + 1)

      const target = slotAt(e.clientX, e.clientY)
      if (target === null) return
      const current = orderRef.current
      const from = current.indexOf(drag.id)
      if (from < 0 || target === from) return
      const next = current.filter((id) => id !== drag.id)
      next.splice(target, 0, drag.id)
      snapshot(drag.id)
      onReorder(next)
    }
    const onUp = (): void => endDrag()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId])

  const beginDrag = (id: string) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    suppressClick.current = false
    const el = tileRefs.current.get(id)
    if (el) {
      const box = el.getBoundingClientRect()
      grabRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    }
    pointerRef.current = { x: e.clientX, y: e.clientY }
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false }
    setDragId(id)
  }

  return (
    <section className="home-page home-shortcuts">
      <header className="home-page-head">
        <span className="home-page-title">我的工具</span>
        <span className="tiny muted">拖动图标调整顺序，点击进入</span>
      </header>
      <div className="shortcut-grid" role="list" ref={gridRef}>
        {shortcuts.map((s) => {
          const isDragged = dragId === s.id
          return (
            <button
              key={s.id}
              role="listitem"
              ref={(el) => {
                if (el) tileRefs.current.set(s.id, el)
                else tileRefs.current.delete(s.id)
              }}
              className={`shortcut ${isDragged ? 'dragging' : ''}`}
              style={isDragged ? { zIndex: 3 } : undefined}
              onPointerDown={beginDrag(s.id)}
              onClick={() => {
                // pointerup clears dragRef before this fires, so consult the flag
                if (suppressClick.current) return
                onOpen(s.id)
              }}
              aria-label={s.name}
              title={s.name}
            >
              <span className="shortcut-icon">
                <Icon name={s.icon as IconName} size={26} />
              </span>
              <span className="shortcut-label">{s.name}</span>
            </button>
          )
        })}
        <button className="shortcut shortcut-add" onClick={onAdd} aria-label="添加工具" title="添加工具">
          <span className="shortcut-icon">
            <Icon name="add" size={26} />
          </span>
          <span className="shortcut-label">添加</span>
        </button>
      </div>
      <button type="button" className="home-chevron" onClick={onNext} aria-label="下一页" title="下一页">
        <Icon name="expandMore" size={22} />
      </button>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* page 3                                                              */
/* ------------------------------------------------------------------ */

interface StatusPageProps {
  proxy: ProxyState | null
  ai: AiState
  sync: SyncState
  modCount: number
  extra: StatusLine[]
  onOpenSettings: (section?: string) => void
  onOpenPage: (page: string) => void
  onTop: () => void
}

function StatusPage({
  proxy,
  ai,
  sync,
  modCount,
  extra,
  onOpenSettings,
  onOpenPage,
  onTop
}: StatusPageProps): JSX.Element {
  return (
    <section className="home-page home-status">
      <header className="home-page-head">
        <span className="home-page-title">运行状态</span>
        <span className="tiny muted">当前软件提供的服务</span>
      </header>
      <div className="status-list">
        {buildStatus(proxy, ai, sync, modCount).map((row) => (
          <button
            key={row.id}
            type="button"
            className="status-row"
            onClick={() => {
              const target = row.section
              // a tool's settings is a page of its own; app settings need the section
              if (target?.startsWith('mod-settings:')) onOpenPage(target)
              else onOpenSettings(target)
            }}
            title={`打开${row.label}设置`}
          >
            <span className={`status-dot ${row.tone}`} />
            <span className="status-label">{row.label}</span>
            <span className="status-value">{row.value}</span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
        {extra.map((row) => (
          <div key={row.id} className="status-row static">
            <span className={`status-dot ${row.tone}`} />
            <span className="status-label">{row.label}</span>
            <span className="status-value">{row.value}</span>
          </div>
        ))}
      </div>
      <button type="button" className="home-chevron up" onClick={onTop} aria-label="回到顶部" title="回到顶部">
        <Icon name="expandMore" size={22} />
      </button>
    </section>
  )
}

/** Rows describing what the app is currently doing. */
function buildStatus(proxy: ProxyState | null, ai: AiState, sync: SyncState, modCount: number): StatusLine[] {
  const running = proxy?.engines.find((e) => e.running) ?? null
  return [
    {
      id: 'proxy',
      label: '代理服务',
      value: running ? `运行中 · ${engineLabel(running.engine)}` : '未启动',
      tone: running ? 'ok' : 'idle',
      section: 'mod-settings:proxy'
    },
    {
      id: 'nodes',
      label: '节点',
      value: proxy ? `${proxy.nodes?.length ?? 0} 个` : '—',
      tone: proxy ? 'ok' : 'idle',
      section: 'mod-settings:proxy'
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

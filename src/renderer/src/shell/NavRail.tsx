// ---------------------------------------------------------------------------
// Dola Toolkit — navigation rail
//
// One list holds built-in tools and installed mods. The "+" entry sits after every
// tool, and Settings stays pinned in the footer.
//
// Reordering is pointer-driven rather than HTML5 drag-and-drop. The old version
// reordered on `dragover` and let the browser re-lay-out the list, which is why the
// movement looked abrupt — every change snapped. Here the DOM order stays fixed while
// dragging: each tile is offset with a transform that animates, and the dragged tile
// follows the pointer. The new order is committed once, on release.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, BUILTIN_TOOLS } from '../state/app'
import { Icon, type IconName } from '../ui/Icon'
import { APP_VERSION_LABEL, APP_NAME } from '@shared/version'
// Vite inlines this as an asset URL at build time.
import logoUrl from '../assets/logo-64.png'

/** Every rail entry: built-in tools and mods merged into one ordered list. */
interface RailEntry {
  id: string
  name: string
  icon: string
  mod: boolean
}

export function NavRail(): JSX.Element {
  const railExpanded = useApp((s) => s.railExpanded)
  const setRailExpanded = useApp((s) => s.setRailExpanded)
  const order = useApp((s) => s.railOrder)
  const setOrder = useApp((s) => s.setRailOrder)
  const mods = useApp((s) => s.mods)
  const page = useApp((s) => s.page)

  const listRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  /** distance between two tile tops, measured when a drag starts */
  const pitchRef = useRef(56)

  const [dragId, setDragId] = useState<string | null>(null)
  /** pointer travel since dragstart, in px */
  const [dragDelta, setDragDelta] = useState(0)
  /** slot the dragged tile would occupy if released now */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const dragStart = useRef(0)
  const moved = useRef(false)

  const entries = useMemo<RailEntry[]>(() => {
    const builtins: RailEntry[] = BUILTIN_TOOLS.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      mod: false
    }))
    const modEntries: RailEntry[] = mods
      .filter((m) => m.enabled)
      .map((m) => ({ id: m.id, name: m.name, icon: m.icon, mod: true }))

    const byId = new Map<string, RailEntry>()
    for (const e of [...builtins, ...modEntries]) byId.set(e.id, e)

    const ordered: RailEntry[] = []
    for (const id of order) {
      const entry = byId.get(id)
      if (entry) {
        ordered.push(entry)
        byId.delete(id)
      }
    }
    // anything missing from the stored order (a freshly installed mod) goes last
    for (const entry of byId.values()) ordered.push(entry)
    return ordered
  }, [mods, order])

  /** Commit the pending order once the pointer is released. */
  const stopDrag = useCallback(
    (commit: boolean): void => {
      if (commit && dragId && dragIndex !== null) {
        const ids = entries.map((e) => e.id)
        const from = ids.indexOf(dragId)
        if (from >= 0 && dragIndex !== from) {
          const next = ids.filter((id) => id !== dragId)
          next.splice(dragIndex, 0, dragId)
          setOrder(next)
        }
      }
      setDragId(null)
      setDragIndex(null)
      setDragDelta(0)
      moved.current = false
    },
    [dragId, dragIndex, entries, setOrder]
  )

  /* pointer moves outside the rail must still finish the drag */
  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent): void => {
      const delta = e.clientY - dragStart.current
      setDragDelta(delta)
      if (Math.abs(delta) > 4) moved.current = true

      const pitch = pitchRef.current
      const from = entries.findIndex((x) => x.id === dragId)
      if (from < 0) return
      // the tile's own centre, in list coordinates
      const target = Math.round(from + delta / pitch)
      setDragIndex(Math.max(0, Math.min(entries.length - 1, target)))
    }
    const onUp = (): void => stopDrag(true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragId, entries, stopDrag])

  const beginDrag = (id: string) => (e: React.PointerEvent): void => {
    // only the primary button starts a reorder
    if (e.button !== 0) return
    const list = listRef.current
    if (list) {
      const tops = [...itemRefs.current.values()].map((el) => el.offsetTop).sort((a, b) => a - b)
      if (tops.length > 1) pitchRef.current = tops[1] - tops[0] || 56
    }
    dragStart.current = e.clientY
    moved.current = false
    setDragId(id)
    setDragIndex(entries.findIndex((x) => x.id === id))
    setDragDelta(0)
  }

  const openPage = (id: string): void => {
    // a drag that ends on the tile must not also navigate
    if (moved.current) return
    useApp.getState().setPage(id)
  }

  return (
    <nav className={`rail ${railExpanded ? 'expanded' : ''}`} aria-label="工具">
      {/* brand — the app icon sits centred on the rail axis when collapsed */}
      <div className="rail-brand" onDoubleClick={() => setRailExpanded(!railExpanded)}>
        {/* the brand strip is a window-drag region, and drag regions swallow
            clicks — the icon opts out of dragging so tapping it can go home */}
        <button
          type="button"
          className="rail-brand-logo"
          title="返回主页"
          aria-label="返回主页"
          onClick={() => useApp.getState().setPage('home')}
        >
          <img src={logoUrl} alt="" draggable={false} />
        </button>
        <span className="rail-brand-title">
          <span className="rail-brand-name">{APP_NAME}</span>
          <span className="rail-brand-sub">{APP_VERSION_LABEL}</span>
        </span>
      </div>

      <div className={`rail-scroll ${dragId ? 'reordering' : ''}`} role="list" ref={listRef}>
        {entries.map((t, index) => {
          const isDragged = dragId === t.id
          /** where this tile visually belongs while a drag is in progress */
          let shift = 0
          if (dragId && dragIndex !== null && !isDragged) {
            const from = entries.findIndex((x) => x.id === dragId)
            if (from < index && dragIndex >= index) shift = -1
            else if (from > index && dragIndex <= index) shift = 1
          }
          const transform = isDragged
            ? `translateY(${dragDelta}px)`
            : shift !== 0
              ? `translateY(${shift * pitchRef.current}px)`
              : undefined

          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) itemRefs.current.set(t.id, el)
                else itemRefs.current.delete(t.id)
              }}
              role="listitem"
              className={[
                'rail-item',
                'rail-slot',
                page === t.id ? 'active' : '',
                isDragged ? 'dragging' : '',
                !isDragged && shift !== 0 ? 'shifted' : '',
                t.mod ? 'is-mod' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                transform,
                // the dragged tile must render above the ones sliding under it
                zIndex: isDragged ? 3 : undefined,
                transition: isDragged ? 'none' : undefined
              }}
              onPointerDown={beginDrag(t.id)}
              onClick={() => openPage(t.id)}
              title={railExpanded ? undefined : t.name}
              aria-label={t.name}
              aria-current={page === t.id ? 'page' : undefined}
            >
              {/* a drag affordance: three bars to the left of a mod's icon */}
              {t.mod ? (
                <span className="rail-item-grip" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
              <span className="rail-item-icon">
                <Icon name={t.icon as IconName} size={22} />
              </span>
              <span className="rail-item-label">{t.name}</span>
            </button>
          )
        })}

        {/* always after every tool, per the requested layout */}
        <button
          className={`rail-item rail-add ${page === 'add-tool' ? 'active' : ''}`}
          onClick={() => useApp.getState().setPage('add-tool')}
          title={railExpanded ? undefined : '添加工具'}
          aria-label="添加工具"
          aria-current={page === 'add-tool' ? 'page' : undefined}
        >
          <span className="rail-item-icon">
            <Icon name="add" size={22} />
          </span>
          <span className="rail-item-label">添加工具</span>
        </button>
      </div>

      <div className="rail-footer">
        <button
          className="rail-expand-btn"
          onClick={() => setRailExpanded(!railExpanded)}
          title={railExpanded ? '收起工具栏' : '展开工具栏'}
          aria-label={railExpanded ? '收起工具栏' : '展开工具栏'}
          aria-expanded={railExpanded}
        >
          <span className="rail-item-icon">
            <Icon name={railExpanded ? 'collapse' : 'expand'} size={20} />
          </span>
          <span className="rail-item-label">{railExpanded ? '收起工具栏' : '展开工具栏'}</span>
        </button>

        {/* pinned last: settings stays reachable whatever the tool count is */}
        <button
          className={`rail-item rail-item-pinned ${page === 'settings' ? 'active' : ''}`}
          onClick={() => useApp.getState().setPage('settings')}
          title={railExpanded ? undefined : '设置'}
          aria-label="设置"
          aria-current={page === 'settings' ? 'page' : undefined}
        >
          <span className="rail-item-icon">
            <Icon name="settings" size={22} />
          </span>
          <span className="rail-item-label">设置</span>
        </button>
      </div>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Dola Toolkit — navigation rail
//
// One list holds built-in tools and installed mods, reorderable by dragging. The "+"
// entry sits after every tool (always last in the scroll area), and Settings stays
// pinned in the footer.
//
// Reordering follows the Android launcher feel: the dragged item is lifted, and the
// items it passes slide out of the way with a transition instead of jumping when the
// drop lands. The move happens while dragging (on every tile change), which is what
// produces the animation.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from 'react'
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

  const [dragId, setDragId] = useState<string | null>(null)

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

  /**
   * Moves the dragged entry into the slot under the pointer.
   *
   * Called on every dragover where the target tile changed, so the list reorders
   * continuously and the CSS transition animates the displaced items.
   */
  const moveTo = useCallback(
    (targetId: string, above: boolean): void => {
      if (!dragId || dragId === targetId) return
      const ids = entries.map((e) => e.id)
      const from = ids.indexOf(dragId)
      if (from < 0 || ids.indexOf(targetId) < 0) return

      const next = ids.filter((id) => id !== dragId)
      let insertAt = next.indexOf(targetId)
      if (insertAt < 0) return
      if (!above) insertAt += 1
      if (insertAt === from) return
      next.splice(insertAt, 0, dragId)
      setOrder(next)
    },
    [dragId, entries, setOrder]
  )

  const onDragStart = (id: string) => (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  const onDragOver = (id: string) => (e: React.DragEvent): void => {
    if (!dragId || dragId === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    moveTo(id, e.clientY < rect.top + rect.height / 2)
  }

  const endDrag = (): void => setDragId(null)

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

      <div className={`rail-scroll ${dragId ? 'reordering' : ''}`} role="list">
        {entries.map((t) => (
          <button
            key={t.id}
            role="listitem"
            className={[
              'rail-item',
              'rail-slot',
              page === t.id ? 'active' : '',
              dragId === t.id ? 'dragging' : '',
              t.mod ? 'is-mod' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={onDragStart(t.id)}
            onDragOver={onDragOver(t.id)}
            onDrop={(e) => {
              e.preventDefault()
              endDrag()
            }}
            onDragEnd={endDrag}
            onClick={() => useApp.getState().setPage(t.id)}
            title={railExpanded ? undefined : t.name}
            aria-label={t.name}
            aria-current={page === t.id ? 'page' : undefined}
          >
            <span className="rail-item-icon">
              <Icon name={t.icon as IconName} size={22} />
            </span>
            <span className="rail-item-label">{t.name}</span>
          </button>
        ))}

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

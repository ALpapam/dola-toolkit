import { useState } from 'react'
import { useApp, BUILTIN_TOOLS } from '../state/app'
import { Icon, type IconName } from '../ui/Icon'
import { APP_VERSION_LABEL, APP_NAME } from '@shared/version'
// Vite inlines this as an asset URL at build time.
import logoUrl from '../assets/logo-64.png'

/* ------------------------------------------------------------------ */
/* Draggable + reorderable navigation rail                             */
/*                                                                     */
/* Layout contract (see .rail in base.css):                            */
/*   collapsed → --rail-w (88px), every icon centred on the rail axis  */
/*   expanded  → --rail-w-expanded (236px), labels fade in              */
/* The settings entry is pinned to the footer and never joins the      */
/* drag list, so it stays reachable no matter how many tools exist.    */
/* ------------------------------------------------------------------ */
export function NavRail(): JSX.Element {
  const railExpanded = useApp((s) => s.railExpanded)
  const setRailExpanded = useApp((s) => s.setRailExpanded)
  const order = useApp((s) => s.railOrder)
  const setOrder = useApp((s) => s.setRailOrder)
  const page = useApp((s) => s.page)

  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [overAbove, setOverAbove] = useState(true)

  const tools = order
    .map((id) => BUILTIN_TOOLS.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))

  const onDragStart = (id: string) => (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  const onDragOver = (id: string) => (e: React.DragEvent): void => {
    if (!dragId || dragId === id) return
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverId(id)
    setOverAbove(e.clientY < rect.top + rect.height / 2)
  }

  const onDrop = (id: string) => (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!dragId || dragId === id) {
      setDragId(null)
      setOverId(null)
      return
    }
    const next = order.filter((x) => x !== dragId)
    const targetIdx = next.indexOf(id)
    const insertAt = overAbove ? targetIdx : targetIdx + 1
    next.splice(insertAt, 0, dragId)
    setOrder(next)
    setDragId(null)
    setOverId(null)
  }

  return (
    <nav className={`rail ${railExpanded ? 'expanded' : ''}`} aria-label="工具">
      {/* brand — the app icon sits centred on the rail axis when collapsed */}
      <div className="rail-brand" onDoubleClick={() => setRailExpanded(!railExpanded)}>
        <span className="rail-brand-logo">
          <img src={logoUrl} alt="" draggable={false} />
        </span>
        <span className="rail-brand-title">
          <span className="rail-brand-name">{APP_NAME}</span>
          <span className="rail-brand-sub">{APP_VERSION_LABEL}</span>
        </span>
      </div>

      <div className="rail-scroll" role="list">
        {tools.map((t) => (
          <button
            key={t.id}
            role="listitem"
            className={[
              'rail-item',
              page === t.id ? 'active' : '',
              dragId === t.id ? 'dragging' : '',
              overId === t.id && overAbove ? 'drop-above' : '',
              overId === t.id && !overAbove ? 'drop-below' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={onDragStart(t.id)}
            onDragOver={onDragOver(t.id)}
            onDrop={onDrop(t.id)}
            onDragEnd={() => {
              setDragId(null)
              setOverId(null)
            }}
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

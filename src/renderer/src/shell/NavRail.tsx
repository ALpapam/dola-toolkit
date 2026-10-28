// ---------------------------------------------------------------------------
// Dola Toolkit — navigation rail
//
// One list holds built-in tools and installed mods. The "+" entry sits after every
// tool, and Settings stays pinned in the footer.
//
// Reordering is pointer-driven, not HTML5 drag-and-drop, and the geometry is computed
// from ABSOLUTE positions rather than accumulated deltas.
//
// Why: the previous version tracked `clientY - startY` and re-subscribed its window
// listeners whenever React re-rendered (the callbacks closed over state). The first
// move could therefore run against a stale start position and offset the tile by
// hundreds of pixels — the "icon jumps up, then snaps back" report. Everything below
// reads from refs, so the handlers never go stale, and each frame recomputes the
// offset from the tile's own starting position.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

/** Everything a drag needs, kept in one ref so handlers stay stable. */
interface DragSession {
  id: string
  /** pointer offset inside the tile when the drag began */
  grabOffset: number
  /** the tile's untransformed top, in list coordinates */
  startTop: number
  /** distance between two tile tops */
  pitch: number
  /** ids in their rendered order at drag start */
  ids: string[]
  moved: boolean
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
  const session = useRef<DragSession | null>(null)
  /**
   * True right after a drag that actually moved the tile.
   *
   * `endDrag` clears the session, and the `click` that Chromium synthesises after
   * pointerup fires *later* — so checking `session.current` there always saw null and
   * navigated anyway. That is why dragging up (where the pointer often ends back over
   * the same tile) opened the tool while dragging down did not.
   */
  const suppressClick = useRef(false)
  /** rect of the dragged tile at release, used to animate it into its final slot */
  const settle = useRef<{ id: string; rect: DOMRect } | null>(null)

  const [dragId, setDragId] = useState<string | null>(null)
  const [dragDelta, setDragDelta] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

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

  /** Ends the drag; `commit` applies the pending slot to the stored order. */
  const endDrag = useCallback(
    (commit: boolean): void => {
      const drag = session.current
      session.current = null
      if (drag?.moved) {
        const el = itemRefs.current.get(drag.id)
        // remember where the tile visually is, so the commit can glide it into place
        // instead of teleporting to its new slot
        if (el) settle.current = { id: drag.id, rect: el.getBoundingClientRect() }
      }
      // a moved drag must swallow the click that follows
      suppressClick.current = Boolean(drag?.moved)
      if (drag?.moved) {
        window.setTimeout(() => {
          suppressClick.current = false
        }, 350)
      }
      if (commit && drag) {
        const target = dragIndexRef.current
        if (target !== null) {
          const ids = drag.ids
          const from = ids.indexOf(drag.id)
          if (from >= 0 && target !== from) {
            const next = ids.filter((id) => id !== drag.id)
            next.splice(target, 0, drag.id)
            setOrder(next)
          }
        }
      }
      setDragId(null)
      setDragIndex(null)
      setDragDelta(0)
    },
    [setOrder]
  )

  /* dragIndex is read inside endDrag, which must stay referentially stable */
  const dragIndexRef = useRef<number | null>(null)
  useEffect(() => {
    dragIndexRef.current = dragIndex
  }, [dragIndex])

  /*
   * One subscription per drag. Dependencies are only `dragId`, and every value the
   * handlers need comes from the refs — so no handler can ever run against a stale
   * closure.
   */
  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent): void => {
      const drag = session.current
      const list = listRef.current
      if (!drag || !list) return

      // absolute pointer → how far the tile wants to travel from where it started
      const listTop = list.getBoundingClientRect().top + list.scrollTop
      const desiredTop = e.clientY - listTop - drag.grabOffset
      const offset = desiredTop - drag.startTop
      if (Math.abs(offset) > 3) drag.moved = true
      setDragDelta(offset)

      const from = drag.ids.indexOf(drag.id)
      if (from < 0) return
      // the slot whose centre the tile now overlaps
      const target = Math.round(from + offset / drag.pitch)
      const clamped = Math.max(0, Math.min(drag.ids.length - 1, target))
      setDragIndex((prev) => (prev === clamped ? prev : clamped))
    }
    const onUp = (): void => endDrag(true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragId, endDrag])

  /*
   * Settle animation.
   *
   * On release the list re-renders in its new order, so the dragged tile's layout
   * position jumps by up to half a slot while its inline transform is dropped in the
   * same frame — that is the "jumps up after dropping" report. Here the tile is put
   * back where it visually was and released into its slot over 180ms.
   */
  useLayoutEffect(() => {
    const pending = settle.current
    if (!pending) return
    settle.current = null
    const el = itemRefs.current.get(pending.id)
    if (!el) return
    const now = el.getBoundingClientRect()
    const dx = pending.rect.left - now.left
    const dy = pending.rect.top - now.top
    if (!dx && !dy) return
    el.style.transition = 'none'
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    // two frames: the first paints the corrected position, the second starts the
    // transition from it (one frame can be coalesced into a single style recalc, which
    // skips the animation and snaps)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = ''
      })
    })
  })

  const beginDrag = (id: string) => (e: React.PointerEvent): void => {
    // only the primary button starts a reorder
    if (e.button !== 0) return
    const el = itemRefs.current.get(id)
    const list = listRef.current
    if (!el || !list) return

    /*
     * Measure from LAYOUT offsets, never from getBoundingClientRect.
     *
     * Rect positions include the transforms this component applies, so measuring them
     * while neighbouring tiles are mid-animation produced a wrong pitch — and a wrong
     * pitch makes the target index jump several slots at a time (the "一跳一跳" report).
     * offsetTop is the untransformed layout position, which is exactly what we want.
     */
    const tops = [...itemRefs.current.values()].map((node) => node.offsetTop).sort((a, b) => a - b)
    const pitch = tops.length > 1 ? tops[1] - tops[0] : el.offsetHeight + 4
    const tileTop = el.offsetTop

    // clear any transform left over from a previous drag on this very tile
    el.style.transform = ''
    el.style.transition = ''

    session.current = {
      id,
      grabOffset: e.clientY - list.getBoundingClientRect().top + list.scrollTop - tileTop,
      startTop: tileTop,
      pitch: pitch > 8 ? pitch : el.offsetHeight + 4,
      ids: entries.map((x) => x.id),
      moved: false
    }
    setDragId(id)
    setDragIndex(entries.findIndex((x) => x.id === id))
    setDragDelta(0)
  }

  const openPage = (id: string): void => {
    // a drag that ends on the tile must not also navigate
    if (suppressClick.current) return
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
            ? `translate3d(0, ${dragDelta}px, 0)`
            : shift !== 0
              ? `translate3d(0, ${shift * (session.current?.pitch ?? 56)}px, 0)`
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
                zIndex: isDragged ? 3 : undefined,
                transition: isDragged ? 'none' : undefined
              }}
              onPointerDown={beginDrag(t.id)}
              onClick={() => openPage(t.id)}
              title={railExpanded ? undefined : t.name}
              aria-label={t.name}
              aria-current={page === t.id ? 'page' : undefined}
            >
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

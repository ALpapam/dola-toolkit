// ---------------------------------------------------------------------------
// 设置 → 工具
//
// Lists installed mods (open / settings / remove), lets the user reorder them with a
// drag handle, and documents the package format. A mod's own settings screen is a
// secondary page (`mod-settings:<id>`), reached by the 设置 button.
//
// Reordering is pointer-driven like the rail: DOM order stays fixed, tiles are offset
// with an animating transform, and the new order is committed on release.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModRecordInfo } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, Dialog, Empty } from '../../ui/controls'
import { toast } from '../../ui/toast'

export function ToolsSection(): JSX.Element {
  const mods = useApp((s) => s.mods)
  const refreshMods = useApp((s) => s.refreshMods)
  const setPage = useApp((s) => s.setPage)
  const [busy, setBusy] = useState<string | null>(null)
  /** mod pending deletion confirmation */
  const [confirming, setConfirming] = useState<ModRecordInfo | null>(null)

  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const pitchRef = useRef(72)
  const dragStart = useRef(0)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragDelta, setDragDelta] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  useEffect(() => {
    void refreshMods()
  }, [refreshMods])

  const commit = useCallback(
    (release: boolean): void => {
      if (release && dragId && dragIndex !== null) {
        const ids = mods.map((m) => m.id)
        const from = ids.indexOf(dragId)
        if (from >= 0 && dragIndex !== from) {
          const next = ids.filter((id) => id !== dragId)
          next.splice(dragIndex, 0, dragId)
          // the rail mirrors this order, so persist both places from one call
          void window.api.mods.setOrder(next).then(() => refreshMods())
        }
      }
      setDragId(null)
      setDragIndex(null)
      setDragDelta(0)
    },
    [dragId, dragIndex, mods, refreshMods]
  )

  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent): void => {
      const delta = e.clientY - dragStart.current
      setDragDelta(delta)
      const from = mods.findIndex((m) => m.id === dragId)
      if (from < 0) return
      const target = Math.round(from + delta / pitchRef.current)
      setDragIndex(Math.max(0, Math.min(mods.length - 1, target)))
    }
    const onUp = (): void => commit(true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragId, mods, commit])

  const beginDrag = (id: string) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const tops = [...rowRefs.current.values()].map((el) => el.offsetTop).sort((a, b) => a - b)
    if (tops.length > 1) pitchRef.current = tops[1] - tops[0] || 72
    dragStart.current = e.clientY
    setDragId(id)
    setDragIndex(mods.findIndex((m) => m.id === id))
    setDragDelta(0)
  }

  const remove = async (): Promise<void> => {
    const mod = confirming
    if (!mod) return
    setConfirming(null)
    setBusy(mod.id)
    try {
      const res = await window.api.mods.uninstall(mod.id)
      if (!res.ok) {
        toast.error(res.error ?? '卸载失败')
        return
      }
      toast.success(`已移除 ${mod.name}`)
      await refreshMods()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="apps" size={20} /> 工具与插件
      </h2>
      <p className="set-section-desc">
        拖动手柄可以调整工具顺序（侧边栏同步变化）。工具以 .zip 插件包安装，把包拖到「添加工具」
        页面即可。
      </p>

      <div className="set-card tools-card">
        {mods.length === 0 ? (
          <Empty
            icon="extension"
            title="还没有安装任何工具"
            desc="在侧边栏点击「添加工具」，把 .zip 插件包拖进去即可。"
          />
        ) : (
          mods.map((m, index) => {
            const isDragged = dragId === m.id
            let shift = 0
            if (dragId && dragIndex !== null && !isDragged) {
              const from = mods.findIndex((x) => x.id === dragId)
              if (from < index && dragIndex >= index) shift = -1
              else if (from > index && dragIndex <= index) shift = 1
            }
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(m.id, el)
                  else rowRefs.current.delete(m.id)
                }}
                className={[
                  'tools-row',
                  index > 0 && !dragId ? 'divided' : '',
                  isDragged ? 'dragging' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  transform: isDragged
                    ? `translateY(${dragDelta}px)`
                    : shift !== 0
                      ? `translateY(${shift * pitchRef.current}px)`
                      : undefined,
                  zIndex: isDragged ? 3 : undefined,
                  transition: isDragged ? 'none' : undefined
                }}
              >
                {/* the reorder handle lives here, not in the rail */}
                <button
                  type="button"
                  className="tools-grip"
                  onPointerDown={beginDrag(m.id)}
                  title="拖动调整顺序"
                  aria-label="拖动调整顺序"
                >
                  <i />
                  <i />
                  <i />
                </button>
                <span className="tools-row-icon">
                  <Icon name={m.icon as IconName} size={22} />
                </span>
                <div className="tools-row-text">
                  <div className="tools-row-name">
                    {m.name}
                    <span className="tiny muted" style={{ marginLeft: 8 }}>
                      v{m.version}
                    </span>
                  </div>
                  <div className="tools-row-desc">{m.description || '无说明'}</div>
                </div>
                <div className="tools-row-actions">
                  <Button variant="text" size="sm" icon="open" onClick={() => setPage(m.id)}>
                    打开
                  </Button>
                  <Button
                    variant="text"
                    size="sm"
                    icon={m.settingsIcon as IconName}
                    onClick={() => setPage(`mod-settings:${m.id}`)}
                  >
                    设置
                  </Button>
                  <Button variant="text" size="sm" icon="delete" onClick={() => setConfirming(m)}>
                    移除
                  </Button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="set-card tools-card">
        <div className="tools-format">
          <div>
            <div className="tools-format-title">插件包格式</div>
            <p className="tools-format-body">
              压缩包根目录需要包含 <code>dola-mod.json</code>，字段为{' '}
              <code>id / name / version / settingsName / createdAt / description / icon /
              settingsIcon / entry</code>。
              没有该文件的包会被拒绝并删除。
              <br />
              可选导出 <code>mount</code>（工具界面）与 <code>mountSettings</code>（设置界面）。
            </p>
          </div>
          <Button variant="tonal" size="sm" icon="folderData" onClick={() => void window.api.mods.openFolder()}>
            插件目录
          </Button>
        </div>
      </div>

      {/* deleting a tool removes its data, so this asks first */}
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="真的要删除这个插件吗QAQ"
        subtitle={confirming ? `${confirming.name} v${confirming.version}` : undefined}
        icon="delete"
        footer={
          <>
            <Button variant="text" onClick={() => setConfirming(null)}>
              再想想
            </Button>
            <Button variant="filled" icon="delete" onClick={() => void remove()} loading={busy !== null}>
              确认删除
            </Button>
          </>
        }
      >
        <div className="tiny" style={{ lineHeight: 1.7 }}>
          删除后这个工具会从侧边栏消失，它的设置也会一起移除。之后可以重新导入插件包恢复。
        </div>
      </Dialog>
    </>
  )
}

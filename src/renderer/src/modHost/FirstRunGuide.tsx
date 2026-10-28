// ---------------------------------------------------------------------------
// 首次安装引导
//
// A mod's `description` doubles as its user guide. It is shown once, right after the
// tool is first opened, and the flag is cleared in the main process so reinstalling a
// newer version does not repeat it.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { useApp } from '../state/app'
import { Icon } from '../ui/Icon'
import { Button, Dialog } from '../ui/controls'

export function FirstRunGuide(): JSX.Element | null {
  const mods = useApp((s) => s.mods)
  const refreshMods = useApp((s) => s.refreshMods)
  /** the mod whose guide is open; only one at a time */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** ids already offered this session, so closing the guide does not reopen it */
  const [offered, setOffered] = useState<string[]>([])

  /*
   * The mod list arrives asynchronously (and again after an install), so this has to
   * react to the list itself rather than run once on mount — doing the latter meant
   * the guide never appeared for a freshly installed tool.
   */
  useEffect(() => {
    if (activeId) return
    const pending = [...mods]
      .filter((m) => m.firstRun && !offered.includes(m.id))
      .sort((a, b) => b.installedAt - a.installedAt)[0]
    if (pending) {
      setActiveId(pending.id)
      setOffered((prev) => [...prev, pending.id])
    }
  }, [mods, activeId, offered])

  const mod = mods.find((m) => m.id === activeId)
  if (!mod) return null

  const close = (): void => {
    setActiveId(null)
    void window.api.mods.markIntroduced(mod.id).then(() => refreshMods())
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`欢迎使用${mod.name}`}
      subtitle={`v${mod.version} · 首次使用指南`}
      icon={mod.icon}
      footer={
        <Button variant="filled" onClick={close}>
          开始使用
        </Button>
      }
    >
      <div className="stack-sm">
        <div className="hstack" style={{ gap: 12, alignItems: 'center' }}>
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 44,
              height: 44,
              borderRadius: 14,
              background: 'color-mix(in srgb, var(--md-primary) 14%, transparent)'
            }}
          >
            <Icon name={mod.icon as never} size={24} />
          </span>
          <div>
            <div style={{ fontWeight: 700 }}>{mod.name}</div>
            <div className="tiny muted">版本 {mod.version}</div>
          </div>
        </div>
        <div className="tiny" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          {mod.description || '这个工具没有提供说明。'}
        </div>
        <div className="tiny muted">
          可以在「设置 → 工具」中管理已安装的工具，侧边栏图标可拖动调整顺序。
        </div>
      </div>
    </Dialog>
  )
}

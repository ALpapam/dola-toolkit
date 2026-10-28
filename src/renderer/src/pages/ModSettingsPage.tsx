// ---------------------------------------------------------------------------
// 插件设置（二级页面）
//
// Opened from 设置 → 工具 → 设置 on a mod row. The mod supplies the screen through
// `mountSettings`, which is the same contract as its main view — the host only draws
// the header and the back affordance.
// ---------------------------------------------------------------------------

import { useApp } from '../state/app'
import { Icon, type IconName } from '../ui/Icon'
import { ModHost } from '../modHost/ModHost'

interface Props {
  modId: string
}

export function ModSettingsPage({ modId }: Props): JSX.Element {
  const mods = useApp((s) => s.mods)
  const setPage = useApp((s) => s.setPage)
  const mod = mods.find((m) => m.id === modId)

  if (!mod) {
    return (
      <div className="stack-sm" style={{ padding: 24 }}>
        <strong>找不到该工具</strong>
        <button className="btn-text" onClick={() => setPage('settings')}>
          返回设置
        </button>
      </div>
    )
  }

  return (
    <div className="mod-settings-page">
      <header className="mod-settings-head">
        <button
          type="button"
          className="mod-settings-back"
          onClick={() => setPage('settings')}
          aria-label="返回"
          title="返回"
        >
          <Icon name="back" size={20} />
        </button>
        <span
          className="mod-settings-icon"
          aria-hidden="true"
        >
          <Icon name={(mod.settingsIcon || mod.icon) as IconName} size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="mod-settings-title">{mod.settingsName || `${mod.name}设置`}</div>
          <div className="tiny muted">
            {mod.name} · v{mod.version}
          </div>
        </div>
      </header>
      <div className="mod-settings-body">
        <ModHost mod={mod} mode="settings" />
      </div>
    </div>
  )
}

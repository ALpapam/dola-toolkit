// ---------------------------------------------------------------------------
// 设置 → 工具
//
// Lists installed mods with version, size and uninstall, and explains the package
// format so a mod author knows what `dola-mod.json` must contain.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { ModRecordInfo } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, Empty } from '../../ui/controls'
import { toast } from '../../ui/toast'

export function ToolsSection(): JSX.Element {
  const mods = useApp((s) => s.mods)
  const refreshMods = useApp((s) => s.refreshMods)
  const setPage = useApp((s) => s.setPage)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refreshMods()
  }, [refreshMods])

  const remove = async (mod: ModRecordInfo): Promise<void> => {
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
        <Icon name="extension" size={20} /> 工具与插件
      </h2>
      <p className="set-section-desc">
        工具以 .zip 插件包的形式安装，可拖动侧边栏图标调整顺序。把包拖到「添加工具」页面即可安装。
      </p>

      <div className="set-card">
        {mods.length === 0 ? (
          <Empty
            icon="extension"
            title="还没有安装任何工具"
            desc="在侧边栏点击「添加工具」，把 .zip 插件包拖进去即可。"
          />
        ) : (
          mods.map((m) => (
            <div
              key={m.id}
              className="hstack"
              style={{ gap: 12, padding: '12px 4px', alignItems: 'center' }}
            >
              <span
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 40,
                  height: 40,
                  flex: '0 0 auto',
                  borderRadius: 12,
                  background: 'color-mix(in srgb, var(--md-primary) 12%, transparent)'
                }}
              >
                <Icon name={m.icon as IconName} size={22} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {m.name}
                  <span className="tiny muted" style={{ marginLeft: 8 }}>
                    v{m.version}
                  </span>
                </div>
                <div className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.description || '无说明'}
                </div>
              </div>
              <Button variant="text" size="sm" icon="open" onClick={() => setPage(m.id)}>
                打开
              </Button>
              <Button
                variant="text"
                size="sm"
                icon="delete"
                loading={busy === m.id}
                onClick={() => void remove(m)}
              >
                移除
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="set-card">
        <div className="hstack" style={{ justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>插件包格式</div>
            <div className="tiny muted" style={{ marginTop: 4, lineHeight: 1.7 }}>
              压缩包根目录需要包含 <code>dola-mod.json</code>，字段为：
              <code> id / name / version / settingsName / createdAt / description / icon / settingsIcon / entry</code>。
              <br />
              没有该文件的包会被拒绝并删除。
            </div>
          </div>
          <Button variant="tonal" size="sm" icon="folderData" onClick={() => void window.api.mods.openFolder()}>
            插件目录
          </Button>
        </div>
      </div>
    </>
  )
}
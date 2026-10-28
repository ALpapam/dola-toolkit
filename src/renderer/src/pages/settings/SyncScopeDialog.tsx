// ---------------------------------------------------------------------------
// 同步内容选择
//
// Replaces the old three-way dropdown with a picker: the user ticks what to back up
// (app settings, the library, and any tool that declares a backup file) and presses
// 确定 to start the sync.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { ModRecordInfo } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, Dialog } from '../../ui/controls'

export interface SyncItem {
  id: string
  label: string
  desc: string
  icon: IconName
}

interface Props {
  open: boolean
  onClose: () => void
  /** current selection from settings */
  value: string[]
  onConfirm: (items: string[]) => void
  busy?: boolean
}

/** The items that can be backed up, derived from the app and the installed tools. */
export function useSyncItems(): SyncItem[] {
  const mods = useApp((s) => s.mods)
  const items: SyncItem[] = [
    { id: 'settings', label: '应用设置', desc: '主题、代理、AI 等全部设置', icon: 'settings' },
    { id: 'library', label: '书库元数据', desc: '书籍列表、文件夹与阅读进度', icon: 'bookOpen' }
  ]
  for (const m of mods as (ModRecordInfo & { backupFile?: string })[]) {
    if (!m.backupFile) continue
    items.push({
      id: `mod:${m.id}`,
      label: `${m.name} 数据`,
      desc: m.backupFile,
      icon: (m.icon || 'extension') as IconName
    })
  }
  return items
}

export function SyncScopeDialog({ open, onClose, value, onConfirm, busy }: Props): JSX.Element {
  const items = useSyncItems()
  const [picked, setPicked] = useState<string[]>(value)

  useEffect(() => {
    if (open) setPicked(value.length > 0 ? value : ['settings', 'library'])
  }, [open, value])

  const toggle = (id: string): void => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="选择同步内容"
      subtitle="勾选要备份到 WebDAV 的内容"
      icon="cloudSync"
      footer={
        <>
          <Button variant="text" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="filled"
            icon="cloudUpload"
            loading={busy}
            disabled={picked.length === 0}
            onClick={() => onConfirm(picked)}
          >
            确定并备份
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        {items.map((item) => {
          const checked = picked.includes(item.id)
          return (
            <button
              key={item.id}
              type="button"
              className={`sync-item ${checked ? 'checked' : ''}`}
              onClick={() => toggle(item.id)}
              aria-pressed={checked}
            >
              <span className="sync-check">{checked ? <Icon name="check" size={16} /> : null}</span>
              <span className="sync-item-icon">
                <Icon name={item.icon} size={20} />
              </span>
              <span className="sync-item-text">
                <span className="sync-item-label">{item.label}</span>
                <span className="sync-item-desc">{item.desc}</span>
              </span>
            </button>
          )
        })}
        {items.length <= 2 ? (
          <div className="tiny muted" style={{ paddingTop: 4 }}>
            安装提供备份数据的插件后，这里会出现它们的选项。
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

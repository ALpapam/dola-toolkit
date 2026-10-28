// ---------------------------------------------------------------------------
// 同步内容选择
//
// An Explorer-style list: one row per item, checkbox on the left, name and the exact
// files that go into the backup on the right. The backup description is spelled out so
// the user knows what leaves the machine — mods declare it through `backupLabel` /
// `backupFile` in their manifest.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { ModRecordInfo } from '@shared/types'
import { useApp } from '../../state/app'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, Dialog } from '../../ui/controls'

export interface SyncItem {
  id: string
  label: string
  /** what actually gets backed up, shown next to the name */
  detail: string
  icon: IconName
  available: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  value: string[]
  onConfirm: (items: string[]) => void
  busy?: boolean
}

/** The items that can be backed up, derived from the app and the installed tools. */
export function useSyncItems(): SyncItem[] {
  const mods = useApp((s) => s.mods)
  const items: SyncItem[] = [
    {
      id: 'settings',
      label: '应用设置',
      detail: 'settings.json · 主题、代理、AI、同步等全部偏好',
      icon: 'settings',
      available: true
    },
    {
      id: 'library',
      label: '书库元数据',
      detail: 'dola-library.json · 书籍列表、文件夹、阅读进度（不含书籍文件）',
      icon: 'bookOpen',
      available: true
    }
  ]
  for (const m of mods as (ModRecordInfo & { backupFile?: string; backupLabel?: string })[]) {
    if (!m.backupFile) continue
    items.push({
      id: `mod:${m.id}`,
      label: m.backupLabel || `${m.name} 数据`,
      detail: `${m.backupFile} · 由该工具声明的备份文件`,
      icon: (m.icon || 'apps') as IconName,
      available: true
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

  const allPicked = items.length > 0 && items.every((i) => picked.includes(i.id))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="同步内容"
      subtitle="勾选要备份到 WebDAV 的内容"
      icon="cloudSync"
      width="wide"
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
      {/* header row, like a details-view column header in Explorer */}
      <div className="sync-head">
        <button
          type="button"
          className="sync-check"
          role="checkbox"
          aria-checked={allPicked}
          aria-label="全选"
          onClick={() => setPicked(allPicked ? [] : items.map((i) => i.id))}
        >
          {allPicked ? <Icon name="check" size={14} /> : null}
        </button>
        <span>名称</span>
        <span className="sync-head-detail">备份内容</span>
      </div>

      <div className="sync-list">
        {items.map((item) => {
          const checked = picked.includes(item.id)
          return (
            <button
              key={item.id}
              type="button"
              className={`sync-row ${checked ? 'checked' : ''}`}
              onClick={() => toggle(item.id)}
              aria-pressed={checked}
            >
              <span className="sync-check" aria-hidden="true">
                {checked ? <Icon name="check" size={14} /> : null}
              </span>
              <span className="sync-row-icon">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="sync-row-name">{item.label}</span>
              <span className="sync-row-detail">{item.detail}</span>
            </button>
          )
        })}
        {items.length <= 2 ? (
          <div className="tiny muted" style={{ padding: '10px 4px 2px' }}>
            安装声明了备份数据的插件后，这里会出现它们的条目。
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

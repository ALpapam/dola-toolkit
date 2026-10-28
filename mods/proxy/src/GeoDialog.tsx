import { useState } from 'react'
import type { ProxyState } from '@shared/types'
import { Button, Dialog, Spinner } from './host'
import { Icon } from './host'
import { toast } from './host'
import { fmtBytes, fmtDate } from './host'

export function GeoDialog({
  open,
  onClose,
  state,
  onChanged
}: {
  open: boolean
  onClose: () => void
  state: ProxyState
  onChanged: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<'import' | 'update' | null>(null)

  const doImport = async (): Promise<void> => {
    setBusy('import')
    try {
      await window.api.proxy.importGeo()
      toast.success('路由文件已导入')
      onChanged()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doUpdate = async (): Promise<void> => {
    setBusy('update')
    try {
      await window.api.proxy.updateGeo()
      toast.success('路由文件已更新')
      onChanged()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Geofiles 路由文件"
      subtitle="部分协议（如 Xray 分流规则）需要 geoip.dat 与 geosite.dat"
      icon="cloudDownload"
      footer={
        <Button variant="text" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="card" style={{ padding: 16 }}>
        <div className="hstack" style={{ marginBottom: 10 }}>
          <Icon name="dns" size={18} />
          <span className="strong">当前文件</span>
          <span className="spacer" />
          <span className="tiny mono muted">{state.geo.dir}</span>
        </div>
        <div className="stack-sm">
          <div className="hstack">
            <span className="tiny muted" style={{ width: 90 }}>geoip.dat</span>
            <span className="mono tiny">{state.geo.geoip ? fmtBytes(state.geo.geoip.size) : '缺失'}</span>
            <span className="spacer" />
            <span className="tiny muted">{state.geo.geoip?.updatedAt ? fmtDate(state.geo.geoip.updatedAt) : '—'}</span>
          </div>
          <div className="hstack">
            <span className="tiny muted" style={{ width: 90 }}>geosite.dat</span>
            <span className="mono tiny">{state.geo.geosite ? fmtBytes(state.geo.geosite.size) : '缺失'}</span>
            <span className="spacer" />
            <span className="tiny muted">{state.geo.geosite?.updatedAt ? fmtDate(state.geo.geosite.updatedAt) : '—'}</span>
          </div>
        </div>
      </div>

      <div className="hstack" style={{ gap: 10 }}>
        <Button variant="tonal" icon="folderData" onClick={() => void doImport()} disabled={busy !== null}>
          {busy === 'import' ? <Spinner size={16} /> : '导入本地文件'}
        </Button>
        <Button variant="outlined" icon="cloudDownload" onClick={() => void doUpdate()} disabled={busy !== null}>
          {busy === 'update' ? <Spinner size={16} /> : '在线更新'}
        </Button>
      </div>
      <p className="tiny muted">
        在线更新会从 Loyalsoldier/v2ray-rules-dat（jsDelivr 或 GitHub）拉取，失败时保留原文件。
      </p>
    </Dialog>
  )
}

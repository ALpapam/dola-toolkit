// ---------------------------------------------------------------------------
// 代理内核更新
//
// Core versions live on the proxy page rather than in 设置: they are part of the
// proxy tool, and updating them is a proxy action (the core is stopped, its exe
// replaced). One button updates everything that is behind.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { CoreUpdateInfo } from '@shared/types'
import { Button, Dialog, Spinner } from '../../ui/controls'
import { Icon } from '../../ui/Icon'
import { toast } from '../../ui/toast'

interface Props {
  open: boolean
  onClose: () => void
  onFinished: () => void
}

export function CoreUpdateDialog({ open, onClose, onFinished }: Props): JSX.Element {
  const [cores, setCores] = useState<CoreUpdateInfo[] | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [allBusy, setAllBusy] = useState(false)
  const [percent, setPercent] = useState<{ engine?: string; value: number } | null>(null)

  const check = async (): Promise<void> => {
    const list = await window.api.app.checkCoreUpdates()
    setCores(list)
    setChecked(true)
  }

  useEffect(() => {
    if (!open) return
    setCores(null)
    setChecked(false)
    void check()
    const off = window.api.app.onUpdateProgress((p) => {
      if (p.kind !== 'core') return
      if (p.state === 'downloading') setPercent({ engine: p.engine, value: p.percent })
      else setPercent(null)
    })
    return off
  }, [open])

  const updateOne = async (engine: string): Promise<void> => {
    setBusy(engine)
    try {
      const res = await window.api.app.updateCore(engine)
      if (!res.ok) toast.error(res.error ?? '更新失败')
      else toast.success('内核已更新，正在重启应用…')
      await check()
      onFinished()
    } finally {
      setBusy(null)
    }
  }

  const updateAll = async (): Promise<void> => {
    setAllBusy(true)
    try {
      const res = await window.api.app.updateAllCores()
      if (res.updated.length > 0) {
        toast.success(`已更新 ${res.updated.join(' / ')}，正在重启应用…`)
      }
      if (res.failed.length > 0) {
        toast.error(res.failed.map((f) => `${f.engine}: ${f.error}`).join('；'))
      }
      if (res.updated.length === 0 && res.failed.length === 0) {
        toast.info('所有内核都是最新版本')
      }
      await check()
      onFinished()
    } finally {
      setAllBusy(false)
    }
  }

  const behind = (cores ?? []).filter((c) => c.updateAvailable || c.missing)
  const anyBusy = allBusy || busy !== null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="代理内核更新"
      subtitle="检查 Xray / sing-box / Mihomo 的上游版本，可在软件内直接下载替换"
      icon="update"
      width="wide"
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="filled"
            icon="download"
            disabled={anyBusy || behind.length === 0}
            loading={allBusy}
            onClick={() => void updateAll()}
          >
            {behind.length > 1 ? `一键更新 ${behind.length} 个` : '全部更新'}
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        {!checked ? (
          <div className="hstack" style={{ gap: 10, padding: '18px 4px' }}>
            <Spinner size={18} />
            <span className="muted">正在检查内核版本…</span>
          </div>
        ) : null}

        {(cores ?? []).map((c) => {
          const downloading = percent?.engine === c.engine ? percent.value : null
          const state = c.error
            ? c.error
            : c.missing
              ? '未安装 · 可在此下载'
              : c.updateAvailable
                ? `${c.local} → ${c.latest}`
                : `已是最新（${c.local}）`
          return (
            <div
              key={c.engine}
              className="hstack"
              style={{
                gap: 12,
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 'var(--shape-md)',
                background: 'color-mix(in srgb, var(--md-on-surface) 4%, transparent)'
              }}
            >
              <Icon name="memory" size={20} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{c.label}</div>
                <div className="tiny muted" style={{ marginTop: 2 }}>
                  {state}
                </div>
              </div>
              {downloading !== null ? (
                <span className="tiny mono" style={{ minWidth: 46, textAlign: 'right' }}>
                  {downloading}%
                </span>
              ) : c.updateAvailable || c.missing ? (
                <Button
                  variant="tonal"
                  size="sm"
                  icon={c.missing ? 'download' : 'update'}
                  loading={busy === c.engine}
                  disabled={anyBusy}
                  onClick={() => void updateOne(c.engine)}
                >
                  {c.missing ? '下载' : '更新'}
                </Button>
              ) : (
                <Icon name="checkCircle" size={18} />
              )}
            </div>
          )
        })}

        {checked && behind.length === 0 ? (
          <div className="tiny muted" style={{ padding: '6px 2px' }}>
            所有内核都是最新版本。
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

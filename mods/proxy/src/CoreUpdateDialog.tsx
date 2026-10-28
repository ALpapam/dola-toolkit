// ---------------------------------------------------------------------------
// 代理内核更新
//
// Two-stage UI to match the two-stage backend:
//   1. download + verify  → per-core progress bar
//   2. staged             → a panel offering「立即重启并应用」or「稍后重启」
//
// A download that fails verification never offers a restart: the dialog shows the
// concrete reason (checksum, HTTP status, size) and a 重新下载 button instead.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { CoreUpdateInfo, StagedCoreInfo } from '@shared/types'
import { Button, Dialog, Spinner } from './host'
import { Icon } from './host'
import { toast } from './host'

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
  const [progress, setProgress] = useState<Record<string, number>>({})
  /** the core whose download failed, with the reason shown under its row */
  const [failure, setFailure] = useState<{ engine: string; error: string } | null>(null)
  const [staged, setStaged] = useState<StagedCoreInfo[]>([])
  const [restarting, setRestarting] = useState(false)

  const refresh = async (): Promise<void> => {
    const [list, pending] = await Promise.all([
      window.api.app.checkCoreUpdates(),
      window.api.app.stagedCores()
    ])
    setCores(list)
    setStaged(pending)
    setChecked(true)
  }

  useEffect(() => {
    if (!open) return
    setCores(null)
    setChecked(false)
    setFailure(null)
    setProgress({})
    setRestarting(false)
    void refresh()
    const off = window.api.app.onUpdateProgress((p) => {
      if (p.kind !== 'core' || !p.engine) return
      const engine = p.engine
      setProgress((prev) => {
        if (p.state === 'downloading') return { ...prev, [engine]: p.percent }
        const next = { ...prev }
        delete next[engine]
        return next
      })
    })
    return off
  }, [open])

  const stageOne = async (engine: string): Promise<void> => {
    setBusy(engine)
    setFailure(null)
    try {
      const res = await window.api.app.stageCore(engine)
      if (!res.ok) {
        // nothing was staged, so no restart is offered — only a retry
        setFailure({ engine, error: res.error ?? '下载失败' })
        toast.error('下载失败，请重试')
      } else {
        toast.success('已下载并校验通过，重启后生效')
      }
      await refresh()
      onFinished()
    } finally {
      setBusy(null)
    }
  }

  const stageAll = async (): Promise<void> => {
    setAllBusy(true)
    setFailure(null)
    try {
      const res = await window.api.app.stageAllCores()
      if (res.staged.length > 0) toast.success(`${res.staged.length} 个内核已下载并校验通过`)
      if (res.failed.length > 0) {
        setFailure({
          engine: res.failed[0].engine,
          error: res.failed.map((f) => `${f.engine}: ${f.error}`).join('；')
        })
        toast.error('部分内核下载失败')
      }
      await refresh()
      onFinished()
    } finally {
      setAllBusy(false)
    }
  }

  const applyNow = async (): Promise<void> => {
    setRestarting(true)
    toast.info('正在重启应用以应用内核更新…')
    const res = await window.api.app.applyStagedNow()
    if (!res.ok) {
      setRestarting(false)
      toast.error(res.error ?? '重启失败')
    }
  }

  const discard = async (): Promise<void> => {
    await window.api.app.clearStagedCores()
    toast.info('已丢弃待应用的内核')
    await refresh()
  }

  const behind = (cores ?? []).filter((c) => c.updateAvailable || c.missing)
  const stagedEngines = new Set(staged.map((s) => s.engine))
  const anyBusy = allBusy || busy !== null || restarting

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="代理内核更新"
      subtitle="下载并校验后暂存，重启应用时替换，下载期间不影响正在使用的代理"
      icon="update"
      width="wide"
      footer={
        staged.length > 0 ? (
          <>
            <Button variant="text" onClick={() => void discard()} disabled={restarting}>
              丢弃
            </Button>
            <Button variant="text" onClick={onClose} disabled={restarting}>
              稍后重启
            </Button>
            <Button variant="filled" icon="refresh" loading={restarting} onClick={() => void applyNow()}>
              立即重启并应用
            </Button>
          </>
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              关闭
            </Button>
            <Button
              variant="filled"
              icon="download"
              disabled={anyBusy || behind.length === 0}
              loading={allBusy}
              onClick={() => void stageAll()}
            >
              {behind.length > 1 ? `下载全部 ${behind.length} 个` : '下载更新'}
            </Button>
          </>
        )
      }
    >
      <div className="stack-sm">
        {!checked ? (
          <div className="hstack" style={{ gap: 10, padding: '18px 4px' }}>
            <Spinner size={18} />
            <span className="muted">正在检查内核版本…</span>
          </div>
        ) : null}

        {/* the restart decision lives here, and only for verified downloads */}
        {staged.length > 0 ? (
          <div
            className="stack-sm"
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--shape-md)',
              background: 'color-mix(in srgb, var(--md-primary) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--md-primary) 30%, transparent)'
            }}
          >
            <div className="hstack" style={{ gap: 8 }}>
              <Icon name="checkCircle" size={18} />
              <strong style={{ fontSize: 13 }}>已下载并校验，等待重启后应用</strong>
            </div>
            {staged.map((s) => (
              <div key={s.engine} className="tiny mono" style={{ opacity: 0.85 }}>
                {s.label} {s.version} · {(s.size / 1048576).toFixed(1)} MB · sha256 {s.sha256.slice(0, 12)}…
              </div>
            ))}
            <div className="tiny muted">选择「立即重启并应用」，或关掉此窗口稍后手动重启。</div>
          </div>
        ) : null}

        {(cores ?? []).map((c) => {
          const pct = progress[c.engine]
          const isStaged = stagedEngines.has(c.engine)
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
                {/* a 100 MB transfer needs visible feedback, not just a spinner */}
                {pct !== undefined ? (
                  <div
                    style={{
                      marginTop: 8,
                      height: 4,
                      borderRadius: 2,
                      background: 'color-mix(in srgb, var(--md-on-surface) 12%, transparent)',
                      overflow: 'hidden'
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: 'var(--md-primary)',
                        transition: 'width 200ms linear'
                      }}
                    />
                  </div>
                ) : null}
              </div>
              {pct !== undefined ? (
                <span className="tiny mono" style={{ minWidth: 46, textAlign: 'right' }}>
                  {pct}%
                </span>
              ) : isStaged ? (
                <span className="tiny" style={{ color: 'var(--md-primary)' }}>
                  已就绪
                </span>
              ) : c.updateAvailable || c.missing ? (
                <Button
                  variant="tonal"
                  size="sm"
                  icon={c.missing ? 'download' : 'update'}
                  loading={busy === c.engine}
                  disabled={anyBusy}
                  onClick={() => void stageOne(c.engine)}
                >
                  {c.missing ? '下载' : '更新'}
                </Button>
              ) : (
                <Icon name="checkCircle" size={18} />
              )}
            </div>
          )
        })}

        {/* a failed download explains itself and offers a retry, never a restart */}
        {failure ? (
          <div
            className="stack-sm"
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--shape-md)',
              background: 'color-mix(in srgb, var(--md-error) 12%, transparent)'
            }}
          >
            <div className="hstack" style={{ gap: 8 }}>
              <Icon name="warning" size={18} />
              <strong style={{ fontSize: 13 }}>下载失败，未做任何替换</strong>
            </div>
            <div className="tiny mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {failure.error}
            </div>
            <div className="hstack" style={{ gap: 8 }}>
              <Button variant="tonal" size="sm" icon="refresh" onClick={() => void stageOne(failure.engine)}>
                重新下载
              </Button>
              <Button
                variant="text"
                size="sm"
                icon="folderData"
                onClick={() => void window.api.app.openUpdateLog()}
              >
                查看日志
              </Button>
            </div>
          </div>
        ) : null}

        {checked && behind.length === 0 && staged.length === 0 ? (
          <div className="tiny muted" style={{ padding: '6px 2px' }}>
            所有内核都是最新版本。
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

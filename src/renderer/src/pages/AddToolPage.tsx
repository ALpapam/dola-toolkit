// ---------------------------------------------------------------------------
// 添加工具 — the page behind the rail's "+"
//
// A big drop target in the middle: drag a .zip anywhere onto the page, or press the
// button. A package without `dola-mod.json` is rejected and deleted, with the exact
// message「这似乎不是Dola Toolkit的插件呢~」.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../state/app'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/controls'
import { toast } from '../ui/toast'
import { invalidateMod } from '../modHost/ModHost'

interface ImportOutcome {
  ok: boolean
  canceled?: boolean
  error?: string
  mod?: { id: string; name: string; version: string; firstRun: boolean }
  upgraded?: boolean
}

export function AddToolPage(): JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const refreshMods = useApp((s) => s.refreshMods)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const finish = useCallback(
    async (result: ImportOutcome): Promise<void> => {
      if (result.canceled) return
      if (!result.ok) {
        setError(result.error ?? '导入失败')
        toast.error(result.error ?? '导入失败')
        return
      }
      setError(null)
      if (result.mod) invalidateMod(result.mod.id)
      await refreshMods()
      const name = result.mod?.name ?? '插件'
      toast.success(result.upgraded ? `${name} 已更新到 ${result.mod?.version}` : `${name} 已添加`)
      // an added tool opens itself; the first-run guide is shown by the app shell
      if (result.mod) setPage(result.mod.id)
    },
    [refreshMods, setPage]
  )

  const pick = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = (await window.api.mods.pickAndImport()) as ImportOutcome
      await finish(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }, [finish])

  /* dragging a zip over the window: highlight, then import on drop */
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types?.includes('Files'))

    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      if (!/\.zip$/i.test(file.name)) {
        const message = '只支持 .zip 格式的插件包'
        setError(message)
        toast.error(message)
        return
      }
      setBusy(true)
      setError(null)
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const filePath = (file as any).path as string | undefined
          if (!filePath) throw new Error('无法读取拖入的文件路径')
          const res = (await window.api.mods.importZip(filePath)) as ImportOutcome
          await finish(res)
        } catch (err) {
          setError(err instanceof Error ? err.message : '导入失败')
        } finally {
          setBusy(false)
        }
      })()
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [finish])

  return (
    <div className="add-tool-page">
      <button
        type="button"
        className={`add-tool-drop ${dragging ? 'drag-over' : ''}`}
        onClick={() => void pick()}
        disabled={busy}
        aria-label="添加工具"
      >
        <span className="add-tool-plus">
          <Icon name="add" size={64} />
        </span>
      </button>

      <p className="add-tool-hint">请将 .zip 后缀的包拽入或点击按钮添加工具</p>

      {busy ? <p className="add-tool-hint">正在导入…</p> : null}
      {error ? (
        <div className="add-tool-error" role="alert">
          <Icon name="warning" size={18} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="add-tool-actions">
        <Button variant="tonal" size="sm" icon="download" onClick={() => void pick()} loading={busy}>
          选择 .zip 插件包
        </Button>
        <Button variant="text" size="sm" icon="folderData" onClick={() => void window.api.mods.openFolder()}>
          打开插件目录
        </Button>
      </div>
    </div>
  )
}

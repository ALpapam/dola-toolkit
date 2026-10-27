// ---------------------------------------------------------------------------
// Dola Toolkit — update IPC
//
// Core updates are STAGED, not applied inline:
//   1. download + SHA-256 verify + extract into the staging folder
//   2. tell the UI it is ready and offer a restart (now or later)
//   3. the swap happens on the next launch, before any core starts
//
// That ordering keeps the proxy up during the download, and means a corrupt archive
// is rejected while the user is still looking at the dialog — a failed verification
// never reaches the "restart to finish" state.
// ---------------------------------------------------------------------------

import { rmSync } from 'node:fs'
import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import type { AppUpdateInfo, CoreId, CoreUpdateInfo, StagedCoreInfo, UpdateProgress } from '@shared/types'
import {
  checkAppUpdate,
  checkCoreUpdates,
  downloadAppUpdate,
  installAppUpdate,
  openReleasesPage,
  stageDownloadTo,
  takePendingUpdate,
  viaUpdateChannel
} from '../updates'
import { readStagedCores, stageCore, writeStagedCores } from '../coreStage'
import { logUpdate, revealUpdateLog, updateLogPath } from '../updateLog'
import { markResumeProxyAfterRestart, relaunchApp } from '../resume'
import { proxyManager } from '../proxy/manager'

function emit(progress: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateProgress, progress)
  }
}

let relaunchTimer: NodeJS.Timeout | null = null
function scheduleRelaunch(delayMs = 1800): void {
  if (relaunchTimer) return
  relaunchTimer = setTimeout(() => {
    relaunchTimer = null
    void relaunchApp(async () => {
      await proxyManager.stop()
    }, 0)
  }, delayMs)
}

function toStagedInfo(s: {
  engine: CoreId
  label: string
  version: string
  size: number
  sha256: string
  targetPath: string
}): StagedCoreInfo {
  return {
    engine: s.engine,
    label: s.label,
    version: s.version,
    size: s.size,
    sha256: s.sha256,
    targetPath: s.targetPath
  }
}

/**
 * Stages one core: download, verify, extract. The proxy is never stopped, because
 * nothing here touches a live binary.
 */
async function stageOne(engine: CoreId): Promise<StagedCoreInfo> {
  const list = await checkCoreUpdates()
  const info = list.find((c) => c.engine === engine)
  if (!info) throw new Error('未找到内核信息')
  if (!info.updateAvailable && !info.missing) throw new Error('该内核已是最新版本')
  if (!info.assetUrl || !info.latest) throw new Error(info.error ?? '没有可用的下载地址')

  logUpdate('core.stage.start', `${info.label} ${info.local ?? '(未安装)'} → ${info.latest}`)
  const staged = await stageCore({
    engine,
    version: info.latest,
    url: viaUpdateChannel(info.assetUrl, info.channel),
    expectedSha256: info.assetSha256,
    onProgress: (percent) => emit({ kind: 'core', engine, percent, state: 'downloading' }),
    download: stageDownloadTo
  })
  logUpdate(
    'core.stage.ok',
    `${info.label} ${staged.version} sha256=${staged.sha256.slice(0, 16)}… ${Math.round(staged.size / 1048576)}MB → ${staged.targetPath}`
  )
  emit({ kind: 'core', engine, percent: 100, state: 'done' })
  return toStagedInfo(staged)
}

export function registerUpdatesIpc(): void {
  ipcMain.handle(IPC.updateCheckApp, async (): Promise<AppUpdateInfo> => {
    try {
      return await checkAppUpdate()
    } catch (e) {
      return {
        current: app.getVersion(),
        latest: null,
        updateAvailable: false,
        channel: 'github',
        downloadUrl: null,
        notes: null,
        publishedAt: null,
        error: e instanceof Error ? e.message : '检查失败'
      }
    }
  })

  ipcMain.handle(IPC.updateCheckCores, async (): Promise<CoreUpdateInfo[]> => {
    try {
      return await checkCoreUpdates()
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.updateDownloadApp, async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      logUpdate('app.download.start')
      let last = -1
      const path = await downloadAppUpdate((percent) => {
        if (percent !== last) {
          last = percent
          emit({ kind: 'app', percent, state: 'downloading' })
        }
      })
      logUpdate('app.download.ok', path)
      emit({ kind: 'app', percent: 100, state: 'done' })
      return { ok: true, path }
    } catch (e) {
      const message = e instanceof Error ? e.message : '下载失败'
      logUpdate('app.download.fail', message)
      emit({ kind: 'app', percent: 0, state: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateInstallApp, async (_e, installerPath: unknown, targetVersion?: unknown) => {
    if (typeof installerPath !== 'string' || !installerPath) return { ok: false, error: '缺少安装包路径' }
    try {
      logUpdate('app.install.start', `${installerPath} → ${String(targetVersion ?? '')}`)
      await installAppUpdate(installerPath, typeof targetVersion === 'string' ? targetVersion : undefined)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : '安装失败'
      logUpdate('app.install.fail', message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateStageCore, async (_e, engine: unknown) => {
    const id = engine as CoreId
    if (!['xray', 'singbox', 'mihomo'].includes(id)) return { ok: false, error: '未知内核' }
    try {
      const staged = await stageOne(id)
      return { ok: true, staged, needsRestart: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : '下载失败'
      logUpdate('core.stage.fail', `${id}: ${message}`)
      emit({ kind: 'core', engine: id, percent: 0, state: 'error', message })
      // nothing was staged, so the UI must offer a retry — never a restart
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updateStageAllCores, async () => {
    const staged: StagedCoreInfo[] = []
    const failed: { engine: string; error: string }[] = []
    try {
      const list = await checkCoreUpdates()
      const behind = list.filter((c) => c.updateAvailable && c.assetUrl)
      for (const item of behind) {
        try {
          staged.push(await stageOne(item.engine))
        } catch (e) {
          const message = e instanceof Error ? e.message : '下载失败'
          logUpdate('core.stage.fail', `${item.engine}: ${message}`)
          emit({ kind: 'core', engine: item.engine, percent: 0, state: 'error', message })
          failed.push({ engine: item.label, error: message })
        }
      }
    } catch (e) {
      failed.push({ engine: '检查', error: e instanceof Error ? e.message : '下载失败' })
    }
    // `needsRestart` is only true when at least one core really staged successfully
    return { ok: failed.length === 0, staged, failed, needsRestart: staged.length > 0 }
  })

  ipcMain.handle(IPC.updateStagedList, (): StagedCoreInfo[] => readStagedCores().map(toStagedInfo))

  ipcMain.handle(IPC.updateClearStaged, () => {
    for (const item of readStagedCores()) {
      try {
        rmSync(item.stagedPath, { force: true })
        rmSync(`${item.stagedPath}/..`, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    writeStagedCores([])
    logUpdate('core.stage.cleared')
    return { ok: true }
  })

  ipcMain.handle(IPC.updateApplyStagedNow, () => {
    const staged = readStagedCores()
    if (staged.length === 0) return { ok: false, error: '没有待应用的内核' }
    // remember whether the proxy was up so the relaunch brings it back
    const wasUp = proxyManager.state().engines.some((e) => e.running)
    markResumeProxyAfterRestart(wasUp)
    logUpdate('core.apply.restart-requested', staged.map((s) => `${s.label} ${s.version}`).join(', '))
    scheduleRelaunch(400)
    return { ok: true, count: staged.length }
  })

  ipcMain.handle(IPC.updateHasStaged, () => readStagedCores().length > 0)

  ipcMain.handle(IPC.updateTakePending, () => takePendingUpdate())

  ipcMain.handle(IPC.updateOpenLog, () => revealUpdateLog())

  ipcMain.handle(IPC.updateLogPath, () => updateLogPath())

  ipcMain.handle(IPC.updateOpenReleases, () => {
    openReleasesPage()
    return true
  })
}

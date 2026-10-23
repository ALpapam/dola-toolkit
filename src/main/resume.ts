// ---------------------------------------------------------------------------
// Dola Toolkit — restart after an in-app core update
//
// Restarting from inside the app is surprisingly delicate here:
//
//  · `app.exit()` skips `before-quit`, so the proxy cores were orphaned and kept
//    holding the mixed port. The next launch then failed with「核心退出 code=1」.
//  · `app.relaunch()` alone is not enough either: the new process starts while the
//    old one is still shutting down and still owns the single-instance lock, so the
//    newcomer takes the `requestSingleInstanceLock() === false` branch and quits.
//    The old instance then dies, and nothing is running.
//
// The reliable shape is to hand the restart to a detached helper: it waits for this
// process to disappear (and for the cores to be gone), then launches the app again.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ResumeFlag {
  at: number
  proxy: boolean
}

function flagPath(): string {
  return join(app.getPath('userData'), 'resume-after-update.json')
}

/** Records that the next launch should bring the proxy back up. */
export function markResumeProxyAfterRestart(proxyWasRunning: boolean): void {
  try {
    const flag: ResumeFlag = { at: Date.now(), proxy: proxyWasRunning }
    writeFileSync(flagPath(), JSON.stringify(flag))
  } catch {
    /* non-fatal */
  }
}

/** Reads and clears the flag. Returns whether the proxy should be started. */
export function takeResumeProxy(): boolean {
  const file = flagPath()
  if (!existsSync(file)) return false
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ResumeFlag>
    rmSync(file, { force: true })
    return raw.proxy === true
  } catch {
    rmSync(file, { force: true })
    return false
  }
}


/**
 * Stops the cores, then relaunches the app.
 *
 * `app.relaunch()` + `app.quit()` (not `app.exit`): quit runs `before-quit`, which
 * stops the cores and restores the system proxy, so no orphan is left holding the
 * mixed port. The new process is started with `--relaunch`, which makes its
 * single-instance check wait for this one to finish instead of quitting instantly —
 * relaunch starts the newcomer while the old process still owns the lock, and that
 * race is what made the restart look like it did nothing.
 */
export async function relaunchApp(stopCores: () => Promise<void>, port: number): Promise<void> {
  try {
    await stopCores()
  } catch {
    /* a restart is still better than staying on the old binary */
  }
  void port

  // the flag tells the new instance to retry the lock and to bring the proxy back
  app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--relaunch'), '--relaunch'] })
  app.quit()
}

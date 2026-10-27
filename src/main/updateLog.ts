// ---------------------------------------------------------------------------
// Dola Toolkit — update log
//
// A staged-update flow has several steps that can fail for unrelated reasons
// (download, checksum, extraction, swap). Writing each step to a file means the user
// can be pointed at a log instead of a single opaque message, and a failure that
// happens across a restart is still recorded.
// ---------------------------------------------------------------------------

import { app, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_VERSION } from '@shared/version'

function logDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function updateLogPath(): string {
  return join(logDir(), 'update.log')
}

/**
 * Appends one line.
 *
 * The file is rotated once it passes ~256 KB so it cannot grow without bound; only
 * one previous file is kept.
 */
export function logUpdate(step: string, detail?: string): void {
  try {
    const file = updateLogPath()
    try {
      if (existsSync(file) && statSync(file).size > 256 * 1024) {
        renameSync(file, `${file}.1`)
        writeFileSync(file, '')
      }
    } catch {
      /* rotation is best effort */
    }
    const line = `[${new Date().toISOString()}] v${APP_VERSION} ${step}${detail ? ` — ${detail}` : ''}\n`
    appendFileSync(file, line, 'utf8')
  } catch {
    /* logging must never break the update itself */
  }
}

/** Opens the log folder in Explorer and returns the log path. */
export function revealUpdateLog(): string {
  const file = updateLogPath()
  try {
    shell.showItemInFolder(file)
  } catch {
    /* ignore */
  }
  return file
}

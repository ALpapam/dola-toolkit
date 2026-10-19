// Launch the built Dola Toolkit app with remote debugging enabled.
//
// The DSH shell runs with ELECTRON_RUN_AS_NODE=1 in its environment and under a
// restricted token, so Electron aborts at startup unless we
//   1. clear ELECTRON_RUN_AS_NODE, and
//   2. pass --no-sandbox plus an explicit user-data dir.
// Usage: node scripts/run-app.mjs [port]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = process.argv[2] ?? '9331'
const electron = resolve('node_modules/electron/dist/electron.exe')
if (!existsSync(electron)) {
  console.error('electron binary missing — run node node_modules/electron/install.js')
  process.exit(1)
}

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
mkdirSync('.tmp', { recursive: true })

const child = spawn(
  electron,
  [
    '--no-sandbox',
    `--user-data-dir=${resolve('.tmp/userData')}`,
    `--remote-debugging-port=${PORT}`,
    resolve('.')
  ],
  { stdio: 'inherit', env }
)
child.on('exit', (code) => process.exit(code ?? 0))

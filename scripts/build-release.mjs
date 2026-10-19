// One-shot release build: compile, package the portable exe, then copy the
// proxy cores next to it and place the final artifact in the delivery folder.
// Usage: node scripts/build-release.mjs [outDir]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT_DIR = resolve(process.argv[2] ?? 'D:\\桌面\\server\\tool')
const IS_WIN = process.platform === 'win32'

// electron-builder spawns node itself; make sure the shell's
// ELECTRON_RUN_AS_NODE does not leak into it.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', env, shell: IS_WIN })
}

run('npm', ['run', 'typecheck'])
run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--win', 'portable', '--x64'])

// electron-builder writes DolaToolkit-0.0.1-portable.exe into dist/
const distDir = resolve('dist')
const exeName = readdirSync(distDir).find((f) => f.endsWith('-portable.exe'))
if (!exeName) throw new Error('portable exe not produced in dist/')

mkdirSync(OUT_DIR, { recursive: true })
const target = join(OUT_DIR, 'DolaToolkit.exe')
copyFileSync(join(distDir, exeName), target)
console.log(`\nportable exe -> ${target}`)

// Ship the cores alongside the exe (not inside it).
const coresTarget = join(OUT_DIR, 'cores')
if (existsSync(coresTarget)) rmSync(coresTarget, { recursive: true, force: true })
run('node', ['scripts/copy-cores.mjs', coresTarget])

console.log('\nBuild complete:')
console.log('  exe   :', target)
console.log('  cores :', coresTarget)

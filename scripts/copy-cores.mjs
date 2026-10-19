// Copy the proxy cores + geo route files next to the packaged exe so the
// portable build can start engines without embedding ~200 MB in the archive.
//
// The app looks for:
//   <exeDir>/cores/xray/xray.exe
//   <exeDir>/cores/mihomo/mihomo.exe
//   <exeDir>/cores/singbox/sing-box.exe
//   <exeDir>/cores/geofiles/{geoip,geosite}.dat
//
// Sources may be either flat (D:\桌面\server\tool\xray.exe) or already nested
// (project cores/xray/xray.exe), so both are normalised here.
// Usage: node scripts/copy-cores.mjs [targetDir]
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TARGET = resolve(process.argv[2] ?? 'dist/cores')

const SOURCES = [resolve('cores'), 'D:\\桌面\\server\\tool']

/** find a file in `<src>/<sub>/name` or `<src>/name` */
function findIn(src, sub, name) {
  const nested = join(src, sub, name)
  if (existsSync(nested)) return nested
  const flat = join(src, name)
  if (existsSync(flat)) return flat
  return null
}

const NEEDED = [
  ['xray', ['xray'], ['xray.exe']],
  ['mihomo', ['mihomo'], ['mihomo.exe']],
  ['singbox', ['singbox'], ['sing-box.exe']]
]

const placed = []
for (const [dir, subs, names] of NEEDED) {
  let found = null
  for (const src of SOURCES) {
    for (const sub of subs) {
      for (const name of names) {
        found = findIn(src, sub, name)
        if (found) break
      }
      if (found) break
    }
    if (found) break
  }
  if (!found) {
    console.warn(`  ${dir.padEnd(8)} MISSING`)
    continue
  }
  const outDir = join(TARGET, dir)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, names[0])
  cpSync(found, outFile)
  placed.push([dir, found])
  console.log(`  ${dir.padEnd(8)} ${found}`)
}

// geoip.dat / geosite.dat
const geoOut = join(TARGET, 'geofiles')
mkdirSync(geoOut, { recursive: true })
for (const name of ['geoip.dat', 'geosite.dat']) {
  let found = null
  for (const src of SOURCES) {
    found = findIn(src, 'geofiles', name)
    if (found) break
  }
  if (!found) {
    console.warn(`  ${name} MISSING`)
    continue
  }
  cpSync(found, join(geoOut, name))
  console.log(`  ${name.padEnd(12)} ${found}`)
}

let total = 0
const walk = (d) => {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name)
    if (n.isDirectory()) walk(p)
    else total += statSync(p).size
  }
}
walk(TARGET)
console.log(`\ncores -> ${TARGET}  (${(total / 1024 / 1024).toFixed(1)} MB, ${placed.length}/3 engines)`)

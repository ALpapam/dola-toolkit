// One-shot rebrand helper: Dola Toolkit -> Dola Toolkit.
// Keeps identifiers / User-Agent strings safe by targeting them explicitly.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const EXT = new Set(['.ts', '.tsx', '.css', '.html', '.mjs', '.json', '.yml', '.md'])

const RULES = [
  // brand text
  [/Dola Toolkit/g, 'Dola Toolkit'],
  // storage keys / css classes / data attributes
  [/moebox\./g, 'dola.'],
  [/__dolaBtoaPatched/g, '__dolaBtoaPatched'],
  [/data-dola-broken/g, 'data-dola-broken'],
  [/\[moebox\]/g, '[dola]'],
  [/dola-test-/g, 'dola-test-'],
  [/DOLA_DATA_DIR/g, 'DOLA_DATA_DIR'],
  [/\.dola-data/g, '.dola-data'],
  [/moebox-settings\.json/g, 'dola-settings.json'],
  [/moebox-library\.json/g, 'dola-library.json'],
  // identity
  [/io\.moebox\.app/g, 'io.dola.toolkit'],
  [/github\.com\/ALpapam\/moebox/g, 'github.com/ALpapam/dola-toolkit'],
  // single-token brand used in UA / salts / namespaces (no space allowed)
  [/User-Agent': 'Dola Toolkit\//g, "User-Agent': 'DolaToolkit/"],
  [/'User-Agent': 'Dola Toolkit'/g, "'User-Agent': 'DolaToolkit'"],
  [/Namespace Dola Toolkit/g, 'Namespace DolaToolkit'],
  [/coverColorFromTitle\(title \|\| 'Dola Toolkit'\)/g, "coverColorFromTitle(title || 'dola')"],
  [/fnv1a\(input \|\| 'Dola Toolkit'\)/g, "fnv1a(input || 'dola')"]
]

let changed = 0
const seen = new Set()

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'out' || name === 'dist') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    const dot = name.lastIndexOf('.')
    if (dot < 0 || !EXT.has(name.slice(dot))) continue
    if (seen.has(full)) continue
    seen.add(full)
    let text = readFileSync(full, 'utf8')
    const before = text
    for (const [re, to] of RULES) text = text.replace(re, to)
    if (text !== before) {
      writeFileSync(full, text, 'utf8')
      changed++
      console.log('updated:', relative(ROOT, full))
    }
  }
}

walk(join(ROOT, 'src'))
walk(join(ROOT, 'scripts'))
for (const f of ['package.json', 'electron-builder.yml', 'README.md']) {
  const full = join(ROOT, f)
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    continue
  }
  const before = text
  for (const [re, to] of RULES) text = text.replace(re, to)
  if (text !== before) {
    writeFileSync(full, text, 'utf8')
    changed++
    console.log('updated:', f)
  }
}

console.log(`\n${changed} file(s) updated`)

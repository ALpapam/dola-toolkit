// Verify that EVERY image in all 13 No Game No Life EPUBs resolves and inlines.
// Replicates formats.ts resolution logic against the real files, then reports
// per-book coverage so a missing illustration can never slip through.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const DIR = 'D:/下载/NO GAME NO LIFE 遊戲人生'

function resolveZipPath(baseDir, href) {
  let raw = href
  try {
    raw = decodeURIComponent(href)
  } catch {
    /* keep verbatim */
  }
  raw = raw.split('#')[0].split('?')[0]
  if (!raw) return ''
  const combined = raw.startsWith('/') ? raw.slice(1) : baseDir + raw
  const parts = []
  for (const seg of combined.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

function makeIndex(zip) {
  const index = new Map()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    index.set(name.toLowerCase(), entry)
    try {
      index.set(decodeURIComponent(name).toLowerCase(), entry)
    } catch {
      /* ignore */
    }
  }
  return index
}

function findEntry(zip, index, candidates) {
  for (const c of candidates) {
    if (!c) continue
    const direct = zip.file(c)
    if (direct) return direct
    const hit = index.get(c.toLowerCase())
    if (hit) return hit
  }
  return null
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|svg|webp|bmp|avif)$/i

async function checkBook(file) {
  const zip = await JSZip.loadAsync(readFileSync(join(DIR, file)))
  const index = makeIndex(zip)

  const container = findEntry(zip, index, ['META-INF/container.xml'])
  let opfPath = ''
  if (container) {
    const xml = await container.async('string')
    opfPath = /full-path="([^"]+)"/.exec(xml)?.[1] ?? ''
  }
  if (!opfPath) {
    const guess = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf'))
    if (guess) opfPath = guess
  }
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opf = await findEntry(zip, index, [opfPath]).async('string')

  const manifest = new Map()
  const itemRe = /<item\b[^>]*>/g
  let m
  while ((m = itemRe.exec(opf))) {
    const tag = m[0]
    const id = /id="([^"]+)"/.exec(tag)?.[1]
    const href = /href="([^"]+)"/.exec(tag)?.[1]
    const type = /media-type="([^"]+)"/.exec(tag)?.[1] ?? ''
    if (id && href && (type.includes('html') || type.includes('xml'))) manifest.set(id, href)
  }
  const order = []
  const spineRe = /<itemref\b[^>]*idref="([^"]+)"/g
  while ((m = spineRe.exec(opf))) order.push(m[1])

  let referenced = 0
  let resolved = 0
  const missing = []

  for (const id of order) {
    const href = manifest.get(id)
    if (!href) continue
    const path = resolveZipPath(opfDir, href)
    const fileEntry = findEntry(zip, index, [path])
    if (!fileEntry) continue
    const raw = await fileEntry.async('string')
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? raw
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''

    const refs = new Set()
    for (const re of [/src="([^"]+)"/gi, /xlink:href="([^"]+)"/gi]) {
      let mm
      while ((mm = re.exec(body))) {
        const v = mm[1]
        if (v && !v.startsWith('#') && !/^https?:|^data:|^mailto:/i.test(v)) refs.add(v)
      }
    }
    const cssRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
    let cm
    while ((cm = cssRe.exec(body))) {
      const v = cm[1]
      if (v && !/^https?:|^data:/i.test(v)) refs.add(v)
    }

    for (const src of refs) {
      if (!IMAGE_EXT_RE.test(src)) continue
      referenced++
      const found = findEntry(zip, index, [resolveZipPath(dir, src), resolveZipPath('', src), src.replace(/^\.\//, '')])
      if (found) resolved++
      else missing.push(`${path} -> ${src}`)
    }
  }

  // also count image files actually present in the archive
  const imageFiles = Object.keys(zip.files).filter((p) => IMAGE_EXT_RE.test(p)).length
  return { file, referenced, resolved, imageFiles, missing }
}

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.epub')).sort()
let totalRef = 0
let totalRes = 0
let totalFiles = 0
const problems = []

for (const f of files) {
  const r = await checkBook(f)
  totalRef += r.referenced
  totalRes += r.resolved
  totalFiles += r.imageFiles
  const short = f.slice(0, 44)
  console.log(
    `${r.resolved === r.referenced ? 'OK  ' : 'FAIL'} ${short.padEnd(46)} refs=${String(r.referenced).padStart(3)} ok=${String(r.resolved).padStart(3)} imgsInZip=${String(r.imageFiles).padStart(3)}`
  )
  if (r.missing.length) problems.push(...r.missing)
}

console.log('\n================ SUMMARY ================')
console.log(`books:        ${files.length}`)
console.log(`image refs:   ${totalRef}`)
console.log(`resolved:     ${totalRes}`)
console.log(`coverage:     ${((totalRes / Math.max(1, totalRef)) * 100).toFixed(2)}%`)
console.log(`image files:  ${totalFiles}`)
if (problems.length) {
  console.log('\nMISSING:')
  for (const p of problems.slice(0, 30)) console.log('  ' + p)
  process.exit(2)
} else {
  console.log('\nAll illustrations resolve.')
}

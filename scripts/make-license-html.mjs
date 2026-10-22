import { readFileSync, writeFileSync } from 'node:fs'
const src = readFileSync('EULA.md', 'utf8')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

const out = []
let inTable = false
for (const raw of src.split(/\r?\n/)) {
  const line = raw.trimEnd()
  if (/^\|\s*[-: ]+\|/.test(line)) continue // separator row
  if (line.startsWith('|')) {
    if (!inTable) { out.push('<table>'); inTable = true }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
    continue
  }
  if (inTable) { out.push('</table>'); inTable = false }
  if (!line.trim()) continue
  if (line.startsWith('# ')) { out.push(`<h1>${inline(line.slice(2))}</h1>`); continue }
  if (line.startsWith('## ')) { out.push(`<h2>${inline(line.slice(3))}</h2>`); continue }
  if (line.startsWith('### ')) { out.push(`<h3>${inline(line.slice(4))}</h3>`); continue }
  if (line.trim() === '---') { out.push('<hr>'); continue }
  out.push(`<p>${inline(line)}</p>`)
}
if (inTable) out.push('</table>')

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>多拉工具箱 用户协议</title>
<style>
  body { font-family: "Microsoft YaHei UI","Segoe UI",sans-serif; font-size: 12.5px; line-height: 1.6; color: #1c1b1f; margin: 0; padding: 2px 10px 14px; }
  h1 { font-size: 17px; margin: 6px 0 12px; }
  h2 { font-size: 13.5px; margin: 16px 0 6px; color: #4a3b6b; }
  h3 { font-size: 12.5px; margin: 12px 0 4px; }
  p { margin: 5px 0; }
  strong { color: #4a3b6b; }
  hr { border: 0; border-top: 1px solid #d8d2de; margin: 12px 0; }
  table { border-collapse: collapse; margin: 6px 0; }
  td { border: 1px solid #d8d2de; padding: 3px 8px; }
  code { background: #efe9f4; padding: 1px 4px; border-radius: 4px; font-family: Consolas,monospace; }
  a { color: #6f4fb5; }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`
writeFileSync('build/license.html', '\uFEFF' + page, 'utf8')
console.log('license.html bytes:', Buffer.byteLength(page))
console.log('含中文标题:', page.includes('多拉工具箱 用户协议'))
console.log('残留 markdown 表格行:', /^\|/m.test(page))

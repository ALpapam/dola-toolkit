// Create the small library fixtures used by the screenshot / e2e scripts.
// Run: node scripts/make-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

mkdirSync('.tmp/fixtures', { recursive: true })

// ---- TXT (Chinese, exercises GBK/UTF-8 sniffing) --------------------------
const txt = [
  '星海拾遗',
  '',
  '第一章 启程',
  '',
  '这是一段用于测试的正文。阅读器需要正确处理中文字符、标点符号，',
  '并在窄窗口下单页显示、宽窗口下双页显示。',
  '',
  '第二章 远航',
  '',
  '翻页可以通过悬浮按钮完成，也可以按住页面右下角四分之一区域。',
  '按住左下角四分之一区域则会回到上一页。',
  ...Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段：用于撑开分页的测试段落。`),
  ''
].join('\n')
writeFileSync(resolve('.tmp/fixtures/test-cn.txt'), txt, 'utf8')

// ---- FB2 ------------------------------------------------------------------
const paragraphs = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 段：FB2 解析测试内容。</p>`).join('\n')
const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <genre>sf</genre>
      <author><first-name>测试</first-name><last-name>作者</last-name></author>
      <book-title>星海三部曲</book-title>
      <lang>zh</lang>
      <annotation><p>用于测试 FB2 解析与显示的示例书籍。</p></annotation>
    </title-info>
  </description>
  <body>
    <title><p>星海三部曲</p></title>
    <section><title><p>第一章</p></title>
${paragraphs}
    </section>
  </body>
</FictionBook>`
writeFileSync(resolve('.tmp/fixtures/test-fb2.fb2'), fb2, 'utf8')

console.log('fixtures written to .tmp/fixtures')

// Build a tiny but valid EPUB 3 fixture for import/parse testing.
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
zip.file(
  'META-INF/container.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
)
zip.file(
  'OEBPS/content.opf',
  `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
    <dc:title>星海拾遗</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>Dola Toolkit Test</dc:publisher>
    <dc:description>一个用于测试 EPUB 解析的迷你书籍。</dc:description>
    <meta name="calibre:series" content="星海系列"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
)
zip.file(
  'OEBPS/nav.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head>
<body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">第一章</a></li><li><a href="ch2.xhtml">第二章</a></li></ol></nav></body></html>`
)
zip.file(
  'OEBPS/ch1.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><h1>第一章 启程</h1>
<p>这是一本用于测试的电子书。它应当能被正确解包、提取元数据并渲染到阅读器中。</p>
<p>阅读器支持双页模式：当窗口较宽时，一次显示两页，翻页时前进两页。</p>
<p>也支持单页模式：当窗口较窄时，一次显示一页。</p>
</body></html>`
)
zip.file(
  'OEBPS/ch2.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>
<body><h1>第二章 远航</h1>
<p>第二章的内容。点击页面下方四分之一区域可以翻页，左侧为上一页，右侧为下一页。</p>
<p><em>强调文字</em> 与 <strong>加粗文字</strong> 也应正常显示。</p>
</body></html>`
)
zip.file(
  'OEBPS/cover.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#6750A4"/><stop offset="1" stop-color="#7D5260"/>
  </linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <text x="200" y="300" font-size="42" fill="#fff" text-anchor="middle" font-family="sans-serif">星海拾遗</text>
  <text x="200" y="350" font-size="20" fill="#ffffffcc" text-anchor="middle" font-family="sans-serif">测试作者</text>
</svg>`
)

mkdirSync('.tmp/fixtures', { recursive: true })
const buf = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' })
writeFileSync(resolve('.tmp/fixtures/test-epub.epub'), buf)
console.log('wrote .tmp/fixtures/test-epub.epub', buf.length, 'bytes')

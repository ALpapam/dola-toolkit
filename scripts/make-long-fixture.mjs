// Generate a long TXT fixture so the reader has multiple pages to spread.
import { writeFileSync } from 'node:fs'

const chapters = [
  '第一章 星门开启',
  '第二章 无人深空',
  '第三章 潮汐锁定',
  '第四章 炉火与冰',
  '第五章 回声定位',
  '第六章 断点续传',
  '第七章 光年之外',
  '第八章 静默协议'
]

const paragraph = (n) =>
  `第 ${n} 段。这是用于验证双页排版与翻页交互的长文本测试内容。` +
  '当窗口足够宽时，书库阅读器会把页面并排成左右两页，翻页时一次前进两页；' +
  '窗口变窄后自动退回单页模式。按住页面下方四分之一区域也能翻页，左侧回到上一页，右侧前往下一页。' +
  '这段文字会重复多次，以便快速堆积出足够多的字符，触发分页逻辑。'

let out = '长篇测试之书\n\n作者：排版测试\n\n'
for (let c = 0; c < chapters.length; c++) {
  out += `${chapters[c]}\n\n`
  for (let p = 1; p <= 9; p++) {
    out += paragraph(c * 9 + p) + '\n'
    for (let k = 0; k < 3; k++) out += paragraph(c * 9 + p) + '\n'
    out += '\n'
  }
}

writeFileSync('.tmp/fixtures/test-long.txt', out, 'utf8')
console.log('wrote .tmp/fixtures/test-long.txt', out.length, 'chars')

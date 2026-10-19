// Build a compact Material Symbols (Rounded) icon module from @iconify-json.
// Run: node scripts/fetch-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ICONS = {
  // nav / shell
  proxy: 'shield',
  library: 'auto-stories',
  settings: 'settings',
  expand: 'keyboard-double-arrow-right',
  collapse: 'keyboard-double-arrow-left',
  drag: 'drag-indicator',
  // window
  winMin: 'remove',
  winMax: 'check-box-outline-blank',
  winRestore: 'filter-none',
  winClose: 'close',
  // generic actions
  add: 'add',
  close: 'close',
  check: 'check',
  delete: 'delete',
  edit: 'edit',
  more: 'more-vert',
  search: 'search',
  refresh: 'refresh',
  play: 'play-arrow',
  stop: 'stop',
  upload: 'upload',
  download: 'download',
  link: 'link',
  open: 'open-in-new',
  copy: 'content-copy',
  arrowBack: 'arrow-back',
  arrowForward: 'arrow-forward',
  chevronRight: 'chevron-right',
  chevronLeft: 'chevron-left',
  chevronUp: 'keyboard-arrow-up',
  chevronDown: 'keyboard-arrow-down',
  expandMore: 'expand-more',
  // proxy
  bolt: 'bolt',
  power: 'power-settings-new',
  speed: 'speed',
  globe: 'public',
  dns: 'dns',
  terminal: 'terminal',
  key: 'key',
  lock: 'lock',
  cloud: 'cloud',
  cloudSync: 'cloud-sync',
  shieldCheck: 'verified-user',
  memory: 'memory',
  // library
  book: 'book-2',
  bookOpen: 'menu-book',
  folder: 'folder',
  folderNew: 'create-new-folder',
  grid: 'grid-view',
  list: 'view-list',
  star: 'star',
  starOff: 'star-outline',
  autoAi: 'auto-awesome',
  translate: 'translate',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  notes: 'sticky-note-2',
  // settings
  palette: 'palette',
  tune: 'tune',
  checkCircle: 'check-circle',
  error: 'error',
  warning: 'warning',
  info: 'info',
  visibility: 'visibility',
  visibilityOff: 'visibility-off',
  wallpaper: 'wallpaper',
  contrast: 'contrast',
  darkMode: 'dark-mode',
  lightMode: 'light-mode',
  brightness: 'brightness-6',
  folderData: 'folder-open',
  aiChat: 'forum',
  send: 'send',
  home: 'home',
  sync: 'sync',
  cloudDownload: 'cloud-download',
  cloudUpload: 'cloud-upload',
  api: 'api',
  wallet: 'account-balance-wallet',
  bookSeries: 'library-books',
  menuBook: 'book',
  fullscreen: 'fullscreen',
  fullscreenExit: 'fullscreen-exit',
  nightlight: 'nightlight',
  paint: 'format-paint',
  roundness: 'rounded-corner',
  apps: 'apps',
  language: 'language',
  restart: 'restart-alt',
  externalLink: 'open-in-new',
  timer: 'timer',
  filter: 'filter-list',
  sort: 'sort',
  favorite: 'favorite',
  bookmark: 'bookmark',
  tag: 'sell',
  update: 'update',
  security: 'security',
  altRoute: 'alt-route',
  localFire: 'local-fire-department',
  analytics: 'analytics',
  dataset: 'dataset',
  lightbulb: 'lightbulb',
  history: 'history',
  screenShare: 'screen-share',
  layers: 'layers',
  density: 'density-medium',
  columnWidth: 'view-column',
  restore: 'restore-page',
  calendar: 'calendar-month',
  editNote: 'edit-note',
  formatBold: 'format-bold',
  formatItalic: 'format-italic',
  formatSize: 'format-size',
  formatLine: 'format-line-spacing',
  palette2: 'colorize',
  brush: 'brush',
  autoStories: 'auto-stories',
  book2: 'book-2',
  libraryBig: 'local-library',
  ruler: 'straighten',
  swap: 'swap-horiz',
  dragHandle: 'drag-handle',
  keyboard: 'keyboard',
  checklist: 'checklist',
  task: 'task-alt',
  progressActivity: 'progress-activity',
  wifi: 'wifi',
  lan: 'lan',
  route: 'route',
  vpn: 'vpn-key',
  speedAlt: 'network-check',
  radar: 'radar',
  settingsSuggest: 'settings-suggest',
  apps2: 'widgets',
  sparkle: 'auto-awesome',
  gem: 'diamond',
  verified: 'verified',
  block: 'block',
  addCircle: 'add-circle',
  removeCircle: 'do-not-disturb-on',
  playCircle: 'play-circle',
  pause: 'pause',
  skipNext: 'skip-next',
  skipPrev: 'skip-previous',
  firstPage: 'first-page',
  lastPage: 'last-page',
  bookmarks: 'bookmarks',
  formatQuote: 'format-quote',
  save: 'save',
  fileDownload: 'download',
  fileUpload: 'upload',
  folderZip: 'folder-zip',
  description: 'description',
  pictureAsPdf: 'picture-as-pdf',
  menuBook2: 'import-contacts',
  stack: 'stacks',
  darkM: 'dark-mode',
  lightM: 'light-mode',
  dualScreen: 'dual-screen',
  splitscreen: 'splitscreen',
  viewColumn2: 'view-column-2',
  readerMode: 'chrome-reader-mode',
  importContacts: 'import-contacts',
  localLibrary: 'local-library',
  touchApp: 'touch-app'
}

const SRC = resolve('node_modules/@iconify-json/material-symbols/icons.json')
const OUT = resolve('src/renderer/src/ui/icons.generated.ts')

const data = JSON.parse(readFileSync(SRC, 'utf8'))
const { width = 24, height = 24, icons } = data
const prefix = 'material-symbols'

const entries = []
const missing = []
for (const [key, name] of Object.entries(ICONS)) {
  const icon = icons[name]
  if (!icon) {
    missing.push(`${key} (${name})`)
    continue
  }
  const body = icon.body.replace(/\s+/g, ' ').trim()
  entries.push({ key, name, vb: `0 0 ${width} ${height}`, body })
}

const lines = []
lines.push('// AUTO-GENERATED by scripts/fetch-icons.mjs — do not edit by hand.')
lines.push('// Source: @iconify-json/material-symbols (Material Symbols Rounded, Apache-2.0)')
lines.push('')
lines.push('export interface IconDef {')
lines.push('  viewBox: string')
lines.push('  body: string')
lines.push('}')
lines.push('')
lines.push('export const ICONS: Record<string, IconDef> = {')
for (const e of entries) {
  lines.push(
    `  ${JSON.stringify(e.key)}: { viewBox: ${JSON.stringify(e.vb)}, body: ${JSON.stringify(e.body)} },`
  )
}
lines.push('}')
lines.push('')
lines.push('export type IconName = keyof typeof ICONS')
lines.push('')
lines.push('export const MISSING_ICONS: string[] = ' + JSON.stringify(missing))
lines.push('')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`wrote ${entries.length} icons -> ${OUT}`)
if (missing.length) console.log('missing:', missing.join(', '))

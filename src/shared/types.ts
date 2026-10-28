// ---------------------------------------------------------------------------
// Dola Toolkit — shared type contract (frozen; owned by Lead)
// Every IPC payload and persisted record flows through these types.
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark'
export type SeedSource = 'auto' | 'wallpaper' | 'accent' | 'custom'

export interface AppearanceSettings {
  themeMode: ThemeMode
  /** when true the seed color is derived from the desktop wallpaper (Monet) */
  monet: boolean
  seedSource: SeedSource
  /** id of the selected built-in palette (see shared/presets.ts) */
  preset: string
  /** ARGB hex like "#FF6750A4" — used when seedSource === 'custom' */
  customSeed: string
  /** fall back to a fixed MD3 baseline palette when wallpaper sampling fails */
  contrast: number
  roundness: number
  reduceMotion: boolean
}

export interface AISettings {
  enabled: boolean
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /** system prompt used for reader-side Q&A and summaries */
  systemPrompt: string
  /** preset prompt used to decide whether two books belong to one series/work */
  seriesPrompt: string
  timeoutMs: number
}

export interface WebDavSettings {
  enabled: boolean
  url: string
  username: string
  password: string
  remoteDir: string
  /** ISO timestamp of the last successful sync */
  lastSyncAt: string | null
  autoSync: boolean
  /** what gets uploaded: settings | library | both */
  scope: 'settings' | 'library' | 'both'
}

export interface ProxySettings {
  /** default engine picked when a node is created */
  defaultEngine: CoreId
  mixedPort: number
  allowLan: boolean
  /** route DNS through the proxy chain */
  remoteDns: boolean
  /**
   * How traffic is routed.
   *   bypass — 绕过大陆：CN domains/IPs go out directly, everything else uses the
   *            node (v2rayN's default; avoids sending domestic traffic abroad)
   *   global — 全局：every connection goes through the node
   */
  routingMode: 'bypass' | 'global'
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  autoStart: boolean
  /** write Windows system proxy on start / clear it on stop */
  systemProxy: boolean
  sniffing: boolean
  ipv6: boolean
  bypass: string
  /** kill switch: block traffic while the core is restarting (best effort) */
  autoRestart: boolean
}

/**
 * Which page-turn interaction/effect the reader uses.
 *   slide  — the page follows the finger horizontally and slides away
 *   cover  — the sheet peels/rotates over the next page (Tencent/Fanqie style)
 *   curl   — a soft paper-curl shadow sweep while the page follows the finger
 *   none   — instant page swap
 */
export type FlipAnimation = 'slide' | 'cover' | 'curl' | 'none'

export interface ReaderSettings {
  /** custom font family applied to book text; 'system' = built-in reading stack */
  fontFamily: string
  /** base font size in px (prose, non-EPUB pages) */
  fontSize: number
  /** line height multiplier */
  lineHeight: number
  /** page-turn animation style */
  flipAnimation: FlipAnimation
  /**
   * Use the GPU for compositing. Off = Chromium software rendering
   * (`app.disableHardwareAcceleration()`), which keeps the app usable on
   * machines with weak/broken GPU drivers. The page-turn engine automatically
   * drops to a cheaper quality profile in that mode.
   */
  gpuAcceleration: boolean
}

export interface FontFace {
  id: string
  /** family name reported by the font file / user-facing label */
  name: string
  /** absolute path of the font file on disk */
  path: string
  /** ttf | otf | woff | woff2 */
  format: 'ttf' | 'otf' | 'woff' | 'woff2' | 'ttc'
  /** true when the file lives in the app's own fonts dir (can be deleted) */
  managed: boolean
  /** size in bytes */
  size: number
  /** the bundled default font shipped with the app */
  builtin: boolean
}

export interface LibrarySettings {
  defaultView: 'grid' | 'list'
  /** auto = follow window aspect ratio */
  spreadMode: 'auto' | 'always' | 'never'
  flipMode: 'button' | 'zone' | 'both'
  aiAutoClassify: boolean
  /** managed = copy into app data, reference = keep original path */
  importMode: 'managed' | 'reference'
  defaultSort: 'added' | 'title' | 'author' | 'recent'
  coverWidth: number
}

export interface GeneralSettings {
  language: 'zh' | 'en'
  zoom: number
  closeToTray: boolean
  /**
   * true once the user has answered the "minimize to tray?" prompt — either in
   * that dialog or by flipping the setting directly. While false, closing the
   * window asks instead of guessing.
   */
  closeToTrayAsked: boolean
  /**
   * Where update metadata and downloads come from.
   *   github — authoritative: always the newest release, but can be slow or
   *            unreachable from mainland China
   *   mirror — jsDelivr metadata + gh-proxy downloads: fast, may lag behind
   */
  downloadChannel: 'github' | 'mirror'
  launchAtLogin: boolean
  checkUpdates: boolean
}

export interface Settings {
  schema: 1
  appearance: AppearanceSettings
  ai: AISettings
  sync: WebDavSettings
  proxy: ProxySettings
  library: LibrarySettings
  reader: ReaderSettings
  general: GeneralSettings
}

export interface MonetResult {
  /** seed ARGB hex */
  seed: string
  source: 'wallpaper' | 'accent' | 'custom' | 'fallback'
  /** generated MD3 schemes */
  light: ColorScheme
  dark: ColorScheme
  /** preview colors sampled from the wallpaper */
  palette: string[]
  wallpaper: string | null
}

export interface ColorScheme {
  primary: string
  onPrimary: string
  primaryContainer: string
  onPrimaryContainer: string
  secondary: string
  onSecondary: string
  secondaryContainer: string
  onSecondaryContainer: string
  tertiary: string
  onTertiary: string
  tertiaryContainer: string
  onTertiaryContainer: string
  error: string
  onError: string
  errorContainer: string
  onErrorContainer: string
  background: string
  onBackground: string
  surface: string
  onSurface: string
  surfaceVariant: string
  onSurfaceVariant: string
  surfaceDim: string
  surfaceBright: string
  surfaceContainerLowest: string
  surfaceContainerLow: string
  surfaceContainer: string
  surfaceContainerHigh: string
  surfaceContainerHighest: string
  outline: string
  outlineVariant: string
  inverseSurface: string
  inverseOnSurface: string
  inversePrimary: string
  shadow: string
  scrim: string
  [key: string]: string
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export type CoreId = 'xray' | 'mihomo' | 'singbox'

export type NodeProtocol =
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'shadowsocks'
  | 'socks'
  | 'http'
  | 'hysteria2'
  | 'tuic'
  | 'anytls'
  | 'wireguard'

export type TransportKind = 'tcp' | 'ws' | 'grpc' | 'http' | 'h2' | 'quic'

/** Flat, superset node model — the generator picks the fields each core needs. */
export interface ProxyNode {
  id: string
  name: string
  protocol: NodeProtocol
  /** preferred engine for this node */
  engine: CoreId
  server: string
  port: number
  uuid?: string
  password?: string
  method?: string
  alterId?: number
  flow?: string
  security?: 'none' | 'tls' | 'reality' | 'auto'
  sni?: string
  alpn?: string
  fingerprint?: string
  /**
   * SHA-256 of the server certificate's public key (Hysteria2 pinSHA256).
   * Servers that present a self-signed certificate are only reachable when
   * this is supplied — without it the TLS handshake is rejected.
   */
  pinSHA256?: string
  /** skip certificate verification for this node (self-signed servers) */
  allowInsecure?: boolean
  publicKey?: string
  shortId?: string
  spiderX?: string
  network?: TransportKind
  path?: string
  host?: string
  serviceName?: string
  headerType?: string
  upMbps?: number
  downMbps?: number
  obfs?: string
  obfsParam?: string
  /** extra JSON merged into the generated outbound (advanced) */
  extra?: string
  remark?: string
  group?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface NodeDraft {
  name: string
  protocol: NodeProtocol
  engine: CoreId
  server: string
  port: number
  uuid?: string
  password?: string
  method?: string
  alterId?: number
  flow?: string
  security?: 'none' | 'tls' | 'reality' | 'auto'
  sni?: string
  alpn?: string
  fingerprint?: string
  /**
   * SHA-256 of the server certificate's public key (Hysteria2 pinSHA256).
   * Servers that present a self-signed certificate are only reachable when
   * this is supplied — without it the TLS handshake is rejected.
   */
  pinSHA256?: string
  /** skip certificate verification for this node (self-signed servers) */
  allowInsecure?: boolean
  publicKey?: string
  shortId?: string
  spiderX?: string
  network?: TransportKind
  path?: string
  host?: string
  serviceName?: string
  upMbps?: number
  downMbps?: number
  obfs?: string
  obfsParam?: string
  extra?: string
  group?: string
}

export interface ImportLinksResult {
  added: ProxyNode[]
  failed: { link: string; reason: string }[]
}

export interface CoreStatus {
  engine: CoreId
  available: boolean
  version: string | null
  running: boolean
  pid: number | null
  nodeId: string | null
  startedAt: number | null
  error: string | null
  mixedPort: number
  /** rolling tail of core stdout/stderr */
  logs: string[]
}

export interface ProxyState {
  nodes: ProxyNode[]
  selectedNodeId: string | null
  engines: CoreStatus[]
  activeEngine: CoreId
  systemProxy: boolean
  geo: GeoState
  settings: ProxySettings
}

export interface GeoState {
  geoip: { path: string; size: number; updatedAt: number | null } | null
  geosite: { path: string; size: number; updatedAt: number | null } | null
  dir: string
}

export interface NodeTestResult {
  nodeId: string
  ok: boolean
  delayMs: number | null
  exitIp: string | null
  country: string | null
  error: string | null
}

export interface CoreLogEvent {
  engine: CoreId
  line: string
  level: 'info' | 'warn' | 'error'
  at: number
}

/** What the renderer shows in the "add node" sheet per engine. */
export interface EngineCapability {
  engine: CoreId
  label: string
  blurb: string
  protocols: NodeProtocol[]
  version: string | null
  available: boolean
  binary: string
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export type BookFormat = 'epub' | 'pdf' | 'fb2' | 'mobi' | 'txt' | 'rtf' | 'azw3' | 'unknown'

export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  filePath: string
  size: number
  addedAt: number
  updatedAt: number
  /** cover file inside the library cache (absolute path or null) */
  coverPath: string | null
  /** dominant cover color, "#RRGGBB" */
  coverColor: string | null
  description: string
  language: string
  publisher: string
  series: string
  /** reading progress 0..1 */
  progress: number
  /** engine-specific location (epub cfi / pdf page / txt offset) */
  lastLocation: string | null
  folderIds: string[]
  /** AI-assigned series key, also mirrored into folderIds */
  seriesKey: string | null
  favorite: boolean
  tags: string[]
  /** original path when importMode === 'reference' */
  sourcePath: string | null
}

export interface FolderRecord {
  id: string
  name: string
  parentId: string | null
  kind: 'manual' | 'series' | 'smart'
  color: string | null
  order: number
  createdAt: number
  /** smart folders created by the AI classifier keep their prompt here */
  prompt?: string
}

export interface LibraryState {
  books: BookRecord[]
  folders: FolderRecord[]
  rootDir: string
  importing: { total: number; done: number; current: string } | null
}

export interface ImportOutcome {
  added: BookRecord[]
  skipped: { path: string; reason: string }[]
}

export interface BookContent {
  id: string
  format: BookFormat
  /** utf-8 text for txt/fb2/rtf/html, base64 for epub/pdf/mobi binaries */
  data: string
  encoding: 'utf8' | 'base64'
  filePath: string
  title: string
}

export interface ClassifyResult {
  createdFolders: FolderRecord[]
  assignments: { bookId: string; folderId: string; confidence: number; reason: string }[]
  model: string
  raw?: string
  error?: string
}

export interface CatalogBook {
  source: 'gutendex' | 'openlibrary' | 'standardebooks'
  id: string
  title: string
  author: string
  language: string
  cover: string | null
  formats: { mime: string; url: string }[]
  downloadUrl: string | null
  downloads: number
}

export interface CatalogQuery {
  source: CatalogBook['source']
  query: string
  page?: number
}

export interface CatalogResult {
  books: CatalogBook[]
  total: number
  error?: string
}

// ---------------------------------------------------------------------------
// AI / Sync
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIStatus {
  configured: boolean
  enabled: boolean
  baseUrl: string
  model: string
  lastError: string | null
}

export interface AIChatResult {
  ok: boolean
  content: string
  error: string | null
  usage?: { prompt: number; completion: number; total: number }
  ms: number
}

export interface SyncStatus {
  enabled: boolean
  configured: boolean
  lastSyncAt: string | null
  running: boolean
  lastResult: { ok: boolean; message: string; at: number } | null
}

// ---------------------------------------------------------------------------
// Misc / events
// ---------------------------------------------------------------------------

export interface NavTool {
  id: string
  name: string
  icon: string
  order: number
  visible: boolean
}

/** Result of checking the app itself against the latest release. */
export interface AppUpdateInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
  channel: DownloadChannel
  downloadUrl: string | null
  notes: string | null
  publishedAt: string | null
  error: string | null
}

export type DownloadChannel = 'github' | 'mirror'

/** Result of checking one proxy core against its upstream release. */
export interface CoreUpdateInfo {
  engine: CoreId
  label: string
  /** null when the core is not installed at all */
  local: string | null
  latest: string | null
  /** no local binary → offer a download instead of an update */
  missing: boolean
  updateAvailable: boolean
  channel: DownloadChannel
  assetUrl: string | null
  /** SHA-256 published by the release (hex), used to verify the download */
  assetSha256: string | null
  error: string | null
}

/** A verified core binary waiting in the staging folder for the next restart. */
export interface StagedCoreInfo {
  engine: CoreId
  label: string
  version: string
  size: number
  sha256: string
  targetPath: string
}

export interface UpdateProgress {
  kind: 'app' | 'core'
  engine?: CoreId
  percent: number
  state: 'downloading' | 'done' | 'error'
  message?: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userData: string
  logsDir: string
}

export interface ToastEvent {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K]
}

export interface SettingsPatch {
  appearance?: Partial<AppearanceSettings>
  ai?: Partial<AISettings>
  sync?: Partial<WebDavSettings>
  proxy?: Partial<ProxySettings>
  library?: Partial<LibrarySettings>
  reader?: Partial<ReaderSettings>
  general?: Partial<GeneralSettings>
}

/** Fonts reported to the renderer. */
export interface FontList {
  fonts: FontFace[]
  /** id of the bundled default family */
  defaultId: string
}

// ---------------------------------------------------------------------------
// Mods (sidebar tools installed from a .zip package)
// ---------------------------------------------------------------------------

export interface ModRecordInfo {
  id: string
  name: string
  version: string
  description: string
  icon: string
  settingsIcon: string
  settingsName: string
  createdAt: string
  entry: string
  installedAt: number
  /** true until the first-run guide has been dismissed once */
  firstRun: boolean
  enabled: boolean
}

export interface ModImportResult {
  ok: boolean
  canceled?: boolean
  error?: string
  mod?: ModRecordInfo
  /** true when an older version of the same mod was replaced */
  upgraded?: boolean
}

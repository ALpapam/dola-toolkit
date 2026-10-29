import type {
  AIChatResult,
  AIStatus,
  AppInfo,
  BookContent,
  BookRecord,
  CatalogQuery,
  CatalogResult,
  ClassifyResult,
  CoreId,
  CoreLogEvent,
  CoreStatus,
  EngineCapability,
  FontFace,
  FolderRecord,
  ImportLinksResult,
  ImportOutcome,
  LibraryState,
  MonetResult,
  NodeDraft,
  NodeTestResult,
  ProxyNode,
  ProxyState,
  Settings,
  SettingsPatch,
  SyncStatus,
  ToastEvent
} from '@shared/types'

export interface DolaToolkitApi {
  app: {
    info(): Promise<AppInfo>
    quit(): void
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** fires when closing needs the user's decision (minimize to tray or quit) */
    onCloseAsk(cb: () => void): () => void
    /** answers that prompt; remember=true also updates the setting */
    resolveClose(choice: { closeToTray: boolean; remember: boolean }): Promise<boolean>
    /** false when this session has no notification area; hide-to-tray is unsafe */
    trayAvailable(): Promise<{ available: boolean; icon: { width: number; height: number } | null }>
    openExternal(url: string): Promise<void>
    showItem(path: string): Promise<void>
    openLogs(): Promise<void>
    /** page-turn snapshot of a rect inside the window content (data URL) */
    capture(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
    setTitleBarTheme(dark: boolean): void
    checkAppUpdate(): Promise<import('@shared/types').AppUpdateInfo>
    checkCoreUpdates(): Promise<import('@shared/types').CoreUpdateInfo[]>
    downloadAppUpdate(): Promise<{ ok: boolean; path?: string; error?: string }>
    installAppUpdate(installerPath: string, targetVersion?: string): Promise<{ ok: boolean; error?: string }>
    stageCore(engine: string): Promise<{
      ok: boolean
      staged?: import('@shared/types').StagedCoreInfo
      needsRestart?: boolean
      error?: string
    }>
    stageAllCores(): Promise<{
      ok: boolean
      staged: import('@shared/types').StagedCoreInfo[]
      failed: { engine: string; error: string }[]
      needsRestart: boolean
    }>
    stagedCores(): Promise<import('@shared/types').StagedCoreInfo[]>
    clearStagedCores(): Promise<{ ok: boolean }>
    applyStagedNow(): Promise<{ ok: boolean; count?: number; error?: string }>
    hasStaged(): Promise<boolean>
    openUpdateLog(): Promise<string>
    updateLogPath(): Promise<string>
    takePendingUpdate(): Promise<{ from: string; to: string; updated: boolean } | null>
    openReleases(): Promise<boolean>
    onUpdateProgress(cb: (p: import('@shared/types').UpdateProgress) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    patch(patch: SettingsPatch): Promise<Settings>
    reset(): Promise<Settings>
    onChanged(cb: (s: Settings) => void): () => void
  }
  theme: {
    monet(force?: boolean): Promise<MonetResult>
    onChanged(cb: (m: MonetResult) => void): () => void
  }
  /** generic bridge to a mod's main-process service */
  mod: {
    invoke<T = unknown>(id: string, channel: string, ...args: unknown[]): Promise<T>
    on(id: string, channel: string, cb: (payload: unknown) => void): () => void
  }
  library: {
    state(): Promise<LibraryState>
    import(): Promise<ImportOutcome>
    importPaths(paths: string[]): Promise<ImportOutcome>
    removeBooks(ids: string[]): Promise<LibraryState>
    updateBook(id: string, patch: Partial<BookRecord>): Promise<BookRecord>
    content(id: string): Promise<BookContent>
    createFolder(name: string, parentId?: string | null): Promise<FolderRecord>
    updateFolder(id: string, patch: Partial<FolderRecord>): Promise<FolderRecord>
    deleteFolder(id: string): Promise<LibraryState>
    classify(): Promise<ClassifyResult>
    cover(id: string): Promise<string | null>
    catalog(q: CatalogQuery): Promise<CatalogResult>
    catalogDownload(book: CatalogResult['books'][number]): Promise<BookRecord>
    onChanged(cb: (s: LibraryState) => void): () => void
    onProgress(cb: (p: { done: number; total: number; current: string }) => void): () => void
  }
  ai: {
    status(): Promise<AIStatus>
    chat(msgs: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<AIChatResult>
    test(): Promise<AIChatResult>
  }
  sync: {
    status(): Promise<SyncStatus>
    run(): Promise<SyncStatus>
    test(): Promise<{ ok: boolean; message: string }>
    onChanged(cb: (s: SyncStatus) => void): () => void
  }
  fonts: {
    list(): Promise<{ fonts: FontFace[]; defaultId: string; dir: string }>
    import(): Promise<{ imported: FontFace[]; skipped: { path: string; reason: string }[] }>
    importPaths(paths: string[]): Promise<{ imported: FontFace[]; skipped: { path: string; reason: string }[] }>
    remove(id: string): Promise<{ ok: boolean; reason?: string }>
    reveal(): Promise<string>
  }
  mods: {
    list(): Promise<import('@shared/types').ModRecordInfo[]>
    /** installs from an explicit zip path (drag-and-drop) */
    importZip(zipPath: string): Promise<import('@shared/types').ModImportResult>
    /** opens a file dialog, then installs */
    pickAndImport(): Promise<import('@shared/types').ModImportResult>
    uninstall(id: string): Promise<{ ok: boolean; error?: string }>
    setOrder(ids: string[]): Promise<{ ok: boolean }>
    markIntroduced(id: string): Promise<{ ok: boolean }>
    openFolder(): Promise<string>
    onChanged(cb: () => void): () => void
  }
  /** absolute path of a dropped file (File.path no longer exists in Chromium) */
  filePath(file: File): string
  env: {
    platform: string
    versions: Record<string, string>
  }
  onToast(cb: (t: ToastEvent) => void): () => void
}

declare global {
  interface Window {
    api: DolaToolkitApi
  }
}

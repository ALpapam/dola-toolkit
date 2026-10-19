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
    openExternal(url: string): Promise<void>
    showItem(path: string): Promise<void>
    openLogs(): Promise<void>
    setTitleBarTheme(dark: boolean): void
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
  proxy: {
    state(): Promise<ProxyState>
    engines(): Promise<EngineCapability[]>
    saveNode(node: Partial<ProxyNode> & { id?: string }): Promise<ProxyNode>
    deleteNode(id: string): Promise<void>
    importLinks(text: string): Promise<ImportLinksResult>
    selectNode(id: string | null): Promise<ProxyState>
    start(): Promise<CoreStatus>
    stop(): Promise<CoreStatus>
    testNode(id: string): Promise<NodeTestResult>
    setSystemProxy(on: boolean): Promise<boolean>
    importGeo(): Promise<ProxyState>
    updateGeo(): Promise<ProxyState>
    clearLogs(engine: CoreId): Promise<void>
    onState(cb: (s: ProxyState) => void): () => void
    onLog(cb: (e: CoreLogEvent) => void): () => void
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

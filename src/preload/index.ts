import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/channels'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    quit: () => ipcRenderer.send(IPC.appQuit),
    minimize: () => ipcRenderer.send(IPC.appMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.appToggleMaximize),
    close: () => ipcRenderer.send(IPC.appClose),
    onCloseAsk: (cb: () => void) => on(IPC.appCloseAsk, cb),
    resolveClose: (choice: { closeToTray: boolean; remember: boolean }) =>
      ipcRenderer.invoke(IPC.appCloseResolve, choice),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    showItem: (path: string) => ipcRenderer.invoke(IPC.appShowItem, path),
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
    capture: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC.appCapture, rect),
    setTitleBarTheme: (dark: boolean) => ipcRenderer.send(IPC.appTitleBarTheme, dark)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    patch: (patch: unknown) => ipcRenderer.invoke(IPC.settingsPatch, patch),
    reset: () => ipcRenderer.invoke(IPC.settingsReset),
    onChanged: (cb: (s: unknown) => void) => on(IPC.settingsChanged, cb)
  },
  theme: {
    monet: (force?: boolean) => ipcRenderer.invoke(IPC.themeMonet, force),
    onChanged: (cb: (m: unknown) => void) => on(IPC.themeChanged, cb)
  },
  proxy: {
    state: () => ipcRenderer.invoke(IPC.proxyState),
    engines: () => ipcRenderer.invoke(IPC.proxyEngines),
    saveNode: (node: unknown) => ipcRenderer.invoke(IPC.proxySaveNode, node),
    deleteNode: (id: string) => ipcRenderer.invoke(IPC.proxyDeleteNode, id),
    importLinks: (text: string) => ipcRenderer.invoke(IPC.proxyImportLinks, text),
    selectNode: (id: string | null) => ipcRenderer.invoke(IPC.proxySelectNode, id),
    start: () => ipcRenderer.invoke(IPC.proxyStart),
    stop: () => ipcRenderer.invoke(IPC.proxyStop),
    testNode: (id: string) => ipcRenderer.invoke(IPC.proxyTestNode, id),
    setSystemProxy: (on: boolean) => ipcRenderer.invoke(IPC.proxySystemProxy, on),
    importGeo: () => ipcRenderer.invoke(IPC.proxyImportGeo),
    updateGeo: () => ipcRenderer.invoke(IPC.proxyUpdateGeo),
    clearLogs: (engine: string) => ipcRenderer.invoke(IPC.proxyClearLogs, engine),
    onState: (cb: (s: unknown) => void) => on(IPC.proxyStateChanged, cb),
    onLog: (cb: (e: unknown) => void) => on(IPC.proxyLog, cb)
  },
  library: {
    state: () => ipcRenderer.invoke(IPC.libraryState),
    import: () => ipcRenderer.invoke(IPC.libraryImport),
    importPaths: (paths: string[]) => ipcRenderer.invoke(IPC.libraryImportPaths, paths),
    removeBooks: (ids: string[]) => ipcRenderer.invoke(IPC.libraryRemoveBooks, ids),
    updateBook: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.libraryUpdateBook, id, patch),
    content: (id: string) => ipcRenderer.invoke(IPC.libraryContent, id),
    createFolder: (name: string, parentId?: string | null) =>
      ipcRenderer.invoke(IPC.libraryCreateFolder, name, parentId),
    updateFolder: (id: string, patch: unknown) =>
      ipcRenderer.invoke(IPC.libraryUpdateFolder, id, patch),
    deleteFolder: (id: string) => ipcRenderer.invoke(IPC.libraryDeleteFolder, id),
    classify: () => ipcRenderer.invoke(IPC.libraryClassify),
    cover: (id: string) => ipcRenderer.invoke(IPC.libraryCover, id),
    catalog: (q: unknown) => ipcRenderer.invoke(IPC.libraryCatalog, q),
    catalogDownload: (b: unknown) => ipcRenderer.invoke(IPC.libraryCatalogDownload, b),
    onChanged: (cb: (s: unknown) => void) => on(IPC.libraryChanged, cb),
    onProgress: (cb: (p: unknown) => void) => on(IPC.libraryProgress, cb)
  },
  ai: {
    status: () => ipcRenderer.invoke(IPC.aiStatus),
    chat: (msgs: unknown) => ipcRenderer.invoke(IPC.aiChat, msgs),
    test: () => ipcRenderer.invoke(IPC.aiTest)
  },
  sync: {
    status: () => ipcRenderer.invoke(IPC.syncStatus),
    run: () => ipcRenderer.invoke(IPC.syncRun),
    test: () => ipcRenderer.invoke(IPC.syncTest),
    onChanged: (cb: (s: unknown) => void) => on(IPC.syncChanged, cb)
  },
  fonts: {
    list: () => ipcRenderer.invoke(IPC.fontsList),
    import: () => ipcRenderer.invoke(IPC.fontsImport),
    importPaths: (paths: string[]) => ipcRenderer.invoke(IPC.fontsImportPaths, paths),
    remove: (id: string) => ipcRenderer.invoke(IPC.fontsRemove, id),
    reveal: () => ipcRenderer.invoke(IPC.fontsReveal)
  },
  env: {
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  },
  onToast: (cb: (t: unknown) => void) => on('app:toast', cb)
}

contextBridge.exposeInMainWorld('api', api)

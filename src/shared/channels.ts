// Frozen IPC channel names — shared between main, preload and renderer.

export const IPC = {
  // app
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appMinimize: 'app:minimize',
  appToggleMaximize: 'app:toggle-maximize',
  appClose: 'app:close',
  /** main -> renderer: ask whether closing should hide to tray */
  appCloseAsk: 'app:close-ask',
  /** renderer -> main: the answer to that prompt */
  appCloseResolve: 'app:close-resolve',
  appOpenExternal: 'app:open-external',
  appShowItem: 'app:show-item',
  appCapture: 'app:capture',
  appTitleBarTheme: 'app:titlebar-theme',
  appOpenLogs: 'app:open-logs',

  // settings
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',
  settingsChanged: 'settings:changed',

  // theme / monet
  themeMonet: 'theme:monet',
  themeRefresh: 'theme:refresh',
  themeChanged: 'theme:changed',

  // proxy
  proxyState: 'proxy:state',
  proxyStateChanged: 'proxy:state-changed',
  proxySaveNode: 'proxy:save-node',
  proxyDeleteNode: 'proxy:delete-node',
  proxyImportLinks: 'proxy:import-links',
  proxySelectNode: 'proxy:select-node',
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  proxyTestNode: 'proxy:test-node',
  proxyLog: 'proxy:log',
  proxyEngines: 'proxy:engines',
  proxyImportGeo: 'proxy:import-geo',
  proxyUpdateGeo: 'proxy:update-geo',
  proxySystemProxy: 'proxy:system-proxy',
  proxyClearLogs: 'proxy:clear-logs',

  // library
  libraryState: 'library:state',
  libraryChanged: 'library:changed',
  libraryImport: 'library:import',
  libraryImportPaths: 'library:import-paths',
  libraryRemoveBooks: 'library:remove-books',
  libraryUpdateBook: 'library:update-book',
  libraryContent: 'library:content',
  libraryCover: 'library:cover',
  libraryCreateFolder: 'library:create-folder',
  libraryUpdateFolder: 'library:update-folder',
  libraryDeleteFolder: 'library:delete-folder',
  libraryClassify: 'library:classify',
  libraryCatalog: 'library:catalog',
  libraryCatalogDownload: 'library:catalog-download',
  libraryProgress: 'library:progress',
  librarySearch: 'library:search',

  // ai
  aiStatus: 'ai:status',
  aiChat: 'ai:chat',
  aiTest: 'ai:test',

  // sync
  syncStatus: 'sync:status',
  syncRun: 'sync:run',
  syncTest: 'sync:test',
  syncChanged: 'sync:changed',

  // fonts (reader typography)
  fontsList: 'fonts:list',
  fontsImport: 'fonts:import',
  fontsImportPaths: 'fonts:import-paths',
  fontsRemove: 'fonts:remove',
  fontsReveal: 'fonts:reveal'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

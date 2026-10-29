// ---------------------------------------------------------------------------
// Dola Toolkit — main-process mod services
//
// A mod may ship a second bundle, `main/index.js`, which runs inside the main process
// and registers handlers. This is what lets a feature like 代理 live entirely in its
// plugin: the app core keeps no knowledge of cores, routing or system proxy, it only
// knows how to load services and forward calls.
//
// Contract (the bundle is CommonJS and exports `register`):
//
//   exports.register = (dola) => {
//     dola.ipc.handle('state', () => …)          // → mod:<id>:state
//     dola.ipc.broadcast('state', payload)       // → renderer event mod:<id>:state
//     dola.on('boot' | 'quit', () => …)
//   }
//
// Mod main code is fully trusted (it runs with Node privileges); the point is
// separation and shippability, not sandboxing.
// ---------------------------------------------------------------------------

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DeepPartial, Settings } from '@shared/types'
import { getSettings, patchSettings } from './store'
import {
  CORE_LABELS,
  clearBinaryCache,
  coreRoots,
  engineSupports,
  enginesFor,
  findCore,
  findGeo,
  findRuleSets,
  geoDir,
  geoFileInfo,
  listEngines,
  runCoreVersion
} from './proxy/binary'

/** Channel used by the renderer to reach any mod service. */
export const MOD_INVOKE = 'mod:invoke'
export const MOD_EVENT = 'mod:event'

export type ModLifecycleEvent = 'boot' | 'quit' | 'settings-changed'

interface ServiceRecord {
  id: string
  handlers: Map<string, (...args: unknown[]) => unknown>
  lifecycle: Map<ModLifecycleEvent, (() => void | Promise<void>)[]>
}

export interface ModHostApi {
  id: string
  version: string
  /** filesystem root the mod may use for its own data (created on demand) */
  dataDir: string
  ipc: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => void
    broadcast: (channel: string, payload?: unknown) => void
  }
  on: (event: ModLifecycleEvent, handler: () => void | Promise<void>) => void
  settings: {
    get: () => Settings
    patch: (patch: DeepPartial<Settings>) => Promise<Settings>
  }
  /** proxy node store, still owned by the app so upgrades keep the node list */
  store: {
    get: () => unknown
    patch: (patch: unknown) => unknown
  }
  cores: {
    labels: typeof CORE_LABELS
    find: typeof findCore
    roots: typeof coreRoots
    engines: typeof listEngines
    version: typeof runCoreVersion
    clearVersionCache: typeof clearBinaryCache
    supports: typeof engineSupports
    enginesFor: typeof enginesFor
    geo: typeof findGeo
    geoDir: typeof geoDir
    geoInfo: typeof geoFileInfo
    ruleSets: typeof findRuleSets
  }
  windows: {
    all: () => BrowserWindow[]
    main: () => BrowserWindow | null
  }
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * Feature seam used by the remaining core call sites.
 *
 * Stage 1 of the extraction: the proxy feature already lives entirely in its mod, but the
 * tray, the quit path and the updater still need to talk to it. They do so through this
 * single, name-based entry point — no proxy code is imported by the core any more.
 */
export function proxyCall<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return modServices.invoke('proxy', channel, ...args) as Promise<T>
}

class ModServiceHost {
  private services = new Map<string, ServiceRecord>()
  /** core-side subscribers for mod broadcasts */
  private listeners = new Set<(id: string, channel: string, payload: unknown) => void>()

  /** Directory a mod's main bundle lives in. */
  private mainEntry(modsRoot: string, id: string): string {
    return join(modsRoot, id, 'main', 'index.js')
  }

  /**
   * Loads every installed mod's main bundle.
   *
   * Failures are logged and skipped: one broken plugin must never stop the app from
   * starting.
   */
  async loadAll(modsRoot: string): Promise<void> {
    let entries: string[]
    try {
      const { readdirSync } = await import('node:fs')
      entries = readdirSync(modsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return
    }

    for (const id of entries) {
      const entry = this.mainEntry(modsRoot, id)
      if (!existsSync(entry)) continue
      try {
        const mod = (await import(pathToFileURL(entry).href)) as {
          register?: (api: ModHostApi) => void
        }
        const register = mod.register ?? (mod as { default?: { register?: (a: ModHostApi) => void } }).default?.register
        if (typeof register !== 'function') {
          console.warn(`[dola] mod "${id}" main bundle has no register() export, skipped`)
          continue
        }
        const record: ServiceRecord = { id, handlers: new Map(), lifecycle: new Map() }
        this.services.set(id, record)
        register(this.apiFor(id, record))
        console.log(`[dola] mod service "${id}" loaded (${record.handlers.size} handlers)`)
      } catch (e) {
        console.error(`[dola] mod service "${id}" failed to load:`, e)
      }
    }
  }

  private apiFor(id: string, record: ServiceRecord): ModHostApi {
    return {
      id,
      version: app.getVersion(),
      dataDir: join(app.getPath('userData'), 'mod-data', id),
      ipc: {
        handle: (channel, handler) => record.handlers.set(channel, handler),
        broadcast: (channel, payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(MOD_EVENT, { id, channel, payload })
          }
          for (const listener of this.listeners) listener(id, channel, payload)
        }
      },
      on: (event, handler) => {
        const list = record.lifecycle.get(event) ?? []
        list.push(handler)
        record.lifecycle.set(event, list)
      },
      settings: {
        get: () => getSettings(),
        patch: async (patch) => patchSettings(patch)
      },
      store: {
        get: () => getProxyStoreImpl(),
        patch: (patch) => patchProxyStoreImpl(patch)
      },
      cores: {
        labels: CORE_LABELS,
        find: findCore,
        roots: coreRoots,
        engines: listEngines,
        version: runCoreVersion,
        clearVersionCache: clearBinaryCache,
        supports: engineSupports,
        enginesFor,
        geo: findGeo,
        geoDir,
        geoInfo: geoFileInfo,
        ruleSets: findRuleSets
      },
      windows: {
        all: () => BrowserWindow.getAllWindows(),
        main: () => BrowserWindow.getAllWindows()[0] ?? null
      },
      log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[mod:${id}] ${message}`)
    }
  }

  /** Calls a handler registered by a mod service. */
  async invoke(id: string, channel: string, ...args: unknown[]): Promise<unknown> {
    const service = this.services.get(id)
    const handler = service?.handlers.get(channel)
    if (!handler) throw new Error(`mod "${id}" has no handler "${channel}"`)
    return handler(...args)
  }

  /** Core-side subscription to a mod's broadcasts. */
  subscribe(id: string, channel: string, cb: (payload: unknown) => void): () => void {
    const listener = (mid: string, mchannel: string, payload: unknown): void => {
      if (mid === id && mchannel === channel) cb(payload)
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  has(id: string): boolean {
    return this.services.has(id)
  }

  /** Fires a lifecycle hook, awaiting every subscriber. */
  async emit(event: ModLifecycleEvent): Promise<void> {
    for (const service of this.services.values()) {
      for (const handler of service.lifecycle.get(event) ?? []) {
        try {
          await handler()
        } catch (e) {
          console.error(`[dola] mod "${service.id}" ${event} hook failed:`, e)
        }
      }
    }
  }
}

export const modServices = new ModServiceHost()

/* node-store accessors kept lazy: the store module must be initialised first */
import { getProxyStore, patchProxyStore } from './store'
function getProxyStoreImpl(): unknown {
  return getProxyStore()
}
function patchProxyStoreImpl(patch: unknown): unknown {
  return patchProxyStore(patch as never)
}

/** Renderer → mod service bridge. */
export function registerModServiceIpc(): void {
  ipcMain.handle(MOD_INVOKE, async (_e, id: unknown, channel: unknown, args: unknown) => {
    if (typeof id !== 'string' || typeof channel !== 'string') {
      throw new Error('mod invoke: bad arguments')
    }
    const list = Array.isArray(args) ? args : []
    return modServices.invoke(id, channel, ...list)
  })
}

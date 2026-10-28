import { create } from 'zustand'
import type { Settings } from '@shared/types'

export type PageId = string

export interface ToolDef {
  id: string
  name: string
  icon: string
  desc: string
  builtin: boolean
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    id: 'proxy',
    name: '代理',
    icon: 'proxy',
    desc: '自建节点 · Xray / Mihomo / Sing-box 内核',
    builtin: true
  },
]

/**
 * Installed mods, mirrored from the main process.
 *
 * The rail renders built-in tools and mods from one list; keeping the mods here means
 * every consumer (rail, settings, first-run guide) reads the same state.
 */
export interface ModEntry {
  id: string
  name: string
  version: string
  description: string
  icon: string
  settingsIcon: string
  settingsName: string
  createdAt: string
  entry: string
  firstRun: boolean
  enabled: boolean
  installedAt: number
}

export interface LoadedFontInfo {
  id: string
  name: string
  builtin: boolean
  format: string
  url?: string | null
  size?: number
  path?: string
  managed?: boolean
}

interface AppState {
  page: PageId
  settings: Settings | null
  railExpanded: boolean
  /** order of tool ids in the rail; the settings entry is pinned last */
  railOrder: string[]
  /** installed mods, in rail order */
  mods: ModEntry[]
  ready: boolean
  /** every font family the reader can use (bundled + imported) */
  fonts: LoadedFontInfo[]
  /** CSS font-family value the reader applies to book text */
  readingFamily: string
  setPage: (p: PageId) => void
  setSettings: (s: Settings) => void
  setRailExpanded: (v: boolean) => void
  setRailOrder: (o: string[]) => void
  setMods: (m: ModEntry[]) => void
  /** refresh from the main process */
  refreshMods: () => Promise<void>
  setReady: (v: boolean) => void
  setFonts: (fonts: LoadedFontInfo[]) => void
  setReadingFamily: (family: string) => void
}

const readOrder = (): string[] => {
  try {
    const raw = localStorage.getItem('dola.railOrder')
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      // mod ids are validated when the rail merges the two lists; here only the
      // built-in ones can be trusted, and anything else is appended later
      if (Array.isArray(arr)) return arr.filter((id) => typeof id === 'string')
    }
  } catch {
    /* ignore */
  }
  return BUILTIN_TOOLS.map((t) => t.id)
}

const readExpanded = (): boolean => {
  try {
    return localStorage.getItem('dola.railExpanded') === '1'
  } catch {
    return false
  }
}

export const useApp = create<AppState>((set) => ({
  page: 'home',
  settings: null,
  railExpanded: readExpanded(),
  railOrder: readOrder(),
  mods: [],
  ready: false,
  fonts: [],
  readingFamily: 'serif',
  setPage: (page) => set({ page }),
  setSettings: (settings) => set({ settings }),
  setRailExpanded: (railExpanded) => {
    try {
      localStorage.setItem('dola.railExpanded', railExpanded ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ railExpanded })
  },
  setRailOrder: (railOrder) => {
    try {
      localStorage.setItem('dola.railOrder', JSON.stringify(railOrder))
    } catch {
      /* ignore */
    }
    set({ railOrder })
  },
  setMods: (mods) => set({ mods }),
  refreshMods: async () => {
    try {
      const mods = (await window.api.mods.list()) as ModEntry[]
      set({ mods })
    } catch {
      /* main process not ready yet */
    }
  },
  setReady: (ready) => set({ ready }),
  setFonts: (fonts) => set({ fonts }),
  setReadingFamily: (readingFamily) => set({ readingFamily })
}))

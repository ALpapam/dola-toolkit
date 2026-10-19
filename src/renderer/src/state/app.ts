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
  {
    id: 'library',
    name: '书库',
    icon: 'library',
    desc: 'EPUB / PDF / FB2 / MOBI / TXT / RTF 阅读与 AI 归类',
    builtin: true
  }
]

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
  ready: boolean
  /** every font family the reader can use (bundled + imported) */
  fonts: LoadedFontInfo[]
  /** CSS font-family value the reader applies to book text */
  readingFamily: string
  setPage: (p: PageId) => void
  setSettings: (s: Settings) => void
  setRailExpanded: (v: boolean) => void
  setRailOrder: (o: string[]) => void
  setReady: (v: boolean) => void
  setFonts: (fonts: LoadedFontInfo[]) => void
  setReadingFamily: (family: string) => void
}

const readOrder = (): string[] => {
  try {
    const raw = localStorage.getItem('dola.railOrder')
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      if (Array.isArray(arr)) {
        const valid = arr.filter((id) => BUILTIN_TOOLS.some((t) => t.id === id))
        for (const t of BUILTIN_TOOLS) if (!valid.includes(t.id)) valid.push(t.id)
        return valid
      }
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
  setReady: (ready) => set({ ready }),
  setFonts: (fonts) => set({ fonts }),
  setReadingFamily: (readingFamily) => set({ readingFamily })
}))

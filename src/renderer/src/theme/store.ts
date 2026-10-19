import { create } from 'zustand'
import type { MonetResult, Settings } from '@shared/types'
import { applyTheme } from './apply'
import { baselineMonet } from './fallback'

interface ThemeState {
  monet: MonetResult
  settings: Settings | null
  ready: boolean
  setSettings: (s: Settings) => void
  setMonet: (m: MonetResult) => void
  refresh: (force?: boolean) => Promise<void>
}

const BASELINE = baselineMonet('#6750A4')

export const useTheme = create<ThemeState>((set, get) => ({
  monet: BASELINE,
  settings: null,
  ready: false,
  setSettings: (settings) => {
    set({ settings })
    applyTheme(
      get().monet,
      settings.appearance.themeMode,
      settings.appearance.roundness,
      settings.appearance.reduceMotion
    )
  },
  setMonet: (monet) => {
    set({ monet })
    const s = get().settings
    if (s) {
      applyTheme(monet, s.appearance.themeMode, s.appearance.roundness, s.appearance.reduceMotion)
    }
  },
  refresh: async (force = false) => {
    try {
      const monet = await window.api.theme.monet(force)
      set({ monet })
      const s = get().settings
      if (s) {
        applyTheme(monet, s.appearance.themeMode, s.appearance.roundness, s.appearance.reduceMotion)
      }
    } catch {
      /* keep current */
    } finally {
      set({ ready: true })
    }
  }
}))

export function initThemeListeners(): () => void {
  const offSettings = window.api.settings.onChanged((s) => {
    useTheme.getState().setSettings(s)
    void useTheme.getState().refresh(false)
  })
  const offMonet = window.api.theme.onChanged((m) => useTheme.getState().setMonet(m))
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onMq = (): void => {
    const s = useTheme.getState().settings
    if (s) useTheme.getState().setSettings(s)
  }
  mq.addEventListener('change', onMq)
  return () => {
    offSettings()
    offMonet()
    mq.removeEventListener('change', onMq)
  }
}

import type { ColorScheme, MonetResult, ThemeMode } from '@shared/types'

export const SCHEME_FIELDS = [
  'primary',
  'primaryStrong',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'error',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'surfaceDim',
  'surfaceBright',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'outline',
  'outlineVariant',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'shadow',
  'scrim'
] as const

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export function schemeToVars(scheme: ColorScheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SCHEME_FIELDS) {
    const value = scheme[key]
    if (typeof value === 'string' && value) out[`--md-${kebab(key)}`] = value
  }
  return out
}

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(monet: MonetResult, mode: ThemeMode, roundness = 16, reduceMotion = false): void {
  const root = document.documentElement
  const scheme = resolveMode(mode) === 'dark' ? monet.dark : monet.light
  const vars = schemeToVars(scheme)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.theme = resolveMode(mode)
  root.dataset.reduceMotion = String(reduceMotion)
  root.style.setProperty('--round', `${roundness}px`)
  root.style.setProperty('--shape-lg', `${Math.max(8, roundness)}px`)
  root.style.setProperty('--shape-xl', `${Math.round(roundness * 1.75)}px`)
  document.body.style.background = scheme.background
  window.api?.app?.setTitleBarTheme?.(resolveMode(mode) === 'dark')
}

export function pickScheme(monet: MonetResult, mode: ThemeMode): ColorScheme {
  return resolveMode(mode) === 'dark' ? monet.dark : monet.light
}

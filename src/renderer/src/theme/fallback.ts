// Client-side fallback palette generator.
// Used before the main process responds, and when wallpaper sampling fails,
// so the UI is never unstyled. Mirrors the main-process Monet output shape.
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'
import type { ColorScheme, MonetResult } from '@shared/types'

function buildScheme(theme: ReturnType<typeof themeFromSourceColor>, dark: boolean): ColorScheme {
  const s = dark ? theme.schemes.dark : theme.schemes.light
  const neutral = theme.palettes.neutral
  const nv = theme.palettes.neutralVariant
  const hex = (v: number): string => hexFromArgb(v)
  return {
    primary: hex(s.primary),
    onPrimary: hex(s.onPrimary),
    primaryContainer: hex(s.primaryContainer),
    onPrimaryContainer: hex(s.onPrimaryContainer),
    secondary: hex(s.secondary),
    onSecondary: hex(s.onSecondary),
    secondaryContainer: hex(s.secondaryContainer),
    onSecondaryContainer: hex(s.onSecondaryContainer),
    tertiary: hex(s.tertiary),
    onTertiary: hex(s.onTertiary),
    tertiaryContainer: hex(s.tertiaryContainer),
    onTertiaryContainer: hex(s.onTertiaryContainer),
    error: hex(s.error),
    onError: hex(s.onError),
    errorContainer: hex(s.errorContainer),
    onErrorContainer: hex(s.onErrorContainer),
    background: hex(s.background),
    onBackground: hex(s.onBackground),
    surface: hex(s.surface),
    onSurface: hex(s.onSurface),
    surfaceVariant: hex(s.surfaceVariant),
    onSurfaceVariant: hex(s.onSurfaceVariant),
    surfaceDim: hex(neutral.tone(87)),
    surfaceBright: hex(neutral.tone(98)),
    surfaceContainerLowest: hex(neutral.tone(100)),
    surfaceContainerLow: hex(neutral.tone(96)),
    surfaceContainer: hex(neutral.tone(94)),
    surfaceContainerHigh: hex(neutral.tone(92)),
    surfaceContainerHighest: hex(neutral.tone(90)),
    outline: hex(nv.tone(50)),
    outlineVariant: hex(nv.tone(80)),
    inverseSurface: hex(neutral.tone(20)),
    inverseOnSurface: hex(neutral.tone(95)),
    inversePrimary: hex(theme.palettes.primary.tone(80)),
    shadow: '#000000',
    scrim: '#000000'
  }
}

export function baselineMonet(seed = '#6750A4'): MonetResult {
  const theme = themeFromSourceColor(argbFromHex(seed))
  return {
    seed,
    source: 'fallback',
    light: buildScheme(theme, false),
    dark: buildScheme(theme, true),
    palette: [],
    wallpaper: null
  }
}

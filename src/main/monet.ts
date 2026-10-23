// ---------------------------------------------------------------------------
// Dola Toolkit — "莫奈取色" (Monet) engine
// Desktop wallpaper → dominant seed → Material Design 3 color schemes.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage } from 'electron'
// NOTE: @material/material-color-utilities@0.4.0 ships a broken package root —
// index.js pulls in `dynamiccolor/color_spec_2025.js` and the `scheme_*.js`
// files whose internal imports omit the `.js` extension, so ESM resolution
// fails at runtime. `externalizeDepsPlugin()` would keep the package external
// and the main process would crash on boot. Importing the exact, self-contained
// modules by path lets the bundler inline them (they are dependency-clean and
// have no broken edges). Verified against the installed 0.4.0 contents.
import { themeFromSourceColor } from '../../node_modules/@material/material-color-utilities/utils/theme_utils.js'
import {
  argbFromHex,
  hexFromArgb as hexFromArgbRaw
} from '../../node_modules/@material/material-color-utilities/utils/string_utils.js'
import { Hct } from '../../node_modules/@material/material-color-utilities/hct/hct.js'
import type { TonalPalette } from '../../node_modules/@material/material-color-utilities/palettes/tonal_palette.js'
import type { ColorScheme, MonetResult, Settings } from '@shared/types'

/** The shared ColorScheme contract requires "#RRGGBB" uppercase. */
function hexFromArgb(argb: number): string {
  return hexFromArgbRaw(argb).toUpperCase()
}

const BASELINE_SEED = '#6750A4'
const WALLPAPER_NAME = 'TranscodedWallpaper'

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cache: MonetResult | null = null
let cacheKey = ''
let lastWallpaperPath: string | null = null
let lastWallpaperMtime = 0

function keyOf(settings: Settings, wallpaper: string | null, mtime: number): string {
  const a = settings.appearance
  return [
    wallpaper ?? 'none',
    mtime,
    a.seedSource,
    a.customSeed,
    a.contrast,
    a.monet ? '1' : '0'
  ].join('|')
}

// ---------------------------------------------------------------------------
// Wallpaper discovery
// ---------------------------------------------------------------------------

interface WallpaperRef {
  path: string
  mtime: number
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function existsNonEmpty(file: string): boolean {
  try {
    const st = statSync(file)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/**
 * Absolute path to reg.exe.
 *
 * The main process can inherit a PATH without System32 (portable exe, launched
 * from a minimal shell), and xecFile('reg.exe') then fails with ENOENT — the
 * wallpaper lookup would silently fall back to the default palette.
 */
function regExe(): string {
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  const abs = join(root, 'System32', 'reg.exe')
  return existsSync(abs) ? abs : 'reg.exe'
}

function registryQuery(hive: string, key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      regExe(),
      ['query', key, '/v', value],
      { windowsHide: true, timeout: 3000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        // Line shape:  "    WallPaper    REG_SZ    C:\path\wall.jpg"
        const line = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => new RegExp(`^${value}\\s+REG_`, 'i').test(l))
        if (!line) return resolve(null)
        const parts = line.split(/\s{2,}|\t+/).filter(Boolean)
        resolve(parts.length >= 3 ? parts.slice(2).join(' ').trim() : null)
      }
    )
    void hive
  })
}

async function discoverWallpaper(): Promise<WallpaperRef | null> {
  // 1) Windows transcodes the current wallpaper here (JPEG data, no extension).
  try {
    const transcoded = join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Themes',
      WALLPAPER_NAME
    )
    if (existsNonEmpty(transcoded)) return { path: transcoded, mtime: safeMtime(transcoded) }
  } catch {
    /* ignore */
  }
  // 2) Registry points at the original image file.
  const regPath = await registryQuery(
    'HKCU',
    'HKCU\\Control Panel\\Desktop',
    'WallPaper'
  )
  if (regPath && existsNonEmpty(regPath)) {
    return { path: regPath, mtime: safeMtime(regPath) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Windows accent color (HKCU\Software\Microsoft\Windows\DWM\AccentColor, ABGR)
// ---------------------------------------------------------------------------

async function readAccentColor(): Promise<string | null> {
  const raw = await registryQuery('HKCU', 'HKCU\\Software\\Microsoft\\Windows\\DWM', 'AccentColor')
  if (!raw) return null
  const m = /0x([0-9a-fA-F]{1,8})/.exec(raw) ?? /^([0-9a-fA-F]{1,8})$/.exec(raw.trim())
  if (!m) return null
  const v = Number.parseInt(m[1], 16)
  if (!Number.isFinite(v)) return null
  // DWM stores ABGR: 0xAABBGGRR
  const r = v & 0xff
  const g = (v >> 8) & 0xff
  const b = (v >> 16) & 0xff
  return hex(r, g, b)
}

// ---------------------------------------------------------------------------
// Bitmap quantization
// ---------------------------------------------------------------------------

export interface SeedSample {
  seed: string
  palette: string[]
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n)
}

function hex(r: number, g: number, b: number): string {
  return `#${[clamp255(r), clamp255(g), clamp255(b)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

/**
 * Pick a dominant seed + preview palette from a BGRA bitmap.
 * Pure function (no Electron) so it can be unit tested.
 */
export function sampleBitmap(
  bitmap: Uint8Array | Buffer,
  width: number,
  height: number
): SeedSample {
  const counts = new Map<number, number>()
  const total = width * height
  const step = total > 96 * 54 ? 2 : 1
  for (let i = 0; i < total; i += step) {
    const p = i * 4
    if (p + 3 >= bitmap.length) break
    const b = bitmap[p]
    const g = bitmap[p + 1]
    const r = bitmap[p + 2]
    const a = bitmap[p + 3]
    if (a < 16) continue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    const sat = max === 0 ? 0 : (max - min) / max
    // skip near-white, near-black and dull pixels — they make ugly seeds
    if (lum > 0.94 || lum < 0.05) continue
    if (sat < 0.12) continue
    // coarse 5-bit buckets keep near-identical colors together
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const prev = counts.get(key)
    if (prev === undefined) {
      counts.set(key, 1)
    } else {
      counts.set(key, prev + 1)
    }
  }
  if (counts.size === 0) return { seed: BASELINE_SEED, palette: [BASELINE_SEED] }

  const scored: { color: string; weight: number; count: number }[] = []
  for (const [key, count] of counts) {
    const r = ((key >> 10) & 0x1f) * 8 + 4
    const g = ((key >> 5) & 0x1f) * 8 + 4
    const b = (key & 0x1f) * 8 + 4
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    const chroma = Hct.fromInt(argbFromHex(hex(r, g, b))).chroma
    // population × colourfulness: vivid enough to seed MD3, common enough to matter
    const weight = Math.log2(1 + count) * (0.35 + Math.min(1, sat)) * (0.5 + Math.min(1, chroma / 90))
    scored.push({ color: hex(r, g, b), weight, count })
  }
  scored.sort((a, b) => b.weight - a.weight)
  const seed = scored[0].color
  const palette: string[] = []
  for (const s of scored) {
    if (palette.length >= 6) break
    if (palette.some((p) => colorDistance(p, s.color) < 24)) continue
    palette.push(s.color)
  }
  if (!palette.includes(seed)) palette.unshift(seed)
  if (palette.length < 3) {
    const base = Hct.fromInt(argbFromHex(seed))
    palette.push(hexFromArgb(Hct.from(base.hue, Math.max(8, base.chroma * 0.6), 78).toInt()))
    palette.push(hexFromArgb(Hct.from((base.hue + 40) % 360, 40, 60).toInt()))
  }
  return { seed, palette: palette.slice(0, 6) }
}

function colorDistance(a: string, b: string): number {
  const pa = argbFromHex(a)
  const pb = argbFromHex(b)
  const dr = ((pa >> 16) & 0xff) - ((pb >> 16) & 0xff)
  const dg = ((pa >> 8) & 0xff) - ((pb >> 8) & 0xff)
  const db = (pa & 0xff) - (pb & 0xff)
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

// ---------------------------------------------------------------------------
// Scheme mapping
// ---------------------------------------------------------------------------

interface ToneTable {
  surfaceDim: number
  surfaceBright: number
  lowest: number
  low: number
  container: number
  high: number
  highest: number
  outline: number
  outlineVariant: number
}

const LIGHT_TONES: ToneTable = {
  surfaceDim: 87,
  surfaceBright: 98,
  lowest: 100,
  low: 96,
  container: 94,
  high: 92,
  highest: 90,
  outline: 50,
  outlineVariant: 80
}

const DARK_TONES: ToneTable = {
  surfaceDim: 6,
  surfaceBright: 24,
  lowest: 4,
  low: 10,
  container: 12,
  high: 17,
  highest: 22,
  outline: 60,
  outlineVariant: 30
}

function tone(palette: TonalPalette, t: number): string {
  return hexFromArgb(palette.tone(Math.max(0, Math.min(100, Math.round(t)))))
}

/**
 * contrast: -1..1. Positive pushes text/primary roles to stronger separation
 * (darker primary in light mode, lighter in dark mode) and vice-versa.
 */
function shift(t: number, delta: number): number {
  return Math.max(0, Math.min(100, t + delta))
}

function buildScheme(
  source: number,
  dark: boolean,
  contrast: number
): { scheme: ColorScheme; palettes: ReturnType<typeof themeFromSourceColor>['palettes'] } {
  const theme = themeFromSourceColor(source)
  const s = dark ? theme.schemes.dark : theme.schemes.light
  const p = theme.palettes
  const tones = dark ? DARK_TONES : LIGHT_TONES
  const c = Math.max(-1, Math.min(1, contrast))
  // Higher contrast → primary far from surface. In light mode that means darker.
  const primaryDelta = dark ? c * 10 : -c * 10
  const containerDelta = dark ? -c * 4 : -c * 4
  const out: ColorScheme = {
    primary: tone(p.primary, primaryTone(p.primary, source, dark) + primaryDelta),
    onPrimary: tone(p.primary, dark ? 20 : 100),
    primaryContainer: tone(p.primary, (dark ? 30 : 90) + containerDelta),
    onPrimaryContainer: tone(p.primary, (dark ? 90 : 10) - containerDelta),
    secondary: dark ? hexFromArgb(s.secondary) : hexFromArgb(s.secondary),
    onSecondary: hexFromArgb(s.onSecondary),
    secondaryContainer: hexFromArgb(s.secondaryContainer),
    onSecondaryContainer: hexFromArgb(s.onSecondaryContainer),
    tertiary: hexFromArgb(s.tertiary),
    onTertiary: hexFromArgb(s.onTertiary),
    tertiaryContainer: hexFromArgb(s.tertiaryContainer),
    onTertiaryContainer: hexFromArgb(s.onTertiaryContainer),
    error: hexFromArgb(s.error),
    onError: hexFromArgb(s.onError),
    errorContainer: hexFromArgb(s.errorContainer),
    onErrorContainer: hexFromArgb(s.onErrorContainer),
    background: hexFromArgb(s.background),
    onBackground: hexFromArgb(s.onBackground),
    surface: hexFromArgb(s.surface),
    onSurface: hexFromArgb(s.onSurface),
    surfaceVariant: hexFromArgb(s.surfaceVariant),
    onSurfaceVariant: hexFromArgb(s.onSurfaceVariant),
    surfaceDim: tone(p.neutral, tones.surfaceDim),
    surfaceBright: tone(p.neutral, tones.surfaceBright),
    surfaceContainerLowest: tone(p.neutral, tones.lowest),
    surfaceContainerLow: tone(p.neutral, tones.low),
    surfaceContainer: tone(p.neutral, tones.container),
    surfaceContainerHigh: tone(p.neutral, tones.high),
    surfaceContainerHighest: tone(p.neutral, tones.highest),
    outline: tone(p.neutralVariant, tones.outline),
    outlineVariant: tone(p.neutralVariant, tones.outlineVariant),
    inverseSurface: hexFromArgb(s.inverseSurface),
    inverseOnSurface: hexFromArgb(s.inverseOnSurface),
    inversePrimary: hexFromArgb(s.inversePrimary),
    shadow: hexFromArgb(s.shadow),
    scrim: hexFromArgb(s.scrim)
  }
  return { scheme: out, palettes: p }
}

function primaryTone(palette: TonalPalette, source: number, dark: boolean): number {
  // MD3 default primary tone is 40 (light) / 80 (dark); keep close to the seed's
  // own tone so strongly coloured wallpapers do not collapse to the same value.
  const seedTone = Hct.fromInt(source).tone
  const target = dark ? 80 : 40
  const blended = target * 0.75 + seedTone * 0.25
  return Math.max(dark ? 60 : 20, Math.min(dark ? 90 : 60, blended))
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function fallbackResult(palette: string[] = [BASELINE_SEED]): MonetResult {
  const { scheme: light } = buildScheme(argbFromHex(BASELINE_SEED), false, 0)
  const { scheme: dark } = buildScheme(argbFromHex(BASELINE_SEED), true, 0)
  return {
    seed: BASELINE_SEED,
    source: 'fallback',
    light,
    dark,
    palette,
    wallpaper: null
  }
}

export function cachedMonet(): MonetResult | null {
  return cache
}

export async function computeMonet(settings: Settings, force = false): Promise<MonetResult> {
  try {
    return await computeInner(settings, force)
  } catch {
    return cache ?? fallbackResult()
  }
}

async function computeInner(settings: Settings, force: boolean): Promise<MonetResult> {
  const a = settings.appearance
  const wp = await discoverWallpaper()
  if (wp) {
    lastWallpaperPath = wp.path
    lastWallpaperMtime = wp.mtime
  }

  let seed: string | null = null
  let source: MonetResult['source'] = 'fallback'
  let palette: string[] = []
  let wallpaperUsed: string | null = wp?.path ?? null

  if (a.monet === false) {
    seed = a.seedSource === 'custom' ? a.customSeed : BASELINE_SEED
    source = a.seedSource === 'custom' ? 'custom' : 'fallback'
  } else if (a.seedSource === 'custom') {
    seed = a.customSeed
    source = 'custom'
  } else if (a.seedSource === 'accent') {
    seed = await readAccentColor()
    source = seed ? 'accent' : 'fallback'
    if (!seed) seed = BASELINE_SEED
  } else {
    // 'auto' | 'wallpaper'
    if (wp) {
      const img = nativeImage.createFromPath(wp.path)
      if (!img.isEmpty()) {
        const small = img.resize({ width: 96, height: 54, quality: 'good' })
        const { width, height } = small.getSize()
        // getBitmap() mutates an out-buffer in Electron 44; toBitmap() returns BGRA.
        const bitmap = small.toBitmap()
        if (width > 0 && height > 0 && bitmap && bitmap.length >= width * height * 4) {
          const sample = sampleBitmap(bitmap, width, height)
          seed = sample.seed
          palette = sample.palette
          source = 'wallpaper'
        }
      }
    }
    if (!seed) {
      // wallpaper unreadable → try accent, then baseline
      const accent = await readAccentColor()
      if (accent) {
        seed = accent
        source = 'accent'
      } else {
        seed = BASELINE_SEED
        source = 'fallback'
      }
      wallpaperUsed = null
    }
  }

  if (!seed) seed = BASELINE_SEED
  if (a.seedSource === 'custom' && !/^#[0-9a-fA-F]{6,8}$/.test(seed)) seed = BASELINE_SEED

  const key = keyOf(settings, wallpaperUsed, wp?.mtime ?? 0)
  if (!force && cache && cacheKey === key) return cache

  const argb = argbFromHex(seed.length === 9 ? seed.slice(0, 7) : seed)
  const light = buildScheme(argb, false, a.contrast).scheme
  const dark = buildScheme(argb, true, a.contrast).scheme

  if (palette.length === 0) {
    const p = themeFromSourceColor(argb).palettes
    palette = [
      hexFromArgb(p.primary.tone(40)),
      hexFromArgb(p.primary.tone(70)),
      hexFromArgb(p.secondary.tone(50)),
      hexFromArgb(p.tertiary.tone(50)),
      hexFromArgb(p.neutralVariant.tone(70)),
      hexFromArgb(p.primary.tone(90))
    ]
  }

  const result: MonetResult = {
    seed,
    source,
    light,
    dark,
    palette: palette.slice(0, 6),
    wallpaper: wallpaperUsed
  }
  cache = result
  cacheKey = key
  return result
}

/**
 * Cheap polling hook: compares the wallpaper mtime with the last sample.
 * Called from window focus / renderer refresh — never on a timer.
 */
export async function wallpaperChanged(): Promise<boolean> {
  const wp = await discoverWallpaper()
  const mtime = wp?.mtime ?? 0
  const changed = (wp?.path ?? null) !== lastWallpaperPath || mtime !== lastWallpaperMtime
  if (changed) {
    lastWallpaperPath = wp?.path ?? null
    lastWallpaperMtime = mtime
  }
  return changed
}

export function hasWallpaper(): boolean {
  return lastWallpaperPath !== null && existsSync(lastWallpaperPath)
}

export function baselineMonet(): MonetResult {
  return fallbackResult()
}

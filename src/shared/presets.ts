// ---------------------------------------------------------------------------
// Dola Toolkit — built-in MD3 (Material You) seed presets.
//
// The user asked for a default purple look plus several selectable palettes,
// so the app looks good on any desktop. Every preset is just a seed colour:
// the existing Monet engine expands it into the full 36-role MD3 scheme, so
// adding a new palette here is a one-line change.
// ---------------------------------------------------------------------------

export interface ThemePreset {
  /** stable id persisted in settings.appearance.preset */
  id: string
  /** Chinese display name */
  name: string
  /** short english hint shown under the name */
  en: string
  /** seed colour that feeds the Material colour utilities */
  seed: string
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'dola', name: '多拉紫', en: 'Dola Purple', seed: '#9A6BD8' },
  { id: 'classic', name: '典雅紫', en: 'Classic MD3', seed: '#6750A4' },
  { id: 'sakura', name: '樱粉', en: 'Sakura', seed: '#D4789B' },
  { id: 'ocean', name: '深海蓝', en: 'Ocean', seed: '#2F6FB5' },
  { id: 'matcha', name: '抹茶绿', en: 'Matcha', seed: '#4C8A57' },
  { id: 'sunset', name: '落日橙', en: 'Sunset', seed: '#D4732E' },
  { id: 'graphite', name: '石墨灰', en: 'Graphite', seed: '#5A6472' },
  { id: 'mint', name: '薄荷青', en: 'Mint', seed: '#2E9E96' },
  { id: 'amber', name: '琥珀金', en: 'Amber', seed: '#B98A2B' },
  { id: 'rosewood', name: '檀木红', en: 'Rosewood', seed: '#9C3B4B' }
]

export const DEFAULT_PRESET = THEME_PRESETS[0]

export function presetById(id: string | null | undefined): ThemePreset | null {
  if (!id) return null
  return THEME_PRESETS.find((p) => p.id === id) ?? null
}

/** Simple deterministic id for a user-picked custom colour. */
export function isPresetSeed(seed: string): boolean {
  const up = seed.toUpperCase()
  return THEME_PRESETS.some((p) => p.seed.toUpperCase() === up)
}

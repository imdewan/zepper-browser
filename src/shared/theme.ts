import type { SpaceTheme } from './types'

export const DEFAULT_THEME: SpaceTheme = { colors: [], opacity: 0.5, texture: 0 }

/** Curated gradient presets, offered when creating or editing a space. */
export const THEME_PRESETS: SpaceTheme[] = [
  { colors: [], opacity: 0.5, texture: 0 },
  { colors: ['#f4efdf'], opacity: 0.5, texture: 0 },
  { colors: ['#f0b8cd', '#e9c3e3'], opacity: 0.55, texture: 0 },
  { colors: ['#da7682', '#eb8570', '#dcce7f'], opacity: 0.55, texture: 0.15 },
  { colors: ['#5becad', '#7cc6e8'], opacity: 0.5, texture: 0 },
  { colors: ['#919bb5', '#c3b6e8', '#e8d3c3'], opacity: 0.55, texture: 0.1 },
  { colors: ['#7b6cf6', '#c06cf6', '#f66cb4'], opacity: 0.6, texture: 0.15 },
  { colors: ['#2d6cdf', '#1fb6c9'], opacity: 0.6, texture: 0 },
  { colors: ['#3a7d44', '#9bc53d'], opacity: 0.55, texture: 0.1 },
  { colors: ['#e07a2d', '#f2b134'], opacity: 0.55, texture: 0 },
  { colors: ['#5b2a86', '#1b1f3b'], opacity: 0.7, texture: 0.2 },
  { colors: ['#1d1d1f', '#3a3a3c'], opacity: 0.75, texture: 0.25 }
]

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.replace(/(.)/g, '$1$1') : value
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Builds the CSS background for a space, following the shapes Zen uses:
 * one colour is flat, two are crossing linear gradients, three add radial
 * highlights in the top corners.
 */
export function themeBackground(theme: SpaceTheme): string {
  const [c0, c1, c2] = theme.colors.map((c) => rgba(c, theme.opacity))
  switch (theme.colors.length) {
    case 0:
      return 'transparent'
    case 1:
      return c0
    case 2:
      return `linear-gradient(150deg, ${c0} 30%, transparent 120%), linear-gradient(-30deg, ${c1} 30%, transparent 120%)`
    default:
      return `linear-gradient(-5deg, ${c2} 10%, transparent 80%), radial-gradient(circle at 95% 0%, ${c1} 0%, transparent 75%), radial-gradient(circle at 0% 0%, ${c0} 10%, transparent 70%)`
  }
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * Whether chrome text should be light on this theme. The dominant colour is
 * blended over the platform material the way it appears on screen, then we
 * pick whichever of white or black text has more contrast, biased slightly
 * toward dark UI like Zen.
 */
export function prefersDarkUi(theme: SpaceTheme, systemDark: boolean): boolean {
  if (theme.colors.length === 0) return systemDark
  const base: [number, number, number] = systemDark ? [30, 30, 32] : [236, 236, 238]
  const dominant = hexToRgb(theme.colors[0])
  const a = theme.opacity
  const mixed = dominant.map((c, i) => c * a + base[i] * (1 - a)) as [number, number, number]
  const lum = luminance(mixed)
  const contrastWhite = 1.05 / (lum + 0.05)
  const contrastBlack = (lum + 0.05) / 0.05
  return contrastWhite * 1.3 > contrastBlack
}

/** The accent used for selection highlights, derived from the dominant colour. */
export function themeAccent(theme: SpaceTheme): string | null {
  return theme.colors[0] ?? null
}

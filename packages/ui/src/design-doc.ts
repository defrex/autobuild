/**
 * The generated parts of `DESIGN.md` and its `.impeccable/design.json`
 * sidecar. `tokens.ts` is the source of truth; `bun run ui:tokens` writes
 * both files through these functions, and a freshness test keeps them equal.
 * Pure: no IO.
 */
import {
  breakpoint,
  chartHue,
  color,
  control,
  font,
  type Ground,
  motion,
  rounded,
  space,
  type,
} from './tokens'

export const DESIGN_NAME = 'Autobuild ANSI'
export const DESIGN_DESCRIPTION = 'State colors on two calm grounds, with readable human language.'
export const GENERATED_COMMENT =
  '# Generated from packages/ui/src/tokens.ts by bun run ui:tokens. Do not edit.'

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const quote = (value: string) => JSON.stringify(value)
const stack = (fonts: string) => fonts.replaceAll('"', '')

/** The state inks; they are the design's primary colors. */
const STATE_INKS = new Set(['blue', 'green', 'amber', 'teal', 'red'])

type ColorRole = 'primary' | 'secondary' | 'neutral'

interface DesignColor {
  key: string
  hex: string
  role: ColorRole
}

/** Every front-matter color in order: ground colors, then chart hues. */
export function designColors(): DesignColor[] {
  const grounds: Ground[] = ['light', 'dark']
  return [
    ...grounds.flatMap((g) =>
      Object.entries(color[g]).map(([k, hex]) => ({
        key: `${g}-${kebab(k)}`,
        hex,
        role: (STATE_INKS.has(k) ? 'primary' : 'neutral') as ColorRole,
      })),
    ),
    ...grounds.flatMap((g) =>
      Object.entries(chartHue[g]).map(([k, hex]) => ({
        key: `${g}-chart-${kebab(k)}`,
        hex,
        role: 'secondary' as ColorRole,
      })),
    ),
  ]
}

/** The YAML front matter of `DESIGN.md`, fences included, with a trailing newline. */
export function designFrontMatter(): string {
  const lines = [
    '---',
    GENERATED_COMMENT,
    `name: ${DESIGN_NAME}`,
    `description: ${DESIGN_DESCRIPTION}`,
  ]
  lines.push('colors:')
  for (const c of designColors()) lines.push(`  ${c.key}: ${quote(c.hex)}`)
  lines.push('typography:')
  const faces: [string, string, string, number][] = [
    ['body', font.sans, type.body.size, type.weight.regular],
    ['body-wide', font.sans, type.body.wideSize, type.weight.regular],
    ['title', font.sans, type.title.size, type.weight.semibold],
    ['machine', font.mono, type.machine.size, type.weight.regular],
  ]
  for (const [name, family, size, weight] of faces) {
    lines.push(
      `  ${name}:`,
      `    fontFamily: ${quote(stack(family))}`,
      `    fontSize: ${quote(size)}`,
      `    fontWeight: ${weight}`,
      `    lineHeight: ${type.body.lineHeight}`,
    )
  }
  lines.push('rounded:')
  for (const [k, v] of Object.entries(rounded)) lines.push(`  ${k}: ${quote(v)}`)
  lines.push('spacing:')
  for (const [k, v] of Object.entries(space)) lines.push(`  ${k}: ${quote(v)}`)
  lines.push('components:')
  for (const [k, v] of Object.entries(control)) {
    lines.push(
      `  ${k}:`,
      `    rounded: ${quote('{rounded.square}')}`,
      `    padding: ${quote(v.padding)}`,
    )
  }
  lines.push('---')
  return `${lines.join('\n')}\n`
}

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/

/** Replace only the leading front matter block; the body stays byte-identical. */
export function withDesignFrontMatter(designMd: string): string {
  if (!FRONT_MATTER.test(designMd)) return `${designFrontMatter()}\n${designMd}`
  return designMd.replace(FRONT_MATTER, designFrontMatter())
}

/** The front matter block currently at the head of `designMd`, if any. */
export function currentDesignFrontMatter(designMd: string): string | undefined {
  return FRONT_MATTER.exec(designMd)?.[0]
}

/** sRGB hex to OKLCH: lightness 0–1, chroma, hue in degrees. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

/** Eight steps of lightness at the color's own chroma and hue. */
export function tonalRamp(hex: string): string[] {
  const { c, h } = hexToOklch(hex)
  return Array.from(
    { length: 8 },
    (_, i) => `oklch(${Math.round(15 + (i * 80) / 7)}% ${c.toFixed(4)} ${h.toFixed(2)})`,
  )
}

const sentence = (key: string) => {
  const words = key.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface DesignSidecarTokens {
  colorMeta: Record<string, { role: ColorRole; displayName: string; tonalRamp: string[] }>
  motion: { name: string; duration: string; easing: string }[]
  breakpoints: { name: string; value: string }[]
}

/** The generated keys of the sidecar's `extensions`. */
export function designSidecarTokens(): DesignSidecarTokens {
  return {
    colorMeta: Object.fromEntries(
      designColors().map((c) => [
        c.key,
        { role: c.role, displayName: sentence(c.key), tonalRamp: tonalRamp(c.hex) },
      ]),
    ),
    motion: (['feedback', 'state', 'layout'] as const).map((name) => ({
      name,
      duration: motion[name],
      easing: motion.ease,
    })),
    breakpoints: Object.entries(breakpoint).map(([name, value]) => ({ name, value })),
  }
}

/**
 * Overwrite only the generated keys of the sidecar, preserving every other
 * key and its position. `generatedAt` moves only when a generated key changed.
 */
export function withDesignSidecar(
  json: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const sidecar = JSON.parse(json) as { generatedAt?: string; extensions?: Record<string, unknown> }
  const extensions = { ...(sidecar.extensions ?? {}) }
  const generated = designSidecarTokens()
  let changed = false
  for (const [key, value] of Object.entries(generated)) {
    if (JSON.stringify(extensions[key]) !== JSON.stringify(value)) changed = true
    extensions[key] = value
  }
  if (!changed) return json
  const next = { ...sidecar, generatedAt: now(), extensions }
  return `${JSON.stringify(next, null, 2)}\n`
}

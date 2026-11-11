import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FONT_FILES } from './fonts'
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
function relativeLuminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`invalid sRGB color: ${hex}`)
  const linearChannel = (channel: string) => {
    const value = Number.parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const red = linearChannel(hex.slice(1, 3))
  const green = linearChannel(hex.slice(3, 5))
  const blue = linearChannel(hex.slice(5, 7))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

const palettes = [
  {
    ground: '#fbfbfc',
    ink: '#1a1d24',
    slack: '#5f6571',
    rule: '#dfe2e8',
    well: '#f5f6f8',
    blue: '#2557e6',
    green: '#10862f',
    amber: '#b35c00',
    teal: '#007f8a',
    red: '#d32b33',
    'red-wash': '#fef2f1',
    select: '#c9d5f7',
  },
  {
    ground: '#101219',
    ink: '#dcdfe5',
    slack: '#858b97',
    rule: '#262a35',
    well: '#181b24',
    blue: '#86a3f2',
    green: '#8fcf6e',
    amber: '#e8aa52',
    teal: '#52c3c3',
    red: '#f07777',
    'red-wash': '#2a1719',
    select: '#2c3a66',
  },
]
for (const [index, p] of palettes.entries()) {
  test(`ground ${index} owns the exact ANSI palette`, () => {
    for (const [key, value] of Object.entries(p)) expect(css).toContain(`--${key}: ${value};`)
  })
  for (const role of ['ink', 'slack', 'blue', 'green', 'amber', 'teal', 'red'] as const) {
    test(`${index}: ${role} on ground meets 4.5`, () =>
      expect(contrast(p[role], p.ground)).toBeGreaterThanOrEqual(4.5))
  }
  for (const surface of ['well', 'red-wash'] as const) {
    for (const role of ['ink', 'slack', 'red'] as const)
      test(`${index}: ${role} on ${surface} meets 4.5`, () =>
        expect(contrast(p[role], p[surface])).toBeGreaterThanOrEqual(4.5))
  }
  test(`${index}: filled primary and hover text meet 4.5`, () => {
    expect(contrast(p.ground, p.ink)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.ground, p.teal)).toBeGreaterThanOrEqual(4.5)
  })
}
test('ANSI keeps square ruled controls, semantic type, and document flow', () => {
  expect(css).toContain('Atkinson Hyperlegible Next')
  expect(css).toContain('JetBrains Mono')
  expect(css).not.toMatch(
    /box-shadow|linear-gradient|radial-gradient|100d?vh|overflow: auto|tt-flash/,
  )
  expect(css).toContain('border-bottom: 1px solid var(--rule)')
  expect(css).toContain('background: var(--ground)')
  expect(css).toContain('prefers-color-scheme: dark')
  expect(css).toContain(':root[data-theme="dark"]')
  expect(css).toContain(':root:not([data-theme="light"])')
})

test('ANSI named rules and both palettes stay recorded with the built system', () => {
  const design = readFileSync(new URL('../../../DESIGN.md', import.meta.url), 'utf8')
  const sidecar = JSON.parse(
    readFileSync(new URL('../../../.impeccable/design.json', import.meta.url), 'utf8'),
  ) as { schemaVersion: number; narrative: { rules: { name: string; body: string }[] } }
  expect(sidecar.schemaVersion).toBe(2)
  for (const name of [
    'Two Grounds',
    'Semantic Type',
    'Color Is State',
    'Title First',
    'Sign-off',
    'Glyph',
    'Square Rules',
    'Flowing Document',
  ]) {
    const fullName = `The ${name} Rule`
    const rule = sidecar.narrative.rules.find((entry) => entry.name === fullName)
    expect(rule, fullName).toBeDefined()
    expect(design).toContain(`**${fullName}.** ${rule!.body}`)
  }
  for (const palette of palettes)
    for (const color of Object.values(palette)) expect(design).toContain(color)
  expect(design).not.toMatch(/Teletext|No Hairline|One Cell|dark only/)
})

test('disabled landing controls retain ground while only escalations use red wash', () => {
  expect(css).toMatch(/\.btn:disabled\s*\{[^}]*background:\s*var\(--ground\)/)
  expect(css).toMatch(
    /\.signoff:not\(\.landing\) \.btn:disabled\s*\{[^}]*background:\s*var\(--red-wash\)/,
  )
  expect(css).not.toMatch(/\.signoff \.btn:disabled\s*\{/)
})

/** Reads a TrueType font's Unicode cmap (format 4 or 12) for one code point. */
function fontCovers(file: string, codePoint: number): boolean {
  const font = readFileSync(new URL(`./fonts/${file}`, import.meta.url))
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const tables = view.getUint16(4)
  let cmap = -1
  for (let i = 0; i < tables; i++)
    if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === 'cmap')
      cmap = view.getUint32(12 + i * 16 + 8)
  if (cmap < 0) throw new Error(`${file} has no cmap table`)
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const sub = cmap + view.getUint32(cmap + 4 + i * 8 + 4)
    const format = view.getUint16(sub)
    if (format === 12) {
      for (let g = 0; g < view.getUint32(sub + 12); g++) {
        const group = sub + 16 + g * 12
        if (codePoint >= view.getUint32(group) && codePoint <= view.getUint32(group + 4))
          return true
      }
    } else if (format === 4 && codePoint <= 0xffff) {
      const segments = view.getUint16(sub + 6) / 2
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(sub + 14 + s * 2)
        const start = view.getUint16(sub + 16 + segments * 2 + s * 2)
        if (codePoint >= start && codePoint <= end && start !== 0xffff) return true
      }
    }
  }
  return false
}

test('menu disclosure glyph draws in a packaged face that carries it', () => {
  expect(css).toMatch(/\.menu-glyph\s*\{[^}]*font-family:\s*var\(--mono\)/)
  for (const trigger of ['./dashboard/Menu.tsx', './dashboard/Shell.tsx']) {
    const source = readFileSync(new URL(trigger, import.meta.url), 'utf8')
    expect(source, trigger).toMatch(/className="menu-glyph" aria-hidden>\s*▾\s*</)
  }
  expect(fontCovers(FONT_FILES.mono, 0x25be)).toBe(true)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const stylesheet = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
const rootMatch = stylesheet.match(/:root\s*\{([\s\S]*?)\n\}/)

if (!rootMatch?.[1]) throw new Error('app/globals.css must define an initial :root block')

const root = rootMatch[1]!
const afterRoot = stylesheet.slice((rootMatch.index ?? 0) + rootMatch[0].length)

const canonicalTokens = {
  '--tt-black': '#000000',
  '--tt-white': '#e6e6e6',
  '--tt-yellow': '#d7c84f',
  '--tt-cyan': '#55b8b8',
  '--tt-green': '#65b868',
  '--tt-red': '#d96868',
  '--tt-magenta': '#ff00ff',
  '--tt-blue': '#707dcc',
  '--tt-dim': '#888888',
  '--tt-rule': '#292929',
  '--tt-well': '#141414',
} as const

function declaration(name: string): string | undefined {
  return root.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
}

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

test('the initial root owns the canonical browser palette and active-tab ink', () => {
  for (const [token, value] of Object.entries(canonicalTokens)) {
    expect(declaration(token), token).toBe(value)
  }
  expect(declaration('--nav-fill')).toBe('var(--tt-blue)')
  expect(declaration('--nav-ink')).toBe('var(--ground)')
})

const ground = canonicalTokens['--tt-black']
const textOnGround = [
  ['ink on ground', canonicalTokens['--tt-white'], ground],
  ['title and warn yellow on ground', canonicalTokens['--tt-yellow'], ground],
  ['current and live cyan on ground', canonicalTokens['--tt-cyan'], ground],
  ['done and running green on ground', canonicalTokens['--tt-green'], ground],
  ['blocked and failed red on ground', canonicalTokens['--tt-red'], ground],
  ['nav blue on ground', canonicalTokens['--tt-blue'], ground],
  ['slack on ground', canonicalTokens['--tt-dim'], ground],
] as const

const groundOnFill = [
  ['ground on ink button fill', ground, canonicalTokens['--tt-white']],
  ['ground on yellow Fastext fill', ground, canonicalTokens['--tt-yellow']],
  ['ground on cyan Fastext fill', ground, canonicalTokens['--tt-cyan']],
  ['ground on green Fastext fill', ground, canonicalTokens['--tt-green']],
  ['ground on red Fastext fill', ground, canonicalTokens['--tt-red']],
  ['resolved nav-ink on nav-fill', ground, canonicalTokens['--tt-blue']],
] as const

for (const [pair, foreground, background] of [...textOnGround, ...groundOnFill]) {
  test(`${pair} meets the text contrast floor`, () => {
    expect(contrast(foreground, background), pair).toBeGreaterThanOrEqual(4.5)
  })
}

test('slack text on the well meets the text contrast floor', () => {
  expect(
    contrast(canonicalTokens['--tt-dim'], canonicalTokens['--tt-well']),
  ).toBeGreaterThanOrEqual(4.5)
})

test('component CSS contains no literal colors outside the initial root', () => {
  expect(afterRoot).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i)
})

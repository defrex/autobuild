import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const stylesheet = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
const buildsView = readFileSync(new URL('./dashboard/BuildsView.tsx', import.meta.url), 'utf8')
const dashboardFrame = readFileSync(new URL('./dashboard/frame.tsx', import.meta.url), 'utf8')
const signIn = readFileSync(new URL('./sign-in/SignIn.tsx', import.meta.url), 'utf8')
const designSidecar = JSON.parse(
  readFileSync(new URL('../.impeccable/design.json', import.meta.url), 'utf8'),
) as {
  extensions: { glyphs: Record<string, string>; tokenSource: string }
  components: Array<{ css: string }>
  narrative: {
    keyCharacteristics: string[]
    rules: Array<{ name: string; body: string }>
  }
}
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

function compositeOnBlack(foreground: string, opacity: number): string {
  const channels = [1, 3, 5].map((offset) =>
    Math.round(Number.parseInt(foreground.slice(offset, offset + 2), 16) * opacity)
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${channels.join('')}`
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
  ['ground on active ink button fill', ground, canonicalTokens['--tt-white']],
  ['ground on active yellow Fastext fill', ground, canonicalTokens['--tt-yellow']],
  ['ground on active cyan Fastext fill', ground, canonicalTokens['--tt-cyan']],
  ['ground on active green Fastext fill', ground, canonicalTokens['--tt-green']],
  ['ground on active red Fastext fill', ground, canonicalTokens['--tt-red']],
  ['resolved nav-ink on nav-fill', ground, canonicalTokens['--tt-blue']],
] as const

for (const [pair, foreground, background] of [...textOnGround, ...groundOnFill]) {
  test(`${pair} meets the text contrast floor`, () => {
    expect(contrast(foreground, background), pair).toBeGreaterThanOrEqual(4.5)
  })
}

for (const [name, color] of [
  ['ink outline', canonicalTokens['--tt-white']],
  ['red Fastext outline', canonicalTokens['--tt-red']],
  ['green Fastext outline', canonicalTokens['--tt-green']],
  ['yellow Fastext outline', canonicalTokens['--tt-yellow']],
  ['cyan Fastext outline', canonicalTokens['--tt-cyan']],
] as const) {
  test(`${name} meets the non-text contrast floor against ground`, () => {
    expect(contrast(color, ground), name).toBeGreaterThanOrEqual(3)
  })
  if (name.includes('Fastext')) {
    test(`disabled ${name} label remains readable at reduced emphasis`, () => {
      expect(contrast(compositeOnBlack(color, 0.9), ground), name).toBeGreaterThanOrEqual(4.5)
    })
  }
}

test('slack text on the well meets the text contrast floor', () => {
  expect(
    contrast(canonicalTokens['--tt-dim'], canonicalTokens['--tt-well']),
  ).toBeGreaterThanOrEqual(4.5)
})

test('component CSS contains no literal colors outside the initial root', () => {
  expect(afterRoot).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i)
})

test('outline, ghost, and Fastext controls expose the complete state contract', () => {
  expect(declaration('--button-border')).toBe('2px')
  expect(stylesheet).toMatch(
    /\.btn\s*\{[\s\S]*?height:\s*var\(--row\);[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*var\(--button-border\) solid currentColor;/,
  )
  expect(stylesheet).toMatch(
    /\.ft\s*\{[\s\S]*?height:\s*var\(--row\);[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*var\(--button-border\) solid currentColor;/,
  )
  expect(stylesheet).toMatch(/\.btn:hover:not\(:disabled\)/)
  expect(stylesheet).toMatch(/\.btn:active:not\(:disabled\)/)
  expect(stylesheet).toMatch(/\.btn:disabled/)
  expect(stylesheet).toMatch(/:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--live\)/)

  expect(stylesheet).toMatch(/\.word\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;/)
  expect(stylesheet).toMatch(/\.word:hover:not\(:disabled\)/)
  expect(stylesheet).toMatch(/\.word:active:not\(:disabled\)/)
  expect(stylesheet).toMatch(/\.word:disabled/)
})

test('Fastext keeps slot hue through rest, interaction, empty, and disabled states', () => {
  for (const slot of ['red', 'green', 'yellow', 'cyan']) {
    expect(stylesheet).toContain(`.ft[data-slot="${slot}"] {\n  --ft-color: var(--ft-${slot});`)
  }
  expect(stylesheet).toMatch(
    /\.ft:hover:not\(:disabled\)\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?text-decoration:\s*underline;/,
  )
  expect(stylesheet).toMatch(
    /\.ft:active:not\(:disabled\)\s*\{[\s\S]*?background:\s*var\(--ft-color\);[\s\S]*?border-color:\s*var\(--ft-color\);/,
  )
  expect(stylesheet).toMatch(
    /\.ft:disabled\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--ft-color\);[\s\S]*?opacity:\s*0\.9;/,
  )
  expect(stylesheet).not.toContain('--ft-dim-ink')
  expect(dashboardFrame).toContain('data-empty')
})

test('sign-in uses the primary outline instead of a Fastext slot', () => {
  expect(signIn).toContain('className="btn"')
  expect(signIn).not.toContain('className="ft"')
  expect(signIn).not.toContain('data-slot=')
  expect(stylesheet).toMatch(/\.providers \.btn\s*\{\s*padding:\s*0 2ch;/)
})

test('held queued builds keep their canonical yellow warning while rows dim', () => {
  expect(buildsView).toContain('<span className="warn held">(held)</span>')
  expect(stylesheet).toMatch(/\.tokens \.held\s*\{\s*color:\s*var\(--title\);\s*\}/)
})

test('design sidecar preserves the fine-pointer lane contract', () => {
  expect(designSidecar.extensions.glyphs.selectedLane).toBe('> (bold)')
  expect(designSidecar.extensions.glyphs.hoverPreviewLane).toBe('> (regular)')
  expect(designSidecar.extensions.tokenSource).toContain('--lane-preview')
  expect(designSidecar.narrative.keyCharacteristics).toContain(
    'Bracket glyphs `[x] [>] [~] [ ]` for step state, `>` for the selected and fine-pointer preview lanes, `!` for messages, box-drawing `─` for rules.',
  )
  expect(designSidecar.narrative.rules.find(({ name }) => name === 'The Glyph Rule')?.body).toBe(
    'Icons are text: `[x] [>] [~] [ ]` for step state, `>` for the selected or fine-pointer preview lane, `!` for the first row of a message, `▾` for a select, `─` for rules, `×N` for the imperative count. No icon font, no SVG icon set, no emoji in the interface.',
  )
})

test('design sidecar previews use valid canonical fallback colors', () => {
  const previewCss = designSidecar.components.map(({ css }) => css).join('\n')
  const hexLiterals = previewCss.match(/#[\da-f]+/gi) ?? []

  expect(hexLiterals.length).toBeGreaterThan(0)
  for (const literal of hexLiterals) {
    expect(literal, `invalid sidecar preview color ${literal}`).toMatch(
      /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i,
    )
  }

  for (const canonical of [
    '#e6e6e6',
    '#d7c84f',
    '#55b8b8',
    '#65b868',
    '#d96868',
    '#707dcc',
    '#888888',
    '#292929',
    '#141414',
  ]) {
    expect(previewCss, `missing sidecar preview fallback ${canonical}`).toContain(canonical)
  }
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const stylesheet = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
const designDocument = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8')
const buildsView = readFileSync(new URL('./dashboard/BuildsView.tsx', import.meta.url), 'utf8')
const dashboardFrame = readFileSync(new URL('./dashboard/frame.tsx', import.meta.url), 'utf8')
const signIn = readFileSync(new URL('./sign-in/SignIn.tsx', import.meta.url), 'utf8')
const designSidecar = JSON.parse(
  readFileSync(new URL('../.impeccable/design.json', import.meta.url), 'utf8'),
) as {
  extensions: { glyphs: Record<string, string>; tokenSource: string }
  components: Array<{ name: string; description: string; css: string }>
  narrative: {
    keyCharacteristics: string[]
    rules: Array<{ name: string; body: string }>
    dos: string[]
    donts: string[]
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

function designRule(name: string): string {
  const marker = `**${name}.**`
  const start = designDocument.indexOf(marker)
  if (start === -1 || (start > 0 && designDocument[start - 1] !== '\n')) return ''

  const end = designDocument.indexOf('\n\n', start)
  return designDocument.slice(start, end === -1 ? designDocument.length : end)
}

function sidecarRule(name: string): string {
  return designSidecar.narrative.rules.find((rule) => rule.name === name)?.body ?? ''
}

test('the initial root owns the canonical browser palette', () => {
  for (const [token, value] of Object.entries(canonicalTokens)) {
    expect(declaration(token), token).toBe(value)
  }
  expect(declaration('--nav-fill')).toBeUndefined()
  expect(declaration('--nav-ink')).toBeUndefined()
})

const ground = canonicalTokens['--tt-black']
const textOnGround = [
  ['ink on ground', canonicalTokens['--tt-white'], ground],
  ['title and warn yellow on ground', canonicalTokens['--tt-yellow'], ground],
  ['current and live cyan on ground', canonicalTokens['--tt-cyan'], ground],
  ['done and running green on ground', canonicalTokens['--tt-green'], ground],
  ['blocked and failed red on ground', canonicalTokens['--tt-red'], ground],
  ['slack on ground', canonicalTokens['--tt-dim'], ground],
] as const

const groundOnFill = [
  ['ground on active ink button fill', ground, canonicalTokens['--tt-white']],
] as const

for (const [pair, foreground, background] of [...textOnGround, ...groundOnFill]) {
  test(`${pair} meets the text contrast floor`, () => {
    expect(contrast(foreground, background), pair).toBeGreaterThanOrEqual(4.5)
  })
}

test('ink outline meets the non-text contrast floor against ground', () => {
  expect(contrast(canonicalTokens['--tt-white'], ground)).toBeGreaterThanOrEqual(3)
})

test('slack text on the well meets the text contrast floor', () => {
  expect(
    contrast(canonicalTokens['--tt-dim'], canonicalTokens['--tt-well']),
  ).toBeGreaterThanOrEqual(4.5)
})

test('component CSS contains no literal colors outside the initial root', () => {
  expect(afterRoot).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i)
})

test('outline and ghost controls expose the complete state contract', () => {
  expect(declaration('--button-border')).toBe('2px')
  expect(stylesheet).toMatch(
    /\.btn\s*\{[\s\S]*?height:\s*var\(--row\);[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*var\(--button-border\) solid currentColor;/,
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

test('retired footer presentation is absent from app and design artifacts', () => {
  for (const source of [stylesheet, buildsView, dashboardFrame, designDocument]) {
    expect(source).not.toMatch(/fastext/i)
  }
  expect(designSidecar.extensions.tokenSource).not.toMatch(/fastext|--ft-/i)
  expect(designSidecar.components.some(({ name }) => /fastext/i.test(name))).toBe(false)
  expect(designSidecar.narrative.rules.some(({ name }) => /fastext/i.test(name))).toBe(false)
})

test('sign-in uses the primary outline', () => {
  expect(signIn).toContain('className="btn"')
  expect(signIn).not.toContain('className="ft"')
  expect(signIn).not.toContain('data-slot=')
  expect(stylesheet).toMatch(/\.providers \.btn\s*\{\s*padding:\s*0 2ch;/)
})

test('held queued builds keep their canonical yellow warning while rows dim', () => {
  expect(buildsView).toContain('<span className="warn held">(held)</span>')
  expect(stylesheet).toMatch(/\.tokens \.held\s*\{\s*color:\s*var\(--title\);\s*\}/)

  const documentedException = 'STATUS words, the yellow `(held)` annotation, and red alert lines'
  expect(designRule('The Alert Never Dims Rule')).toContain(documentedException)
  expect(sidecarRule('The Alert Never Dims Rule')).toContain(documentedException)
})

test('flat-grid documentation forbids translucent surfaces', () => {
  for (const source of [designRule('The Flat Grid Rule'), sidecarRule('The Flat Grid Rule')]) {
    expect(source).toContain('no surface, fill, panel, or overlay is translucent')
  }
  expect(designSidecar.narrative.donts).toContain(
    "Don't draw component borders outside the shared 2px button outline, or add shadows, gradients, or translucent surfaces, fills, panels, or overlays. Separate non-controls with a `─` rule, a fill change, or an empty row.",
  )
})

test('row controls reserve in-flow geometry and share the documented reveal contract', () => {
  expect(stylesheet).toMatch(
    /\.row-controls\s*\{[\s\S]*?display:\s*grid;[\s\S]*?height:\s*var\(--row\);[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/,
  )
  expect(stylesheet).toMatch(
    /\.row\[data-selected\] \.row-controls,\s*\.row:focus-within \.row-controls\s*\{[\s\S]*?visibility:\s*visible;/,
  )
  expect(stylesheet).toMatch(
    /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.row\[data-hovered\] \.row-controls/,
  )
  expect(stylesheet).toMatch(
    /@media \(max-width: 719px\)[\s\S]*?\.row-controls\s*\{[\s\S]*?grid-template-rows:\s*var\(--row\);[\s\S]*?height:\s*var\(--row\);/,
  )
  expect(designDocument).toContain(
    'A reserved one-row in-flow control register then sits beneath the previews',
  )
  expect(designDocument).toContain('Hidden words leave the tab order')
  expect(designDocument).toContain('the repository Harvest gate remains global')
  expect(designSidecar.components.find(({ name }) => name === 'Build row')?.description).toContain(
    'without moving row content; hidden controls leave the tab order',
  )
})

test('the shell and design contract use browser-owned document flow', () => {
  expect(stylesheet).not.toMatch(/height:\s*100d?vh|scrollbar-gutter|overscroll-behavior/)
  expect(stylesheet).not.toContain('.surface-scroll')
  expect(stylesheet).toMatch(
    /\.transcript pre,\s*\.detail pre\.block\s*\{(?![\s\S]*?max-height)(?![\s\S]*?overflow:\s*auto)[\s\S]*?\}/,
  )
  expect(dashboardFrame).not.toContain('surface-scroll')
  expect(buildsView).not.toContain('footer=')
  for (const source of [
    designRule('The Flowing Document Rule'),
    sidecarRule('The Flowing Document Rule'),
  ]) {
    expect(source).toContain('browser document is the sole scroll container')
    expect(source).toContain('no block is pinned')
    expect(source).toContain('no nested element scrolls rows or detail')
  }
  expect(designDocument).not.toContain('The Fixed Frame Rule')
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
    '#888888',
    '#292929',
    '#141414',
  ]) {
    expect(previewCss, `missing sidecar preview fallback ${canonical}`).toContain(canonical)
  }
})

import { expect, test } from 'bun:test'
import {
  designFrontMatter,
  designSidecarTokens,
  tonalRamp,
  withDesignFrontMatter,
  withDesignSidecar,
} from './design-doc'

test('the tonal ramp reproduces the recorded OKLCH values', () => {
  expect(tonalRamp('#2557e6')).toEqual([
    'oklch(15% 0.2228 264.66)',
    'oklch(26% 0.2228 264.66)',
    'oklch(38% 0.2228 264.66)',
    'oklch(49% 0.2228 264.66)',
    'oklch(61% 0.2228 264.66)',
    'oklch(72% 0.2228 264.66)',
    'oklch(84% 0.2228 264.66)',
    'oklch(95% 0.2228 264.66)',
  ])
  expect(designSidecarTokens().colorMeta['dark-red-wash']?.tonalRamp[0]).toBe(
    'oklch(15% 0.0310 12.91)',
  )
})

test('color roles: state inks are primary, chart hues secondary, the rest neutral', () => {
  const meta = designSidecarTokens().colorMeta
  expect(meta['light-blue']).toMatchObject({ role: 'primary', displayName: 'Light blue' })
  expect(meta['dark-red-wash']).toMatchObject({ role: 'neutral', displayName: 'Dark red wash' })
  expect(meta['light-chart-wait-strong']).toMatchObject({
    role: 'secondary',
    displayName: 'Light chart wait strong',
  })
})

test('the front matter carries the recorded values', () => {
  const fm = designFrontMatter()
  expect(fm.startsWith('---\n# Generated from packages/ui/src/tokens.ts')).toBe(true)
  expect(fm.endsWith('\n---\n')).toBe(true)
  expect(fm).toContain('  light-red-wash: "#fef2f1"\n')
  expect(fm).toContain('  dark-chart-plan: "#8f7bea"\n')
  expect(fm).toContain(
    '  machine:\n    fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"\n    fontSize: "0.93em"\n    fontWeight: 400\n    lineHeight: 1.5\n',
  )
  expect(fm).toContain(
    '  title:\n    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"\n    fontSize: "1em"\n    fontWeight: 600\n',
  )
  expect(fm).toContain(
    'components:\n  button:\n    rounded: "{rounded.square}"\n    padding: "3px 12px"\n',
  )
})

test('replacing the front matter leaves the body byte-identical', () => {
  const body = '\n# Design System\n\n---\n\nA rule above, *and* text.\n'
  const doc = `---\nname: old\n---\n${body}`
  expect(withDesignFrontMatter(doc)).toBe(`${designFrontMatter()}${body}`)
  expect(withDesignFrontMatter(withDesignFrontMatter(doc))).toBe(withDesignFrontMatter(doc))
})

test('sidecar merge preserves unrelated keys and keeps generatedAt when nothing changed', () => {
  const original = {
    schemaVersion: 2,
    generatedAt: 'then',
    title: 'Design System: Autobuild ANSI',
    extensions: { colorMeta: {}, typographyMeta: { body: { displayName: 'x' } }, shadows: [] },
    components: [{ name: 'button' }],
    narrative: { rules: [] },
  }
  const merged = withDesignSidecar(JSON.stringify(original, null, 2), () => 'now')
  const parsed = JSON.parse(merged)
  expect(Object.keys(parsed)).toEqual(Object.keys(original))
  expect(parsed.generatedAt).toBe('now')
  expect(parsed.extensions.typographyMeta).toEqual(original.extensions.typographyMeta)
  expect(parsed.components).toEqual(original.components)
  expect(parsed.extensions.colorMeta).toEqual(designSidecarTokens().colorMeta)
  expect(merged.endsWith('}\n')).toBe(true)
  expect(withDesignSidecar(merged, () => 'later')).toBe(merged)
})

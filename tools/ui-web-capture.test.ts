import { expect, test } from 'bun:test'
import { NOW } from '../packages/ui/src/app/fixtures'
import {
  CLS_THRESHOLD,
  clockScript,
  clsPass,
  clsRecorderScript,
  type FrameEntry,
  PART_MAX_ROWS,
  partRanges,
  renderReport,
  type UiWebVariant,
  uiWebVariants,
} from './ui-web-capture'

const PAGES = [
  'catalog',
  'overview',
  'overview-live',
  'build-running',
  'build-blocked',
  'build-waiting',
  'build-finished',
  'build-missing',
  'unknown',
]

test('every page is captured at both grounds and both widths', () => {
  const variants = uiWebVariants()
  expect(variants).toHaveLength(36)
  expect(new Set(variants.map((v) => v.id)).size).toBe(36)
  for (const v of variants) expect(v.id).toMatch(/^[a-z0-9-]+$/)
  const keys = new Set(variants.map((v) => `${v.page}|${v.ground}|${v.width}`))
  for (const page of PAGES)
    for (const ground of ['light', 'dark'])
      for (const width of [1440, 390]) expect(keys.has(`${page}|${ground}|${width}`)).toBe(true)
})

test('the CLS bound is 0.002 inclusive, and a missing measurement fails', () => {
  expect(CLS_THRESHOLD).toBe(0.002)
  for (const cls of [0, 0.0015, 0.002]) expect(clsPass(cls)).toBe(true)
  for (const cls of [0.0021, Number.NaN, undefined, null, -0.001, Number.POSITIVE_INFINITY])
    expect(clsPass(cls)).toBe(false)
})

test('parts cover the page contiguously, each within the row cap', () => {
  expect(partRanges(8192)).toEqual([{ top: 0, height: 8192 }])
  expect(partRanges(8193)).toEqual([
    { top: 0, height: 8192 },
    { top: 8192, height: 1 },
  ])
  for (const height of [1, 844, 8191, 16384, 21918, 40000]) {
    let next = 0
    for (const part of partRanges(height)) {
      expect(part.top).toBe(next)
      expect(part.height).toBeGreaterThan(0)
      expect(part.height).toBeLessThanOrEqual(PART_MAX_ROWS)
      next += part.height
    }
    expect(next).toBe(height)
  }
})

test('injected scripts compile and the clock starts at the fixtures time', () => {
  expect(() => new Function(clsRecorderScript())).not.toThrow()
  expect(() => new Function(clockScript(NOW))).not.toThrow()
  expect(clockScript(NOW)).toContain(String(NOW))
})

const frame = (v: UiWebVariant, cls: number | null, sources: string[] = []): FrameEntry => ({
  ...v,
  url: '/',
  cls,
  clsSources: sources,
  clsPass: clsPass(cls),
  height: 900,
  pngPath: `.ab/ui-web-frames/${v.id}.png`,
})

test('the report tables every variant and names failing sources', () => {
  const variants = uiWebVariants()
  const frames = variants.map((v) =>
    v.id === 'overview-live-dark-390' ? frame(v, 0.0123, ['DIV[Autobuild]@0->120']) : frame(v, 0),
  )
  const report = renderReport({
    command: 'bun run capture:ui-web',
    chromium: '/usr/bin/chromium',
    variants,
    frames,
    errors: [],
  })
  for (const v of variants) expect(report).toContain(`| ${v.id} |`)
  expect(report).toContain('| overview-live-dark-390 | 0.0123 | FAIL |')
  expect(report).toContain('| overview-light-1440 | 0.0000 | PASS |')
  expect(report).toContain('DIV[Autobuild]@0->120')
  expect(report).toContain('## Visual verdict')
  expect(report).not.toContain('Infrastructure failure')
})

test('a capture error reports an infrastructure failure and the expected inventory', () => {
  const variants = uiWebVariants()
  const report = renderReport({
    command: 'bun run capture:ui-web',
    chromium: undefined,
    variants,
    frames: [],
    errors: [{ message: 'no Chromium binary found; set CHROMIUM_BIN' }],
  })
  expect(report).toContain('## Infrastructure failure')
  expect(report).toContain('CHROMIUM_BIN')
  expect(report).toContain('### Expected inventory')
  for (const v of variants) expect(report).toContain(`- ${v.id} (`)
  expect(report).toContain('| catalog-light-1440 | n/a | MISSING |')
})

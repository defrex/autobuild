import { expect, test } from 'bun:test'
import { inspectPaint, type PaintRegion } from './website-capture-paint'
import type { DecodedPng } from './website-capture-png'

const regions: PaintRegion[] = ['header', 'middle label', 'closing'].map((label, i) => ({
  label,
  x: 2,
  y: i * 30,
  width: 16,
  height: 16,
  foreground: [220, 220, 220],
  background: [0, 0, 0],
}))
function image(channels: number, blank = -1): DecodedPng {
  return {
    width: 20,
    height: 90,
    channels,
    colorType: { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]!,
    ancillary: [],
    rows: Array.from({ length: 90 }, (_, y) => {
      const row = new Uint8Array(20 * channels)
      for (let x = 0; x < 20; x++) {
        const ink = y % 30 < 16 && x >= 4 && x < 8 && Math.floor(y / 30) !== blank
        for (let c = 0; c < channels; c++)
          row[x * channels + c] =
            (channels === 2 && c === 1) || (channels === 4 && c === 3) ? 255 : ink ? 160 : 0
      }
      return row
    }),
  }
}
test('text coverage tolerates antialiasing across PNG color formats and ignores blank gaps', () => {
  for (const channels of [1, 2, 3, 4])
    expect(inspectPaint(image(channels), regions).every((r) => !r.failed)).toBe(true)
})
test('painted-over header, middle and closing report the failed coordinates', () => {
  for (let i = 0; i < 3; i++) {
    const failed = inspectPaint(image(3, i), regions).filter((r) => r.failed)
    expect(failed.map((r) => [r.label, r.y, r.coverage])).toEqual([[regions[i]!.label, i * 30, 0]])
  }
})
test('iframe x clipping and segment offsets check intersecting text, excluding leading slivers', () => {
  const shot = image(4)
  shot.rows = shot.rows.slice(30, 60)
  shot.height = 30
  expect(inspectPaint(shot, regions, 30).map((r) => r.label)).toEqual(['middle label'])
  expect(inspectPaint(shot, [{ ...regions[0]!, x: -6, y: 25 }], 30)[0]?.failed).toBe(false)
  expect(inspectPaint(shot, [{ ...regions[0]!, y: 15 }], 30)).toEqual([])
})

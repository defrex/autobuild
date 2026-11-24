import type { DecodedPng } from './website-capture-png'

export interface PaintRegion {
  label: string
  x: number
  y: number
  width: number
  height: number
  foreground: number[]
  background: number[]
}

/** Text rectangles only: designed empty space contributes no samples. */
export function inspectPaint(image: DecodedPng, regions: PaintRegion[], top = 0) {
  return regions.flatMap((region) => {
    const left = Math.max(0, Math.floor(region.x))
    const right = Math.min(image.width, Math.ceil(region.x + region.width))
    const start = Math.max(0, Math.floor(region.y - top))
    const end = Math.min(image.height, Math.ceil(region.y + region.height - top))
    // A tiny clipped sliver may contain only font leading, with no actual glyph.
    if (right <= left || end - start < Math.min(8, region.height * 0.7)) return []
    const contrast = Math.hypot(...region.foreground.map((v, i) => v - region.background[i]!))
    if (contrast < 40) return []
    let foreground = 0
    const area = (right - left) * (end - start)
    for (let y = start; y < end; y++) {
      const row = image.rows[y]!
      for (let x = left; x < right; x++) {
        const offset = x * image.channels
        const gray = image.colorType === 0 || image.colorType === 4
        const alpha =
          image.colorType === 4
            ? row[offset + 1]! / 255
            : image.colorType === 6
              ? row[offset + 3]! / 255
              : 1
        const rgb = [0, 1, 2].map(
          (c) => row[offset + (gray ? 0 : c)]! * alpha + region.background[c]! * (1 - alpha),
        )
        const distance = Math.hypot(...rgb.map((v, i) => v - region.background[i]!))
        const toInk = Math.hypot(...rgb.map((v, i) => v - region.foreground[i]!))
        if (distance >= contrast * 0.25 && toInk < contrast * 0.8) foreground++
      }
    }
    // Far below ordinary glyph coverage (~10–40%); tolerates fallback and antialiasing.
    return [
      {
        ...region,
        top,
        area,
        foregroundPixels: foreground,
        coverage: foreground / area,
        failed: foreground / area < 0.005,
      },
    ]
  })
}

export class CaptureError extends Error {
  readonly classification = 'capture-error'
}

import { describe, expect, test } from 'bun:test'
import { renderDashboardFrameImage } from './frame-image'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function pngDimension(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

describe('renderDashboardFrameImage', () => {
  test('ANSI SGR and OSC hyperlinks cost no cells and produce plain text from the same parse', () => {
    const frame = renderDashboardFrameImage(
      ['\x1b[31mRED\x1b[0m ' + '\x1b]8;;https://example.invalid/pr/1\x07link\x1b]8;;\x07'],
      { columns: 8 },
    )

    expect(frame.text).toBe('RED link\n')
    expect(frame.columns).toBe(8)
    expect(frame.rows).toBe(1)
    expect(frame.svg).toContain('fill="#ff7b72"')
    expect(frame.svg).toContain('href="https://example.invalid/pr/1"')
    expect(frame.svg).not.toContain('\x1b')
  })

  test('renders deterministic PNG bytes with pinned dimensions and fonts', () => {
    const lines = [
      '\x1b[1mAuto Build\x1b[0m  \x1b[32mintake ON\x1b[0m',
      '\x1b[2m[ ] verify:dashboard\x1b[0m',
    ]
    const first = renderDashboardFrameImage(lines, { columns: 40 })
    const second = renderDashboardFrameImage(lines, { columns: 40 })

    expect([...first.png.slice(0, 8)]).toEqual(PNG_SIGNATURE)
    expect(first.png).toEqual(second.png)
    expect(first.width).toBe(424)
    expect(first.height).toBe(60)
    // PNG IHDR stores width/height at byte offsets 16 and 20.
    expect(pngDimension(first.png, 16)).toBe(first.width)
    expect(pngDimension(first.png, 20)).toBe(first.height)
    expect(first.svg).toContain('font-family="DejaVu Sans Mono"')
    expect(first.svg).toContain('font-weight="700"')
    expect(first.svg).toContain('fill-opacity="0.58"')
  })

  test('rejects overflow, unsupported controls, and unknown terminal sequences clearly', () => {
    expect(() => renderDashboardFrameImage(['too wide'], { columns: 3 })).toThrow(
      'exceeding declared terminal width 3',
    )
    expect(() => renderDashboardFrameImage(['tab\there'], { columns: 20 })).toThrow(
      'unsupported control U+0009',
    )
    expect(() => renderDashboardFrameImage(['\x1b[35mmagenta\x1b[0m'], { columns: 20 })).toThrow(
      'unsupported SGR code 35',
    )
    expect(() =>
      renderDashboardFrameImage(['\x1b]8;;https://example.invalid\x07open'], {
        columns: 20,
      }),
    ).toThrow('hyperlink was not closed')
    expect(() => renderDashboardFrameImage(['\x1b[31mleaked'], { columns: 20 })).toThrow(
      'SGR style was not reset',
    )
  })

  test('rejects empty frames and invalid terminal dimensions', () => {
    expect(() => renderDashboardFrameImage([], { columns: 80 })).toThrow('dashboard frame is empty')
    expect(() => renderDashboardFrameImage(['x'], { columns: 0 })).toThrow(
      'columns must be a positive integer',
    )
  })
})

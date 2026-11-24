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

  test('places printable Unicode by terminal cells and renders stable bytes', () => {
    const lines = ['naïve — 日本語 ☕️ 🇺🇸 👨‍👩‍👧‍👦', 'e\u0301x\u200by']
    const first = renderDashboardFrameImage(lines, { columns: 40 })
    const second = renderDashboardFrameImage(lines, { columns: 40 })

    expect(first.text).toBe(`${lines.join('\n')}\n`)
    expect(first.png).toEqual(second.png)
    expect(first.svg).toContain('Dashboard CJK 113, Dashboard CJK 117, Dashboard CJK 118')
    expect(first.svg).toContain('Dashboard Emoji Flags, Dashboard Emoji Food')
    expect(first.svg).toContain('Dashboard Emoji People')
    expect(first.svg).toMatch(/<text x="12"[^>]*textLength="20"[^>]*>na<\/text>/)
    expect(first.svg).toMatch(/<text x="92"[^>]*>日<\/text>/)
    expect(first.svg).toMatch(/<text x="112"[^>]*>本<\/text>/)
    expect(first.svg).toMatch(/<text x="132"[^>]*>語<\/text>/)
    expect(first.svg).toMatch(
      /<text x="162"[^>]*textLength="20"[^>]*font-size="18"[^>]*>☕️<\/text>/,
    )
    expect(first.svg).toMatch(/<text x="192"[^>]*font-size="18"[^>]*>🇺🇸<\/text>/)
    expect(first.svg).toMatch(/<text x="222"[^>]*font-size="18"[^>]*>👨‍👩‍👧‍👦<\/text>/)
  })

  test('renders deterministic PNG bytes with pinned dimensions and fonts', () => {
    const lines = [
      '\x1b[1mAutobuild\x1b[0m  \x1b[32mintake ON\x1b[0m',
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
    expect(first.svg).toContain(
      'font-family="DejaVu Sans Mono, Dashboard CJK 113, Dashboard CJK 117, Dashboard CJK 118, Dashboard Emoji Flags, Dashboard Emoji Food, Dashboard Emoji People"',
    )
    expect(first.svg).toContain('font-weight="700"')
    expect(first.svg).toContain('fill-opacity="0.58"')
  })
})

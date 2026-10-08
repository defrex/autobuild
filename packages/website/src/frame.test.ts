import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { WEBSITE_HERO_COLUMNS } from '../../../tools/dashboard-capture'
import { frameHtml, frameLines, frameText, heroFrame } from './frame'
import { COLOR } from './svg'

const TRACKED = join(import.meta.dir, 'hero-frame.txt')

describe('frameHtml', () => {
  test('maps the terminal vocabulary onto design tokens and plain text', () => {
    const html = frameHtml([
      ' \x1b[36m> \x1b[0m\x1b[1mAutobuild\x1b[0m  \x1b[2mqueue 0\x1b[0m',
      '   \x1b[34mAUT-1\x1b[0m  \x1b[33mPAUSED\x1b[0m \x1b[31mBLOCKED\x1b[0m',
      '   \x1b[32m[x] plan\x1b[0m \x1b[1m\x1b[36m[>] implement\x1b[0m\x1b[0m <&>',
    ])
    expect(html.split('\n')).toEqual([
      ` <span style="color: ${COLOR.live}">&gt; </span><b>Autobuild</b>  <span style="color: ${COLOR.slack}">queue 0</span>`,
      `   AUT-1  <span style="color: ${COLOR.title}">PAUSED</span> <span style="color: ${COLOR.alert}">BLOCKED</span>`,
      `   <span style="color: ${COLOR.ok}">[x] plan</span> <b style="color: ${COLOR.live}">[&gt;] implement</b> &lt;&amp;&gt;`,
    ])
  })

  test('a hyperlink keeps its text and drops the fixture URL', () => {
    const html = frameHtml([
      '\x1b]8;;https://github.com/defrex/autobuild/pull/41\x07PR merged\x1b]8;;\x07',
    ])
    expect(html).toBe('PR merged')
  })

  test('refuses escapes outside the dashboard vocabulary and lines wider than the frame', () => {
    expect(() => frameHtml(['\x1b[35mmagenta\x1b[0m'])).toThrow('unsupported SGR code 35')
    expect(() => frameHtml(['x'.repeat(WEBSITE_HERO_COLUMNS + 1)])).toThrow(
      'exceeding declared terminal width',
    )
  })
})

describe('the tracked hero frame', () => {
  test('is the colored happy dispatch frame, whole at the hero width', async () => {
    const lines = frameLines(await Bun.file(TRACKED).text())
    const plain = frameText(lines)
    expect(lines.some((line) => line.includes('\x1b['))).toBe(true)
    expect(Math.max(...plain.map((line) => line.length))).toBeLessThanOrEqual(WEBSITE_HERO_COLUMNS)
    expect(plain.some((line) => line.endsWith('~'))).toBe(false)
    const text = plain.join('\n')
    for (const evidence of [
      'Autobuild',
      'intake ON',
      'auto merge ON',
      'harvest ON',
      'Harvest',
      'PR merged',
      'RUNNING',
      '[>] ',
      '[x] ',
      '[ ] ',
      'Keys:',
    ]) {
      expect(text).toContain(evidence)
    }
    expect(text.match(/AUT-\d+/g)).toHaveLength(5)
    expect(text).not.toMatch(/\b(?:BLOCKED|PAUSED|held|error|failed|failure|capture|fixture)\b/i)
  })

  test('renders as one preformatted region with no escape left in the page', async () => {
    const html = heroFrame(await Bun.file(TRACKED).text())
    expect(html).toStartWith('<div class="scroll" tabindex="0" role="region" aria-label="')
    expect(html).toContain('<pre class="frame">')
    expect(html).not.toContain('\x1b')
    expect(html).toContain(`<span style="color: ${COLOR.ok}">RUNNING</span>`)
    expect(html).toContain(`<b style="color: ${COLOR.live}">[&gt;] implement(9m17s)</b>`)
    expect(html).not.toContain('href=')
  })
})

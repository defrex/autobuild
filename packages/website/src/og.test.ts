import { describe, expect, test } from 'bun:test'
import { heroFrameText } from './build'
import { HEADLINE } from './constants'
import { OG_HEIGHT, OG_WIDTH, renderOgCard } from './og'

describe('renderOgCard', () => {
  test('is a self-contained card page drawing the wordmark, headline, and the real frame', async () => {
    const html = renderOgCard(await heroFrameText())
    expect(html).toStartWith('<!doctype html>')
    expect(html).toContain('<link rel="stylesheet" href="site.css">')
    expect(html).toContain(`width: ${OG_WIDTH}px; height: ${OG_HEIGHT}px`)
    expect(html).toContain('<b class="title">Autobuild</b>')
    expect(html).toContain(`<h1 class="display">${HEADLINE.replace(', ', ',<br>')}</h1>`)
    expect(html).toContain('<pre class="frame">')
    expect(html).toContain('AUT-131')
    expect(html).not.toContain('\x1b')
  })
})

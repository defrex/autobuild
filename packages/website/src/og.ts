import { HEADLINE, REPO_URL } from './constants'
import { frameHtml, frameLines } from './frame'

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630
export const OG_IMAGE_ALT = `Autobuild: ${HEADLINE} Above the ab dispatch dashboard showing builds moving through the pipeline.`

/**
 * The link-preview card: the wordmark, the display line, and the top of the
 * real dispatch frame running off the bottom and right edges. It is a page of its own,
 * drawn in the site's stylesheet and webfont, which `bun run
 * capture:website-og` screenshots into the tracked `og.png`.
 */
export function renderOgCard(heroFrame: string): string {
  const frame = frameHtml(frameLines(heroFrame))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Autobuild preview card</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&amp;display=swap">
<link rel="stylesheet" href="site.css">
<style>
html, body { width: ${OG_WIDTH}px; height: ${OG_HEIGHT}px; overflow: hidden; }
/* The frame is wider than the card's text column, so its well runs off the
 * right edge the way it runs off the bottom: every cell stays visible, only
 * the well's trailing padding is cut. */
.card { box-sizing: border-box; width: ${OG_WIDTH}px; height: ${OG_HEIGHT}px; padding: 56px 0 0 56px; display: flex; flex-direction: column; align-items: flex-start; gap: 40px; }
.card .masthead { box-sizing: border-box; width: 100%; padding: 0 56px 0 0; }
.card .frame { min-width: 0; width: max-content; }
</style>
</head>
<body>
<div class="card"><div class="masthead"><b class="title">Autobuild</b><span class="dim">${REPO_URL.replace('https://', '')}</span></div><h1 class="display">${HEADLINE.replace(', ', ',<br>')}</h1><pre class="frame">${frame}</pre></div>
</body>
</html>
`
}

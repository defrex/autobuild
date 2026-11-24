import { FRAME_META, REPOSITORY_META, type WebAssetManifest } from './protocol'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/** The repository as a reader names it: its identity without a URL scheme. */
export function repositoryLabel(repo: string): string {
  return repo.replace(/^https?:\/\//u, '')
}

/**
 * The one HTML page. Every script and stylesheet is a same-origin file, so
 * the page runs under `default-src 'self'` with no inline code; the nonce
 * only lets UI SDK inject its own stylesheet at runtime. `frame`, the hub's
 * serialized frame, rides in a meta tag as the skeleton's layout hint; it is
 * attribute text, never executable.
 */
export function renderPage(opts: {
  nonce: string
  repositoryLabel: string
  manifest: WebAssetManifest
  frame?: string
}): string {
  const label = escapeHtml(opts.repositoryLabel)
  const asset = (path: string) => `/assets/${escapeHtml(path)}`
  const preloads = opts.manifest.fonts
    .map(
      (font) =>
        `<link rel="preload" href="${asset(font)}" as="font" type="font/woff2" crossorigin>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="csp-nonce" nonce="${escapeHtml(opts.nonce)}">
<meta name="${REPOSITORY_META}" content="${label}">
${opts.frame !== undefined ? `<meta name="${FRAME_META}" content="${escapeHtml(opts.frame)}">\n` : ''}<title>Autobuild · ${label}</title>
${preloads}
<link rel="stylesheet" href="${asset(opts.manifest.stylesheet)}">
<script src="${asset(opts.manifest.themeScript)}"></script>
</head>
<body><div id="root"></div><script src="${asset(opts.manifest.script)}"></script></body>
</html>
`
}

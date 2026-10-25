export const routes = {
  '/': 'html',
  '/builds/:slug': 'detail-html',
  '/refresh': 'endpoint',
  '/frame': 'endpoint',
  '/index.md': 'representation',
  '/health': 'endpoint',
  '/readyz': 'endpoint',
  '/static': 'static',
  '/sign-in': 'public-html',
  '/auth/github': 'auth',
  '/auth/github/callback': 'auth',
  '/auth/sign-out': 'auth',
  '/auth/dev-session': 'development-issuer',
} as const
export const frames = [1440, 390].flatMap((width) =>
  ['light', 'dark'].flatMap((theme) =>
    ['closed', 'open', 'mixed', 'detail', 'sign-in', 'refused'].map((state) => ({
      id: `builds-${width}-${theme}-${state}`,
      route:
        state === 'sign-in'
          ? '/sign-in'
          : state === 'refused'
            ? '/auth/dev-session'
            : state === 'detail'
              ? '/builds/:slug'
              : '/',
      width,
      theme,
      state,
    })),
  ),
)
export function checkRoutes(source: string) {
  const discovered = [
    ...source.matchAll(/(?:Route::endpoint|\.route|\.nest_service)\(\s*"([^"]+)"/g),
  ]
    .map((m) => m[1]!)
    .sort()
  const calls = source.match(/(?:Route::endpoint|\.route|\.nest_service)\(/g) || []
  if (
    calls.length !== discovered.length ||
    JSON.stringify(discovered) !== JSON.stringify(Object.keys(routes).sort())
  )
    throw Error('Unclassified route: extend route classification and capture cases')
  checkFrameMatrix(frames)
}
export function checkFrameMatrix(cases: typeof frames) {
  if (new Set(cases.map((f) => f.id)).size !== cases.length) throw Error('Duplicate frame id')
  for (const [route, kind] of Object.entries(routes)) {
    if (
      kind !== 'detail-html' &&
      kind !== 'html' &&
      kind !== 'public-html' &&
      kind !== 'development-issuer'
    )
      continue
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark'])
        for (const state of kind === 'detail-html'
          ? ['detail']
          : kind === 'html'
            ? ['closed', 'open']
            : kind === 'public-html'
              ? ['sign-in']
              : ['refused']) {
          if (
            cases.filter(
              (f) =>
                f.route === route && f.width === width && f.theme === theme && f.state === state,
            ).length !== 1
          )
            throw Error(`Incomplete frame matrix: ${route} ${width} ${theme} ${state}`)
        }
  }
}

export function palette(reference: string, theme: string): string[] {
  const selector =
    theme === 'light' ? ':root, :root[data-theme="light"]' : ':root[data-theme="dark"]'
  const block = reference.slice(reference.indexOf(selector)).split('}')[0]!
  const colors = [...block.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]!)
  if (colors.length !== 12) throw Error('Reference palette changed; inspect token extraction')
  return colors
}
// Executed inside Chromium, independently of the application stylesheet.
export function probe(colors: string[], state: string, theme: string) {
  const failures: string[] = []
  const canvas = document.createElement('canvas').getContext('2d')!
  const normalize = (s: string) => {
    canvas.fillStyle = '#010203'
    canvas.fillStyle = s
    return canvas.fillStyle
  }
  const allowed = colors.map(normalize)
  const text = document.body.innerText
  const publicPage = state === 'sign-in' || state === 'refused'
  for (const content of [
    'Autobuild',
    ...(publicPage
      ? ['Sign in', 'Continue with GitHub']
      : [
          'Builds',
          'operator@example.com',
          ...(state === 'open' ? ['Sign out', 'System', 'Light', 'Dark'] : []),
        ]),
    ...(state === 'refused' ? ["You're not in an organization yet.", 'refused@example.com'] : []),
  ])
    if (!text.includes(content)) failures.push(`Missing content: ${content}`)
  if (
    document.querySelector('h1')?.textContent !==
    (publicPage ? 'Sign in' : state === 'detail' ? 'detail-case' : 'Builds')
  )
    failures.push(publicPage ? 'Missing Sign in heading' : 'Missing Builds heading')
  if (publicPage && document.querySelector('#account-trigger')) failures.push('Public account menu')
  if (state === 'refused' && !document.querySelector('[role="alert"]'))
    failures.push('Missing refusal alert')
  if (document.documentElement.dataset.theme !== theme) failures.push('Wrong theme')
  if (
    !publicPage &&
    document.querySelector('#account-trigger')?.getAttribute('aria-expanded') !==
      String(state === 'open')
  )
    failures.push('Wrong menu state')
  if (document.documentElement.scrollWidth > innerWidth) failures.push('Document overflow')
  const textNodes: Element[] = []
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none')
      continue
    if (innerWidth === 390 && (rect.left < -0.5 || rect.right > innerWidth + 0.5))
      failures.push(`Overflow: ${el.tagName}`)
    const paintsText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())
    if (paintsText) textNodes.push(el)
    for (const pseudo of [null, '::before', '::after']) {
      const s = pseudo ? getComputedStyle(el, pseudo) : style
      if (pseudo && ['none', 'normal'].includes(s.content)) continue
      if (s.opacity !== '1' || s.mixBlendMode !== 'normal')
        failures.push('Unexpected opacity/blend')
      if (
        s.backgroundImage !== 'none' ||
        s.boxShadow !== 'none' ||
        s.textShadow !== 'none' ||
        s.filter !== 'none'
      )
        failures.push('Unexpected image/shadow/filter')
      for (const property of [
        'color',
        'background-color',
        'border-top-color',
        'border-right-color',
        'border-bottom-color',
        'border-left-color',
        'outline-color',
        'text-decoration-color',
        'fill',
        'stroke',
      ]) {
        if (
          (property === 'color' || property === 'text-decoration-color') &&
          !paintsText &&
          !pseudo
        )
          continue
        if (property === 'text-decoration-color' && s.textDecorationLine === 'none') continue
        if (
          property.startsWith('border-') &&
          s.getPropertyValue(property.replace('color', 'width')) === '0px'
        )
          continue
        if (
          property.startsWith('border-') &&
          s.getPropertyValue(property.replace('color', 'style')) === 'none'
        )
          continue
        if (property === 'outline-color' && s.outlineStyle === 'none') continue
        if (['fill', 'stroke'].includes(property) && !(el instanceof SVGElement)) continue
        const value = s.getPropertyValue(property)
        if (value === 'none' || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') continue
        if (value && !allowed.includes(normalize(value)))
          failures.push(`Forbidden ${property}: ${value}`)
      }
      if (
        (paintsText || pseudo) &&
        !s.fontFamily.includes('Atkinson Hyperlegible Next') &&
        !s.fontFamily.includes('JetBrains Mono')
      )
        failures.push(`Forbidden font: ${s.fontFamily}`)
    }
  }
  for (const face of ['Atkinson Hyperlegible Next', 'JetBrains Mono'])
    if (!document.fonts.check(`16px "${face}"`)) failures.push(`Unloaded face: ${face}`)
  return {
    failures: [...new Set(failures)],
    textElements: textNodes.length,
    height: Math.max(900, document.documentElement.scrollHeight),
  }
}

// User-authored multilingual/emoji content needs platform glyphs outside the two
// interface faces. This never permits a fallback for interface labels or spacing.
export function dataFontFallback(family: string, text: string, storeText: boolean): boolean {
  if (!storeText) return false
  if (family === 'Noto Sans CJK JP')
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
  if (family === 'Noto Color Emoji')
    return /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text)
  return false
}

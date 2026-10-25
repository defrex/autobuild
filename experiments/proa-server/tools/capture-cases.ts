export const routes = {
  '/': 'html',
  '/connect': 'connect-html',
  '/connect/decide': 'browser-connect',
  '/dashboard/builds/:slug': 'detail-html',
  '/refresh': 'endpoint',
  '/controls': 'browser-control',
  '/frame': 'endpoint',
  '/index.md': 'representation',
  '/health': 'machine-health',
  '/readyz': 'endpoint',
  '/static': 'static',
  '/sign-in': 'public-html',
  '/auth/github': 'auth',
  '/auth/github/callback': 'auth',
  '/auth/sign-out': 'auth',
  '/auth/dev-session': 'development-issuer',
} as const
// Entire machine namespaces bypass browser rendering and cookie/origin middleware.
// They have protocol integration evidence rather than screenshot frames.
export const machineNamespaces = {
  builds: 'machine-store',
  repos: 'machine-store',
  sessions: 'machine-store',
  streams: 'machine-store',
  credentials: 'machine-credential',
  tickets: 'machine-ticket',
} as const
export function checkMachineNamespaces(source: string) {
  const definitions = [
    ...source.matchAll(
      /pub\s+const\s+MACHINE_NAMESPACES\s*:\s*&\s*\[\s*&str\s*\]\s*=\s*&\[([\s\S]*?)\]\s*;/g,
    ),
  ]
  if (definitions.length !== 1) throw Error('Unclassified machine namespace declaration')
  const declaration = definitions[0]![1]!
  const discovered = [...declaration.matchAll(/"([^"\\]+)"/g)].map((m) => m[1]!).sort()
  if (
    declaration.replace(/"[^"\\]+"/g, '').replace(/[\s,]/g, '') !== '' ||
    JSON.stringify(discovered) !== JSON.stringify(Object.keys(machineNamespaces).sort())
  )
    throw Error('Unclassified machine namespace: extend protocol classification and evidence')
}
export const databaseProbeEndpoints = {
  'src/endpoints/health.rs': 'ready',
} as const
export function checkCaptureCapabilities(driver: string, sources: Record<string, string>) {
  if (driver !== 'none')
    throw Error('Unsupported database capability; add a seed adapter; see tools/README.md')
  for (const [path, original] of Object.entries(sources)) {
    let source = original
    if (path in databaseProbeEndpoints) {
      const signature = /pub\s+async\s+fn\s+ready\s*\(/.exec(source)
      if (!signature) throw Error('Unsupported readiness endpoint; inspect capability inventory')
      const open = source.indexOf('{', signature.index)
      let depth = 1,
        end = open + 1
      for (; end < source.length && depth > 0; end++) {
        if (source[end] === '{') depth++
        if (source[end] === '}') depth--
      }
      if (depth !== 0) throw Error('Unsupported readiness endpoint; inspect capability inventory')
      const ready = source.slice(open, end)
      if (
        (ready.match(/state\.data/g) || []).length !== 1 ||
        (ready.match(/reader\.postgres\(\)\.preflight\(\)/g) || []).length !== 1 ||
        /sqlx|DATABASE_URL|\.(?:query|execute|connect)\(/i.test(ready)
      )
        throw Error('Unsupported readiness database capability; inspect endpoint preflight')
      source = source.slice(0, signature.index) + source.slice(end)
    }
    // These live surfaces are backed by the isolated withCaptureSeed adapter.
    if (
      [
        'src/pages/home.rs',
        'src/pages/build.rs',
        'src/endpoints/live.rs',
        'src/endpoints/controls.rs',
        'src/pages/connect.rs',
        'src/endpoints/connect.rs',
      ].includes(path)
    )
      continue
    if (/sqlx|postgres|DATABASE_URL|state\.data/i.test(source))
      throw Error(
        `Unsupported database capability in ${path}; add a seed adapter; see tools/README.md`,
      )
  }
}
export const frames = [1440, 390].flatMap((width) =>
  ['light', 'dark'].flatMap((theme) =>
    [
      'closed',
      'open',
      'mixed',
      'detail',
      'sign-in',
      'refused',
      'control-answer',
      'control-pausing',
      'control-confirmation',
      'control-refusal',
    ].map((state) => ({
      id: `builds-${width}-${theme}-${state}`,
      route:
        state === 'sign-in'
          ? '/sign-in'
          : state === 'refused'
            ? '/auth/dev-session'
            : state === 'detail' || state.startsWith('control-')
              ? '/dashboard/builds/:slug'
              : '/',
      width,
      theme,
      state,
    })),
  ),
)
for (const width of [1440, 390])
  for (const theme of ['light', 'dark'])
    for (const state of ['entry', 'pending', 'approved', 'denied', 'expired', 'unknown', 'error'])
      frames.push({
        id: `connect-${width}-${theme}-${state}`,
        route: '/connect',
        width,
        theme,
        state: `connect-${state}`,
      })
export function checkRoutes(source: string, machineSource: string) {
  checkMachineNamespaces(machineSource)
  // These two operator routers have their own executable contract gate.
  for (const router of ['http', 'delegation']) {
    const merge = `.merge(proa_server::operator::${router}::router())`
    if (source.split(merge).length !== 2) throw Error('Unclassified operator router')
    source = source.replace(merge, '')
  }
  if (
    /\.(?:nest|route_service|merge)\(/.test(source) ||
    /Route::(?!endpoint\()[A-Za-z_]+\(/.test(source)
  )
    throw Error('Unclassified route composition: extend route classification and capture cases')
  if (
    (source.match(/\.fallback_service\(/g) || []).length !== 1 ||
    /\.fallback\(/.test(source) ||
    !source.includes('protocol::router::is_machine_path(request.uri().path())') ||
    !source.includes('proa_server::connection::http::is_public_path(request.uri().path())')
  )
    throw Error('Unclassified fallback route: preserve explicit machine/browser dispatch')
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
      kind !== 'connect-html' &&
      kind !== 'detail-html' &&
      kind !== 'html' &&
      kind !== 'public-html' &&
      kind !== 'development-issuer'
    )
      continue
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark'])
        for (const state of kind === 'connect-html'
          ? ['entry', 'pending', 'approved', 'denied', 'expired', 'unknown', 'error'].map(
              (s) => `connect-${s}`,
            )
          : kind === 'detail-html'
            ? [
                'detail',
                'control-answer',
                'control-pausing',
                'control-confirmation',
                'control-refusal',
              ]
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
  const connectPage = state.startsWith('connect-')
  for (const content of [
    'Autobuild',
    ...(publicPage
      ? ['Sign in', 'Continue with GitHub']
      : [
          ...(connectPage ? ['Connect a project'] : ['Builds']),
          'operator@example.com',
          ...(state === 'open' ? ['Sign out', 'System', 'Light', 'Dark'] : []),
        ]),
    ...(state === 'refused' ? ["You're not in an organization yet.", 'refused@example.com'] : []),
  ])
    if (!text.includes(content)) failures.push(`Missing content: ${content}`)
  if (
    document.querySelector('h1')?.textContent !==
    (publicPage
      ? 'Sign in'
      : connectPage
        ? 'Connect a project'
        : state === 'detail'
          ? 'detail-case'
          : state.startsWith('control-')
            ? document.querySelector('[data-page=build-detail] h1')?.textContent
            : 'Builds')
  )
    failures.push(publicPage ? 'Missing Sign in heading' : 'Missing Builds heading')
  if (
    connectPage &&
    !document.querySelector(
      `[data-connect-${['unknown', 'error'].includes(state.slice(8)) ? 'error' : state.slice(8)}]`,
    )
  )
    failures.push('Missing connection state')
  if (state.startsWith('control-')) {
    for (const word of state === 'control-answer'
      ? ['Guidance', 'Send guidance', 'Retry', 'Dismiss finding']
      : state === 'control-pausing'
        ? ['PAUSING', 'Cancel pause']
        : state === 'control-confirmation'
          ? ['Confirm abort', 'Cancel']
          : ['has no open escalations to answer'])
      if (!text.includes(word)) failures.push(`Missing control content: ${word}`)
    if (document.querySelector('button[value="land"],button[value="hold"]'))
      failures.push('Browser landing control')
  }
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

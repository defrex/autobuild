;(() => {
  const initial = document.querySelector('[data-live]')
  if (!initial) return
  let version = ''
  let stopped = false
  let controller
  const target = new URL('/refresh', location.origin)
  target.search = location.search
  if (initial.dataset.live === 'detail')
    target.searchParams.set('slug', decodeURIComponent(location.pathname.split('/').pop()))
  addEventListener(
    'pagehide',
    () => {
      stopped = true
      controller?.abort()
    },
    { once: true },
  )
  const duration = (milliseconds) => {
    const s = Math.max(0, Math.floor(milliseconds / 1000))
    if (s < 60) return `${s}s`
    const pad = (n) => String(n).padStart(2, '0')
    if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
    return `${Math.floor(s / 3600)}h${pad(Math.floor(s / 60) % 60)}m${pad(s % 60)}s`
  }
  const timers = setInterval(() => {
    if (stopped) return clearInterval(timers)
    for (const timer of document.querySelectorAll('[data-elapsed]')) {
      if (timer.dataset.since)
        timer.textContent = duration(
          Number(timer.dataset.elapsed) + Date.now() - Number(timer.dataset.since),
        )
    }
  }, 1000)
  async function poll() {
    if (stopped) return
    controller = new AbortController()
    try {
      const response = await fetch(target, {
        signal: controller.signal,
        cache: 'no-store',
        headers: version ? { 'If-None-Match': version } : {},
      })
      if (response.status === 304) {
        document.querySelector('[data-live-status]').textContent = ''
        return
      }
      if (!response.ok || response.redirected)
        throw Error('Live updates unavailable. Reload to reconnect.')
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html')
      const next = parsed.querySelector('[data-live]')
      const current = document.querySelector('[data-live]')
      if (!next || !current) throw Error('Live updates unavailable. Reload to reconnect.')
      const open = new Set(
        [...current.querySelectorAll('details[open][data-session]')].map((n) => n.dataset.session),
      )
      for (const node of next.querySelectorAll('details[data-session]'))
        node.open = open.has(node.dataset.session)
      const active = document.activeElement
      if (current.contains(active) && active.matches('input,select,textarea')) return
      const focused = active.closest('[data-session]')?.dataset.session
      const focusHref = active.tagName === 'A' ? active.getAttribute('href') : undefined
      const scroll = scrollY
      current.replaceWith(next)
      if (focused)
        [...next.querySelectorAll('[data-session]')]
          .find((n) => n.dataset.session === focused)
          ?.querySelector('summary')
          ?.focus({ preventScroll: true })
      if (!focused && focusHref)
        [...next.querySelectorAll('a[href]')]
          .find((node) => node.getAttribute('href') === focusHref)
          ?.focus({ preventScroll: true })
      scrollTo(scrollX, scroll)
      version = response.headers.get('etag') || ''
    } catch (error) {
      if (!stopped) document.querySelector('[data-live-status]').textContent = error.message
    } finally {
      if (!stopped) setTimeout(poll, 2000)
    }
  }
  setTimeout(poll, 2000)
})()

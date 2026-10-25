;(() => {
  const initial = document.querySelector('[data-live]')
  if (!initial) return
  let version = ''
  let stopped = false
  let controller
  let generation = 0
  let pending = false
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
  function install(next, preserveControls) {
    const current = document.querySelector('[data-live]')
    if (!current || !next) throw Error('Live updates unavailable. Reload to reconnect.')
    const active = document.activeElement
    const id = active?.id
    const href = active?.tagName === 'A' ? active.getAttribute('href') : undefined
    const session = active?.closest('[data-session]')?.dataset.session
    const action = active?.matches('button[name="action"]') ? active.value : undefined
    const selection = active?.matches('input,textarea')
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection]
      : undefined
    const scroll = scrollY
    const open = new Set(
      [...current.querySelectorAll('details[open][data-session]')].map((n) => n.dataset.session),
    )
    for (const node of next.querySelectorAll('details[data-session]'))
      node.open = open.has(node.dataset.session)
    if (preserveControls) {
      for (const old of current.querySelectorAll(
        '[data-build-controls], [data-repository-controls]',
      )) {
        if (
          old.querySelector(
            '[data-dirty], [data-control-error], [data-control-notice], [data-control-form="confirmation"]',
          )
        ) {
          const replacement = next.querySelector(
            old.matches('[data-build-controls]')
              ? '[data-build-controls]'
              : '[data-repository-controls]',
          )
          replacement?.replaceWith(old)
        }
      }
    }
    current.replaceWith(next)
    const focus = id
      ? document.getElementById(id)
      : session
        ? [...next.querySelectorAll('[data-session]')]
            .find((n) => n.dataset.session === session)
            ?.querySelector('summary')
        : href
          ? [...next.querySelectorAll('a[href]')].find((n) => n.getAttribute('href') === href)
          : action
            ? [...next.querySelectorAll('button[name="action"]')].find((n) => n.value === action)
            : undefined
    focus?.focus({ preventScroll: true })
    if (selection && typeof selection[0] === 'number' && focus?.setSelectionRange)
      focus.setSelectionRange(...selection)
    scrollTo(scrollX, scroll)
  }
  function parsePage(text) {
    return new DOMParser().parseFromString(text, 'text/html').querySelector('[data-live]')
  }
  document.addEventListener('input', (event) => {
    const form = event.target.closest('[data-control-form]')
    if (form) form.dataset.dirty = 'true'
  })
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-control-form]')
    if (!form) return
    event.preventDefault()
    if (pending || stopped) return
    pending = true
    generation += 1
    controller?.abort()
    // Capture the submitter before disabling controls; FormData omits disabled fields.
    const data = new FormData(form)
    if (event.submitter?.name) data.set(event.submitter.name, event.submitter.value)
    const buttons = [...form.querySelectorAll('button')]
    form.setAttribute('aria-busy', 'true')
    for (const button of buttons) button.disabled = true
    try {
      const response = await fetch(form.getAttribute('action'), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'X-Proa-Fragment': '1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data),
      })
      if (response.redirected) throw Error('Your session changed. Reload to sign in again.')
      const next = parsePage(await response.text())
      if (!next)
        throw Error(
          'Control response unavailable. Reload to check the recorded state before retrying.',
        )
      install(next, false)
      version = ''
      const error = document.querySelector('[data-control-error]')
      const confirmation = document.querySelector('[data-control-form="confirmation"] button')
      if (confirmation) confirmation.focus({ preventScroll: true })
      else if (error) document.getElementById('answer-text')?.focus({ preventScroll: true })
    } catch (error) {
      const status = document.querySelector('[data-live-status]')
      if (status) status.textContent = error.message
    } finally {
      pending = false
      form.removeAttribute('aria-busy')
      for (const button of buttons) button.disabled = false
    }
  })
  async function poll() {
    if (stopped) return
    if (pending) {
      setTimeout(poll, 2000)
      return
    }
    const observedGeneration = generation
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
      const next = parsePage(await response.text())
      if (pending || observedGeneration !== generation) return
      install(next, true)
      version = response.headers.get('etag') || ''
    } catch (error) {
      if (!stopped && error.name !== 'AbortError')
        document.querySelector('[data-live-status]').textContent = error.message
    } finally {
      if (!stopped) setTimeout(poll, 2000)
    }
  }
  setTimeout(poll, 2000)
})()

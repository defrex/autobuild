;(() => {
  const trigger = document.querySelector('#account-trigger')
  const panel = document.querySelector('#account-panel')
  if (!trigger || !panel) return
  const choices = panel.querySelectorAll('[data-choice]')
  const sync = () => {
    const theme = document.documentElement.dataset.theme || 'system'
    for (const choice of choices)
      choice.setAttribute('aria-pressed', String(choice.dataset.choice === theme))
  }
  const close = (focus) => {
    panel.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (focus) trigger.focus()
  }
  trigger.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    trigger.setAttribute('aria-expanded', String(!panel.hidden))
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close(true)
  })
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target))
      close(false)
  })
  document.addEventListener('focusin', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== trigger) close(false)
  })
  for (const choice of choices)
    choice.addEventListener('click', () => {
      const theme = choice.dataset.choice
      if (theme === 'system') delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = theme
      try {
        if (theme === 'system') localStorage.removeItem('proa-theme')
        else localStorage.setItem('proa-theme', theme)
      } catch {
        /* The current page still honors the choice. */
      }
      sync()
      close(true)
    })
  panel.querySelector('a').addEventListener('click', () => close(true))
  sync()
})()

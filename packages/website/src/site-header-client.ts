/** Enhance ordinary site links into a disclosure only on narrow screens. */
export function bindSiteHeader(): void {
  const header = document.querySelector<HTMLElement>('[data-site-header]')
  const button = header?.querySelector<HTMLButtonElement>('[data-site-menu]')
  if (!header || !button) return
  const mobile = window.matchMedia('(max-width: 719px)')
  const setOpen = (open: boolean): void => {
    button.setAttribute('aria-expanded', String(open))
    button.textContent = open ? 'Close ×' : 'Menu ▾'
    header.classList.toggle('site-menu-open', open)
  }
  header.classList.add('site-enhanced')
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'))
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      setOpen(false)
      button.focus()
    }
  })
  mobile.addEventListener('change', () => setOpen(false))
}

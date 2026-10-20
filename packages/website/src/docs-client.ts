/** Choose the last heading above the reading offset; clamp at either document boundary. */
export function activeSection(tops: readonly number[], offset: number, atEnd = false): number {
  if (!tops.length) return -1
  if (atEnd) return tops.length - 1
  let active = 0
  for (let index = 0; index < tops.length; index++) {
    if (tops[index]! <= offset) active = index
  }
  return active
}

export function bindDocs(): void {
  const root = document.querySelector<HTMLElement>('[data-docs]')
  if (!root) return
  const button = root.querySelector<HTMLButtonElement>('[data-toc-toggle]')
  const list = root.querySelector<HTMLElement>('#docs-sections')
  if (button && list) {
    const setOpen = (open: boolean): void => {
      button.setAttribute('aria-expanded', String(open))
      list.hidden = !open
    }
    setOpen(false)
    button.addEventListener('click', () => setOpen(list.hidden))
    list.addEventListener('click', (event) => {
      if ((event.target as Element).closest('a')) {
        setOpen(false)
        button.focus()
      }
    })
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !list.hidden) {
        setOpen(false)
        button.focus()
      }
    })
  }
  const headings = [...root.querySelectorAll<HTMLElement>('article h2')]
  const update = (): void => {
    const index = activeSection(
      headings.map((heading) => heading.getBoundingClientRect().top),
      24,
      window.scrollY > 0 &&
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
    )
    const id = headings[index]?.id
    for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-section]')) {
      const current = link.dataset.section === id
      if (current) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
      const marker = link.querySelector('.docs-marker')
      if (marker) marker.textContent = current ? '>' : ' '
    }
  }
  let pending = false
  const schedule = (): void => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      update()
    })
  }
  for (const event of ['scroll', 'resize', 'hashchange']) window.addEventListener(event, schedule)
  update()
}

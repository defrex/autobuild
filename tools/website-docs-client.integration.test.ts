import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles } from '../packages/website/src/build'
import { chromiumBinary, parseProbe, runRealtimeChromium, serveSite } from './website-capture'

test('real docs client discloses sections, handles Escape and hash entry, and synchronizes scroll markers', async () => {
  const chromium = chromiumBinary()
  if (!chromium) throw Error('Chromium required for docs interaction evidence')
  const files = await buildFiles()
  const script = `<script>
  addEventListener('load', async () => {
    const errors = []
    const check = (condition, message) => { if (!condition) errors.push(message) }
    const settle = () => new Promise(resolve => setTimeout(resolve, 100))
    await settle()
    const initial = [...document.querySelectorAll('[data-section][aria-current="location"]')]
    check(initial.length === 2 && initial.every(a => a.dataset.section === 'produce-then-review'), 'initial hash entry')
    const button = document.querySelector('[data-toc-toggle]')
    const list = document.querySelector('#docs-sections')
    check(button.getAttribute('aria-expanded') === 'false' && list.hidden, 'initial disclosure')
    button.click()
    check(button.getAttribute('aria-expanded') === 'true' && !list.hidden, 'open disclosure')
    const link = list.querySelector('a')
    link.focus()
    link.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))
    check(list.hidden && document.activeElement === button && button.getAttribute('aria-expanded') === 'false', 'Escape focus return')
    button.click()
    link.click()
    check(list.hidden && button.getAttribute('aria-expanded') === 'false', 'link closes disclosure')
    await settle()
    const headings = [...document.querySelectorAll('article h2')]
    const third = headings[2]
    location.hash = third.id
    await settle()
    const current = () => [...document.querySelectorAll('[data-section][aria-current="location"]')]
    check(current().length === 2 && current().every(a => a.dataset.section === third.id && a.querySelector('.docs-marker').textContent === '>'), 'hash section and markers')
    window.scrollTo(0, document.documentElement.scrollHeight)
    await settle()
    check(current().every(a => a.dataset.section === headings.at(-1).id), 'final section at document end')
    window.scrollTo(0,0)
    await settle()
    check(current().every(a => a.dataset.section === headings[0].id), 'first section before headings')
    const menu = document.querySelector('[data-site-menu]')
    menu.click()
    check(menu.getAttribute('aria-expanded') === 'true', 'shared menu opens')
    menu.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))
    check(menu.getAttribute('aria-expanded') === 'false' && document.activeElement === menu, 'shared menu Escape')
    const meta = document.createElement('meta')
    meta.name = 'capture-probe'
    meta.content = JSON.stringify({error:errors.join('; '),status:'docs interactions complete'})
    document.head.append(meta)
  })
  </script>`
  files['docs/builds/index.html'] = files['docs/builds/index.html']!.replace(
    '</body>',
    `${script}</body>`,
  )
  const site = serveSite(files)
  let profile: string | undefined
  try {
    profile = await mkdtemp(join(tmpdir(), 'docs-client-'))
    const dom = await runRealtimeChromium(
      chromium,
      profile,
      390,
      844,
      { dumpDom: true },
      `${site.url}/docs/builds/#produce-then-review`,
    )
    const result = parseProbe(dom)
    expect(result.status).toBe('docs interactions complete')
    expect(result.error).toBe('')
  } finally {
    site.stop()
    if (profile) await rm(profile, { recursive: true, force: true })
  }
}, 30000)

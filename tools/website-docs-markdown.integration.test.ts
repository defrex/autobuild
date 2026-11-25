import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles } from '../packages/website/src/build'
import { loadDocsPages } from '../packages/website/src/docs-content'
const DOCS_PAGES = await loadDocsPages()
import { SITE_URL } from '../packages/website/src/constants'
import { chromiumBinary, parseProbe, runRealtimeChromium, serveSite } from './website-capture'

const fixture =
  '<div class="docs-eyebrow">exclude me</div><h1>A &amp; B</h1><p>Words <strong>bold</strong> and <em>emphasis</em>, <a href="../builds/?a=1&amp;b=2#part">a [link]</a> with <code>`tick`</code>.</p><ol start="3"><li>Third<ul><li>Nested <b>bold</b></li></ul></li><li value="7">Seventh</li></ol><p><a href="#here">Fragment</a> <a href="/docs/">Root</a> <a href="https://github.com/defrex/autobuild">Repo</a> &lt;tag&gt; *literal*</p><pre><code class="language-ts">const x = `a`;\n```\n&lt;tag&gt;\n</code></pre><button data-markdown-exclude>exclude me</button>'
const expected =
  '# A & B\n\nWords **bold** and *emphasis*, [a \\[link\\]](<https://www.autobuild.run/docs/builds/?a=1&b=2#part>) with `` `tick` ``.\n\n3. Third\n   \n   - Nested **bold**\n7. Seventh\n\n[Fragment](<https://www.autobuild.run/docs/example/#here>) [Root](<https://www.autobuild.run/docs/>) [Repo](<https://github.com/defrex/autobuild>) \\<tag\\> \\*literal\\*\n\n````ts\nconst x = `a`;\n```\n<tag>\n````\n'

const punctuationFixture =
  '<h1>Clean prose.</h1><h2>1. Install in the repository</h2><p>Use local-git, stack-neutral, append-only (safe)! C++ #tag {value} a | b. <strong>Spec.</strong> ![literal] wow!</p><p># heading text</p><p>- bullet text</p><p>+ bullet text</p><p>* literal bullet</p><p>1. ordered text</p><p>2) ordered text</p><p><span>3</span>. split marker</p><p>--- </p><p>word # heading - plus + 1. 2) stay readable.</p>'
const punctuationExpected =
  '# Clean prose.\n\n## 1. Install in the repository\n\nUse local-git, stack-neutral, append-only (safe)! C++ #tag {value} a | b. **Spec.** \\!\\[literal\\] wow!\n\n\\# heading text\n\n\\- bullet text\n\n\\+ bullet text\n\n\\* literal bullet\n\n1\\. ordered text\n\n2\\) ordered text\n\n3\\. split marker\n\n\\---\n\nword # heading - plus + 1. 2) stay readable.\n'

test('production copy covers every article, responsive geometry, formatting and clipboard outcomes', async () => {
  const chromium = chromiumBinary()
  if (!chromium) throw Error('Chromium required for Markdown copy evidence')
  const files = await buildFiles()
  // Keep behavioral probes independent of the external font CDN. Full capture
  // still uses the production font for visual evidence.
  for (const page of DOCS_PAGES) {
    files[page.file] = files[page.file]!.replace(
      /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/,
      '',
    )
  }
  const serializer = await Bun.build({
    entrypoints: ['packages/website/src/docs-markdown.ts'],
    target: 'browser',
  })
  expect(serializer.success).toBe(true)
  const module = await serializer.outputs[0]!.text()
  // The fixture imports the exact serializer source; real pages use the production bundle.
  files['probe.html'] =
    `<html><head></head><body><iframe style="border:0;width:100%;height:800px"></iframe><script type="module">
  ${module.replace(/export\s*\{[^}]*\};?\s*$/, '')}
  const errors = []
  const check = (value, message) => { if (!value) errors.push(message) }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let context = 'serializer', writes = 0
  const frame = document.querySelector('iframe')
  const describe = () => {
    const doc = frame.contentDocument, button = doc?.querySelector('[data-docs-copy]')
    return JSON.stringify({url:doc?.URL, ready:doc?.readyState, disabled:button?.disabled, label:button?.textContent, writes})
  }
  const require = (value, expectation) => { if (!value) throw Error(context + ': expected ' + expectation + '; observed ' + describe()) }
  const waitFor = async (condition, expectation) => {
    const deadline = performance.now() + 3000
    while (!condition()) {
      require(performance.now() < deadline, expectation)
      await sleep(5)
    }
  }
  let restoreTimers = () => {}
  try {
    const article = document.createElement('article')
    article.innerHTML = ${JSON.stringify(fixture)}
    const before = article.innerHTML
    const actual = articleMarkdown(article, '${SITE_URL}/docs/example/')
    check(actual === ${JSON.stringify(expected)}, 'fixture: ' + JSON.stringify(actual))
    check(article.innerHTML === before, 'serializer mutated DOM')
    article.innerHTML = ${JSON.stringify(punctuationFixture)}
    const punctuation = articleMarkdown(article, '${SITE_URL}/docs/example/')
    check(punctuation === ${JSON.stringify(punctuationExpected)}, 'punctuation: ' + JSON.stringify(punctuation))
    for (const width of [1440, 720, 390]) {
      frame.style.width = width + 'px'
      for (const path of ${JSON.stringify(DOCS_PAGES.map((page) => page.path))}) {
        document.body.dataset.progress = path + width
        context = path + ' width=' + width + ' navigation'
        // A load event alone can belong to the iframe's initial document.
        frame.src = path
        await waitFor(() => frame.contentDocument?.location.pathname === path && frame.contentDocument.readyState === 'complete', 'requested document fully loaded')
        const win = frame.contentWindow, doc = frame.contentDocument
        await doc.fonts.ready
        const button = doc.querySelector('[data-docs-copy]'), status = doc.querySelector('[data-copy-status]')
        context = path + ' width=' + width + ' copy'
        require(button && status, 'copy button and live status')
        let copied
        writes = 0
        let clock = 0, nextTimer = -1
        const timers = new Map()
        const controlled = width === 390 && path === ${JSON.stringify(DOCS_PAGES.at(-1)!.path)}
        const advance = ms => {
          clock += ms
          for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback() }
        }
        // Control only production reset callbacks; promises and announcement tasks stay real.
        if (controlled) {
          const originalSet = win.setTimeout, originalClear = win.clearTimeout
          win.setTimeout = (callback, delay, ...args) => {
            if (delay !== 2000) return originalSet.call(win, callback, delay, ...args)
            const id = nextTimer--
            timers.set(id, {at:clock + delay, callback:() => callback(...args)})
            return id
          }
          win.clearTimeout = id => { if (!timers.delete(id)) originalClear.call(win, id) }
          restoreTimers = () => { win.setTimeout = originalSet; win.clearTimeout = originalClear }
        }
        Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { writes++; copied = text } } })
        const initialWidth = button.getBoundingClientRect().width
        const success = async (action) => {
          context = path + ' width=' + width + ' ' + action
          const previous = writes
          button.click()
          await waitFor(() => writes === previous + 1 && typeof copied === 'string' && button.textContent === 'Copied' && status.textContent === 'Copied' && !button.disabled, 'fresh clipboard write and completed success announcement')
          require(typeof copied === 'string', 'string clipboard payload')
        }
        await success('copy')
        check(Math.abs(button.getBoundingClientRect().width - initialWidth) < 1, path + ' stable outcome width')
        const title = doc.querySelector('h1')
        check(copied.split('\\n')[0] === '# ' + title.textContent, context + ' title: expected first line # ' + title.textContent)
        let index = 0
        for (const h2 of doc.querySelectorAll('article h2')) {
          const next = copied.indexOf('## ' + h2.textContent, index)
          check(next >= index, path + ' heading ' + h2.textContent); index = next + 1
        }
        const fences = [...copied.matchAll(/^(\\x60{3,})([^\\n]*)\\n([\\s\\S]*?)^\\1$/gm)]
        const pres = [...doc.querySelectorAll('article pre')]
        check(fences.length === pres.length, path + ' fence count')
        pres.forEach((pre, i) => check(fences[i]?.[3] === pre.textContent + (pre.textContent.endsWith('\\n') ? '' : '\\n'), path + ' code preserved'))
        const prose = copied.replace(/^(\\x60{3,})[^\\n]*\\n[\\s\\S]*?^\\1$/gm, '')
        check(!/<\\/?(?:h[1-6]|p|a|code|pre|div|span|button|nav|ul|ol|li)\\b/.test(prose), path + ' leaked HTML')
        check(!copied.includes('Copy as Markdown') && !copied.includes('concepts · builds') && !copied.includes('← previous'), path + ' chrome')
        check(prose.split('\\n').filter(line => /^# /.test(line)).length === 1, path + ' single article')
        for (const match of copied.matchAll(/\\]\\(<([^>]+)>\\)/g)) {
          const url = new URL(match[1]); check(url.origin === '${SITE_URL}' || [...doc.querySelectorAll('article a')].some(a => new URL(a.getAttribute('href'), '${SITE_URL}' + path).href === url.href), path + ' canonical or original external URL')
        }
        const rect = button.getBoundingClientRect(), heading = title.getBoundingClientRect(), style = win.getComputedStyle(button)
        check(rect.height >= (width < 720 ? 44 : 40), path + width + ' height')
        check(width < 720 ? rect.top >= heading.bottom && rect.left === heading.left : rect.left >= heading.right && rect.top < heading.bottom, path + width + ' placement')
        check(style.fontSize === '14px' && style.fontWeight === '700' && style.lineHeight === '20px' && style.borderTopWidth === '2px' && style.borderRadius === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopColor === 'rgba(0, 0, 0, 0)' && style.color === 'rgb(136, 136, 136)', path + ' styles')
        check(doc.documentElement.scrollWidth <= width, path + width + ' overflow')
        check(button.textContent === 'Copied' && status.textContent === 'Copied' && status.getAttribute('aria-live') === 'polite' && status.getAttribute('aria-atomic') === 'true', path + ' success announcement')
        if (!controlled) continue
        document.body.dataset.progress = 'clipboard states'
        require(timers.size === 1, 'success schedules a 2000 ms reset')
        advance(1999); check(button.textContent === 'Copied', context + ' success retained before two seconds')
        advance(1); check(button.textContent === 'Copy as Markdown', context + ' success reset at two seconds')
        await success('first repeated success')
        advance(1200)
        await success('second repeated success')
        require(timers.size === 1, 'new success cancels previous reset')
        advance(1999); check(button.textContent === 'Copied', context + ' new success owns full reset interval')
        advance(1); check(button.textContent === 'Copy as Markdown', context + ' new success resets')
        await success('success before failure')
        advance(1200)
        const failure = async (action) => {
          context = path + ' width=' + width + ' ' + action
          button.click()
          require(button.disabled && status.textContent === '', 'fresh failure action clears announcement while pending')
          await waitFor(() => !button.disabled && button.textContent === 'Copy failed' && status.textContent === 'Copy failed', 'completed fresh failure announcement')
        }
        Object.defineProperty(win.navigator, 'clipboard', {configurable:true, value:{writeText: async () => { writes++; throw Error('denied') }}})
        await failure('rejected clipboard')
        require(timers.size === 0, 'failure cancels success reset')
        advance(801); check(button.textContent === 'Copy failed', context + ' stale success timer cleared')
        Object.defineProperty(win.navigator, 'clipboard', {configurable:true, value:undefined})
        await failure('unavailable clipboard')
        let resolveWrite
        writes = 0
        Object.defineProperty(win.navigator, 'clipboard', {configurable:true, value:{writeText: () => { writes++; return new Promise(resolve => {resolveWrite = resolve}) }}})
        context = path + ' width=' + width + ' native Enter'
        document.body.dataset.progress = 'keyboard'
        frame.focus(); button.focus()
        const ready = document.createElement('meta'); ready.name = 'keyboard-ready'; document.head.append(ready)
        await waitFor(() => writes === 1, 'one clipboard write from native Enter activation')
        require(typeof resolveWrite === 'function', 'pending clipboard resolver')
        button.click()
        check(button.disabled && writes === 1 && button.textContent !== 'Copied', context + ' pending write serialized')
        resolveWrite()
        await waitFor(() => !button.disabled && button.textContent === 'Copied' && status.textContent === 'Copied' && doc.activeElement === button, 'completed keyboard success announcement and restored focus')
      }
    }
  } catch (error) { errors.push(String(error)) } finally { restoreTimers() }
  const meta = document.createElement('meta'); meta.name = 'capture-probe'
  meta.content = JSON.stringify({ error:errors.join('; '), status:'markdown complete' }); document.head.append(meta)
  </script></body></html>`
  const site = serveSite(files)
  let profile: string | undefined
  try {
    profile = await mkdtemp(join(tmpdir(), 'docs-markdown-'))
    const result = parseProbe(
      await runRealtimeChromium(
        chromium,
        profile,
        1440,
        900,
        { dumpDom: true, pressEnterWhen: 'meta[name=keyboard-ready]', timeoutMs: 20000 },
        `${site.url}/probe.html`,
      ),
    )
    expect(result.status).toBe('markdown complete')
    expect(result.error).toBe('')
  } finally {
    site.stop()
    if (profile) await rm(profile, { recursive: true, force: true })
  }
}, 30000)

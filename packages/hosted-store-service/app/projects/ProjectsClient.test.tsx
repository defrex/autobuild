import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectsClient } from './ProjectsClient'
const one = 'https://github.com/acme/one'
const two = 'https://github.com/acme/two'
const org = {
  id: 'acme',
  name: 'Acme',
  slug: 'acme',
  membershipRole: 'owner',
  ownerEmail: 'owner@example.com',
}
type Intercept = (path: string, options?: RequestInit) => Promise<Response> | undefined
async function harness(
  run: (h: {
    intercept: (handler: Intercept) => void
    document: Document
    click: (text: string, scope?: ParentNode) => Promise<void>
    type: (value: string) => Promise<void>
    deletes: string[]
    setProjects: (value: string[]) => void
    setPending: (value: string[]) => void
    failReload: () => void
  }) => Promise<void>,
) {
  const window = new Window({ url: 'https://example.com/projects' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  // happy-dom has no native top-layer implementation; Chromium capture covers layout.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  const nativeMatches = window.Element.prototype.matches
  window.Element.prototype.matches = function (selector: string) {
    return selector === ':modal' ? false : nativeMatches.call(this, selector)
  }
  const originalFetch = globalThis.fetch
  let projects = [one, two]
  let pending: string[] = []
  let fail = false
  const deletes: string[] = []
  let intercept: Intercept = () => undefined
  globalThis.fetch = (async (url, options) => {
    const path = String(url)
    const intercepted = intercept(path, options)
    if (intercepted) return intercepted
    if (options?.method === 'DELETE') {
      const repo = JSON.parse(String(options.body)).repo
      deletes.push(repo)
      expect(options.headers).toMatchObject({ 'if-match': repo })
      projects = projects.filter((p) => p !== repo)
      return new Response('An error occurred', { status: 502 })
    }
    if (path.includes('/projects/deletion?')) {
      const repo = new URL(path, 'https://example.com').searchParams.get('repo')!
      return Response.json({
        repo,
        token: repo,
        builds: 1,
        tickets: 0,
        secrets: 0,
        subscriptionAccounts: 0,
      })
    }
    if (path.endsWith('/orgs')) {
      if (fail) throw new Error('offline')
      return Response.json({ organizations: [org], isSuperUser: false })
    }
    if (path.endsWith('/members')) return Response.json({ members: [] })
    if (path.endsWith('/projects/deletions')) return Response.json({ projects: pending })
    return Response.json({ organization: org, projects })
  }) as typeof fetch
  const host = window.document.createElement('div')
  window.document.body.append(host)
  const root = createRoot(host as unknown as HTMLElement)
  const document = window.document as unknown as Document
  const click = async (text: string, scope: ParentNode = document) => {
    const button = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text)
    expect(button).toBeDefined()
    await act(async () => {
      button!.click()
    })
  }
  const type = async (value: string) => {
    const input = document.querySelector('input')!
    await act(async () => {
      // Bypass React's value tracker to exercise the real input event path.
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        value,
      )
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
    })
  }
  try {
    await act(async () => {
      root.render(<ProjectsClient identity="owner@example.com" isOwner isSuperUser={false} />)
    })
    await run({
      intercept: (handler) => {
        intercept = handler
      },
      document,
      click,
      type,
      deletes,
      setProjects: (value) => {
        projects = value
      },
      setPending: (value) => {
        pending = value
      },
      failReload: () => {
        fail = true
      },
    })
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}
for (const recovery of ['absent', 'present', 'pending', 'failed'])
  test(`unknown deletion holds first slot after dismissal; discovery recovery ${recovery}`, async () => {
    await harness(
      async ({ document, click, type, deletes, setProjects, setPending, failReload }) => {
        await click('Delete…', document.querySelector('[data-project]')!)
        expect(document.activeElement).toBe(document.querySelector('input'))
        await click('Delete project')
        expect(deletes).toEqual([])
        await type(one)
        await click('Delete project')
        expect(deletes).toEqual([one])
        await click('Cancel')
        const rows = document.querySelectorAll('[data-project]')
        expect(rows[0]!.getAttribute('data-project')).toBe(one)
        expect(rows[0]!.querySelector('button')).toBeNull()
        expect(rows[0]!.textContent).toContain('Deletion outcome unknown; reload to check')
        expect(rows[1]!.getAttribute('data-project')).toBe(two)
        await click('Delete…', rows[1]!)
        for (const value of ['', one, `${two}/`, ` ${two}`]) {
          await type(value)
          await click('Delete project')
          expect(deletes).toEqual([one])
        }
        await click('Cancel')
        if (recovery === 'present') setProjects([one, two])
        if (recovery === 'pending') setPending([one])
        if (recovery === 'failed') failReload()
        await click('Reload')
        const row = Array.from(document.querySelectorAll('[data-project]')).find(
          (r) => r.getAttribute('data-project') === one,
        )
        if (recovery === 'absent') expect(row).toBeUndefined()
        if (recovery === 'present') expect(row?.textContent).toContain('Delete…')
        if (recovery === 'pending') expect(row?.textContent).toContain('Finish deletion…')
        if (recovery === 'failed') expect(row?.querySelector('button')).toBeNull()
        await click('Delete…', document.querySelector(`[data-project="${two}"]`)!)
        expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
        await type(two)
        await click('Delete project')
        expect(deletes).toEqual([one, two])
      },
    )
  })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const previewResponse = (repo: string) =>
  Response.json({ repo, token: repo, builds: 0, tickets: 0, secrets: 0, subscriptionAccounts: 0 })
test('wrong preview cannot enable confirm; late cancelled preview cannot replace the new target', async () => {
  await harness(async ({ document, click, type, deletes, intercept }) => {
    intercept((path) =>
      path.includes('/deletion?') ? Promise.resolve(previewResponse(two)) : undefined,
    )
    await click('Delete…', document.querySelector('[data-project]')!)
    await type(one)
    await click('Delete project')
    expect(deletes).toEqual([])
    await click('Cancel')
    const late = deferred<Response>()
    intercept((path) => (path.includes(encodeURIComponent(one)) ? late.promise : undefined))
    await click('Delete…', document.querySelector('[data-project]')!)
    await click('Cancel')
    await click('Delete…', document.querySelectorAll('[data-project]')[1]!)
    await act(async () => {
      late.resolve(previewResponse(one))
    })
    expect(document.querySelector('dialog[open] h2')?.textContent).toContain(two)
    await type(two)
    await click('Delete project')
    expect(deletes).toEqual([two])
  })
})
test('double confirm sends once and a stale-generation failure requires discovery, never automatic retry', async () => {
  await harness(async ({ document, click, type, intercept }) => {
    const response = deferred<Response>()
    let count = 0
    let previews = 0
    intercept((path, options) => {
      if (options?.method === 'DELETE') {
        count++
        return response.promise
      }
      if (path.includes('/deletion?')) previews++
      return undefined
    })
    await click('Delete…', document.querySelector('[data-project]')!)
    await type(one)
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete project',
    )!
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(count).toBe(1)
    await act(async () => {
      response.resolve(Response.json({ error: 'stale' }, { status: 412 }))
    })
    expect(previews).toBe(1)
    expect(document.querySelector('[data-project]')?.textContent).toContain(
      'Deletion outcome unknown',
    )
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
  })
})
test('pending discovery blocks deletion; partial and forbidden reloads expose no cached actions', async () => {
  await harness(async ({ document, click, type, intercept }) => {
    const old = deferred<Response>()
    intercept((path) => (path.endsWith('/orgs') ? old.promise : undefined))
    await click('Reload')
    // While discovery is pending, confirmation must remain blocked.
    await click('Delete…', document.querySelector('[data-project]')!)
    expect(document.querySelector('dialog[open]')).toBeNull()
    await act(async () => {
      old.resolve(Response.json({ organizations: [org] }))
    })
    await click('Delete…', document.querySelector('[data-project]')!)
    await type(one)
    await click('Delete project')
    await click('Cancel')
    intercept((path) =>
      path.endsWith('/projects/deletions') ? Promise.resolve(Response.json({})) : undefined,
    )
    await click('Reload')
    expect(document.querySelector('[data-project]')?.textContent).toContain(
      'Deletion outcome unknown',
    )
    intercept((path) =>
      path.endsWith('/orgs')
        ? Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 }))
        : undefined,
    )
    await click('Reload')
    expect(document.querySelector('[data-project]')).toBeNull()
  })
})

test('Enter cannot bypass typing and reopening clears identity', async () => {
  await harness(async ({ document, click, type, deletes }) => {
    const enter = async () => {
      await act(async () => {
        document
          .querySelector('input')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
    }
    await click('Delete…', document.querySelector('[data-project]')!)
    await enter()
    expect(deletes).toEqual([])
    await type(one)
    await click('Cancel')
    await click('Delete…', document.querySelector('[data-project]')!)
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
    await enter()
    expect(deletes).toEqual([])
    await type(one)
    await enter()
    expect(deletes).toEqual([one])
  })
})

test('an acknowledged sibling deletion leaves an empty slot while another outcome is unknown', async () => {
  await harness(async ({ document, click, type, intercept, setProjects }) => {
    await click('Delete…', document.querySelectorAll('[data-project]')[1]!)
    await type(two)
    await click('Delete project')
    await click('Cancel')
    intercept((_path, options) =>
      options?.method === 'DELETE' ? Promise.resolve(Response.json({ deleted: true })) : undefined,
    )
    setProjects([])
    await click('Delete…', document.querySelector('[data-project]')!)
    await type(one)
    await click('Delete project')
    // Response.json() may finish reading its native stream after React's act
    // queue empties. Wait for the acknowledged close, not just the click.
    for (let turn = 0; turn < 50 && document.querySelector('dialog[open]'); turn++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    expect(document.querySelector('dialog[open]')).toBeNull()
    const unknown = document.querySelector('[data-project]')!
    expect(unknown.getAttribute('data-project')).toBe(two)
    expect(unknown.parentElement!.children[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(unknown.parentElement!.children[1]).toBe(unknown)
    expect(unknown.textContent).toContain('Deletion outcome unknown')
    await click('Reload')
    expect(document.querySelector('[data-project]')).toBeNull()
  })
})

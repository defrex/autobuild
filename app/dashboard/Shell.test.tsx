import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorShell } from './Shell'

const noop = () => {}

function renderShell(repositories: readonly string[]): string {
  return renderToStaticMarkup(
    <OperatorShell
      repo={repositories[0] ?? ''}
      repositories={repositories}
      identity="operator@example.com"
      onRepo={noop}
      onSignOut={noop}
      controls={<span data-testid="dispatcher-controls">queue 0 intake ON</span>}
    >
      <p>build content</p>
    </OperatorShell>,
  )
}

function expectTabless(html: string): void {
  expect(html).toContain('aria-label="Operator controls"')
  expect(html).not.toContain('BUILDS')
  expect(html).not.toContain('TICKETS')
  expect(html).not.toContain('class="tab"')
}

test('shell omits the repository control when none are configured', () => {
  const html = renderShell([])

  expect(html).toContain('no repository configured')
  expect(html).not.toContain('class="repo"')
  expect(html).not.toContain('<select')
  expectTabless(html)
})

test('shell omits the repository control for one repository', () => {
  const html = renderShell(['example/repository'])

  expect(html).toContain('<span>example/repository</span>')
  expect(html).not.toContain('class="repo"')
  expect(html).not.toContain('<select')
  expectTabless(html)
})

test('shell renders every repository when there is a choice', () => {
  const html = renderShell(['example/repository', 'example/alternate'])

  expect(html).toContain('<label class="repo">')
  expect(html).toContain('<span class="slack">repo </span>')
  expect(html).toContain('<select>')
  expect(html).toContain('<option selected="">example/repository</option>')
  expect(html).toContain('<option>example/alternate</option>')
  expectTabless(html)
})

test('shell composes selector, page controls, and the clock in one named landmark', () => {
  const html = renderShell(['example/repository', 'example/alternate'])
  const nav = html.match(/<nav class="line navline"[\s\S]*?<\/nav>/)?.[0]

  expect(nav).toBeDefined()
  expect(html.match(/aria-label="Operator controls"/g)).toHaveLength(1)
  expect(nav!.indexOf('class="repo"')).toBeLessThan(
    nav!.indexOf('data-testid="dispatcher-controls"'),
  )
  expect(nav!.indexOf('data-testid="dispatcher-controls"')).toBeLessThan(
    nav!.indexOf('class="clock"'),
  )
  expect(nav).toContain('--:--:--')
  expect(nav).not.toContain('operator@example.com')
  expect(nav).not.toContain('sign out')
})

test('shell places the account menu in the masthead, closed at rest', () => {
  const html = renderShell(['example/repository'])
  const header = html.match(/<header class="masthead"[\s\S]*?<\/header>/)?.[0]

  expect(header).toBeDefined()
  expect(header).toContain('class="menu account"')
  expect(header).toContain('aria-haspopup="menu"')
  expect(header).toContain('aria-expanded="false"')
  expect(header).toContain('<span class="identity">operator@example.com</span>')
  expect(header).not.toContain('sign out')
  expect(header).not.toContain('class="clock"')
})

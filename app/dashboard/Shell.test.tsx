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

test('shell composes selector, page controls, and account actions in one named landmark', () => {
  const html = renderShell(['example/repository', 'example/alternate'])
  const nav = html.match(/<nav class="line navline"[\s\S]*?<\/nav>/)?.[0]

  expect(nav).toBeDefined()
  expect(html.match(/aria-label="Operator controls"/g)).toHaveLength(1)
  expect(nav!.indexOf('class="repo"')).toBeLessThan(
    nav!.indexOf('data-testid="dispatcher-controls"'),
  )
  expect(nav!.indexOf('data-testid="dispatcher-controls"')).toBeLessThan(
    nav!.indexOf('class="identity"'),
  )
  expect(nav).toContain('operator@example.com')
  expect(nav).toContain('sign out')
})

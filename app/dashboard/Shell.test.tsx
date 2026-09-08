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

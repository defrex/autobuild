import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorShell, type Surface } from './Shell'

const noop = () => {}

function renderShell(surface: Surface, repositories: readonly string[]): string {
  return renderToStaticMarkup(
    <OperatorShell
      repo={repositories[0] ?? ''}
      repositories={repositories}
      identity="operator@example.com"
      surface={surface}
      onSurface={noop}
      onRepo={noop}
      onSignOut={noop}
    >
      <p>{surface} content</p>
    </OperatorShell>,
  )
}

for (const surface of ['builds', 'tickets'] as const) {
  test(`${surface} shell omits the repository control when none are configured`, () => {
    const html = renderShell(surface, [])

    expect(html).toContain('no repository configured')
    expect(html).not.toContain('class="repo"')
    expect(html).not.toContain('<select')
  })

  test(`${surface} shell omits the repository control for one repository`, () => {
    const html = renderShell(surface, ['example/repository'])

    expect(html).toContain('<span>example/repository</span>')
    expect(html).not.toContain('class="repo"')
    expect(html).not.toContain('<select')
  })

  test(`${surface} shell renders every repository when there is a choice`, () => {
    const html = renderShell(surface, ['example/repository', 'example/alternate'])

    expect(html).toContain('<label class="repo">')
    expect(html).toContain('<span class="slack">repo </span>')
    expect(html).toContain('<select>')
    expect(html).toContain('<option selected="">example/repository</option>')
    expect(html).toContain('<option>example/alternate</option>')
  })
}

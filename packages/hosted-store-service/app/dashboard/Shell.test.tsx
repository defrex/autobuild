import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorShell } from './Shell'

const noop = () => {}

function renderShell(repositories: readonly string[], projectMenuOpen = false): string {
  return renderToStaticMarkup(
    <OperatorShell
      repo={repositories[0] ?? ''}
      repositories={repositories}
      projectMenuOpen={projectMenuOpen}
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
  expect(html).not.toContain('project-menu')
  expect(html).not.toContain('<select')
  expectTabless(html)
})

test('shell omits the repository control for one repository', () => {
  const html = renderShell(['example/repository'])

  expect(html).toContain('<span class="project">example/repository</span>')
  expect(html).not.toContain('project-menu')
  expect(html).not.toContain('<select')
  expectTabless(html)
})

test('shell turns the masthead project into a picker when there is a choice', () => {
  const closed = renderShell(['https://github.com/example/repository', 'example/alternate'])
  const header = closed.match(/<header class="masthead"[\s\S]*?<\/header>/)?.[0]

  expect(header).toContain('class="menu project-menu"')
  expect(header).toContain('<span class="menu-label">github.com/example/repository</span>')
  expect(header).not.toContain('https://')
  expect(header).not.toContain('example/alternate')
  expect(closed).not.toContain('<select')
  expectTabless(closed)

  const open = renderShell(['https://github.com/example/repository', 'example/alternate'], true)
  expect(open).toContain('role="menuitemradio" aria-checked="true"')
  expect(open).toContain('>github.com/example/repository</button>')
  expect(open).toContain('role="menuitemradio" aria-checked="false"')
  expect(open).toContain('>example/alternate</button>')
})

test('shell leads the line with the view tabs and right-aligns the named controls', () => {
  const html = renderToStaticMarkup(
    <OperatorShell
      repo="example/repository"
      repositories={['example/repository', 'example/alternate']}
      identity="operator@example.com"
      onRepo={noop}
      onSignOut={noop}
      tabs={<nav data-testid="view-tabs">Triage Queue Active Done</nav>}
      controls={<span data-testid="dispatcher-controls">intake ON</span>}
    >
      <p>build content</p>
    </OperatorShell>,
  )
  const line = html.match(/<div class="line navline">[\s\S]*?<\/fieldset><\/div>/)?.[0]

  expect(line).toBeDefined()
  expect(html.match(/aria-label="Operator controls"/g)).toHaveLength(1)
  expect(line!.indexOf('data-testid="view-tabs"')).toBeLessThan(line!.indexOf('class="spacer"'))
  expect(line!.indexOf('class="spacer"')).toBeLessThan(
    line!.indexOf('data-testid="dispatcher-controls"'),
  )
  expect(line).not.toContain('example/alternate')
  expect(line).not.toContain('operator@example.com')
  expect(html).not.toContain('class="clock"')
})

test('shell places the account menu in the masthead, closed at rest', () => {
  const html = renderShell(['example/repository'])
  const header = html.match(/<header class="masthead"[\s\S]*?<\/header>/)?.[0]

  expect(header).toBeDefined()
  expect(header).toContain('class="menu account"')
  expect(header).toContain('aria-haspopup="menu"')
  expect(header).toContain('aria-expanded="false"')
  expect(header).toContain('<span class="identity">operator@example.com</span>')
  expect(header).not.toContain('Sign out')
  expect(header).not.toContain('class="clock"')
})

test('account menu presents all theme choices with selected semantics', () => {
  const html = renderToStaticMarkup(
    <OperatorShell
      repo="sample/project"
      repositories={['sample/project']}
      identity="person@example.com"
      onRepo={noop}
      onSignOut={noop}
      controls={null}
      menuOpen
    >
      <p>Builds</p>
    </OperatorShell>,
  )
  expect(html).toContain('aria-label="Theme"')
  expect(html).toContain('role="menuitemradio" aria-checked="true"')
  for (const choice of ['System', 'Light', 'Dark']) expect(html).toContain(`>${choice}</button>`)
  expect(html).toContain('Sign out')
})

test('account links show Members to every operator and management only to super users', () => {
  const common = {
    repo: '',
    repositories: [],
    identity: 'member@example.com',
    menuOpen: true,
    onRepo: () => {},
    onSignOut: () => {},
    controls: null,
    children: null,
  }
  const member = renderToStaticMarkup(<OperatorShell {...common} />)
  expect(member).toContain('href="/members"')
  expect(member).not.toContain('href="/organizations"')
  expect(member).not.toContain('href="/projects"')
  expect(member).not.toContain('aria-label="Super user"')
  const root = renderToStaticMarkup(<OperatorShell {...common} isSuperUser />)
  expect(root).toContain('href="/organizations"')
  expect(root).toContain('href="/projects"')
  expect(root).toContain('class="menu-group" aria-label="Super user"')
  expect(root.indexOf('>Members</a>')).toBeLessThan(root.indexOf('aria-label="Super user"'))
  expect(root.indexOf('>Projects</a>')).toBeLessThan(root.indexOf('>Theme</div>'))
  expect(root.indexOf('>Theme</div>')).toBeLessThan(root.indexOf('>Sign out</button>'))
})

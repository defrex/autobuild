import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Connection, ConnectionView } from './Connection'
import { connectionReturnPath } from '../sign-in/return-path'

test('connection code entry and every acknowledged state reuse the consent pattern', () => {
  const html = renderToStaticMarkup(<ConnectionView code="123456789A" />)
  expect(html).toContain('frame signin')
  expect(html).toContain('Review project')
  expect(html).toContain('connection-code')
  for (const status of ['pending', 'approved', 'denied', 'expired'] as const) {
    const result = renderToStaticMarkup(
      <ConnectionView
        code="123456789A"
        pending
        connection={{
          repo: 'https://github.com/example/project',
          code: '123456789A',
          credentialId: 'a'.repeat(32),
          status,
        }}
      />,
    )
    expect(result).toContain('https://github.com/example/project')
    if (status === 'pending') {
      expect(result).toContain('Deny')
      expect(result.match(/disabled=""/g)).toHaveLength(2)
    } else {
      expect(result).toContain(`Connection ${status}`)
      expect(result).not.toContain('<button')
    }
  }
  expect(
    renderToStaticMarkup(<ConnectionView code="" error="Unknown connection code" />),
  ).toContain('role="alert"')
})
test('login returns only to the same-origin connection path', () => {
  expect(connectionReturnPath('/connect?code=123456789a')).toBe('/connect?code=123456789A')
  for (const value of [
    '//evil.example/connect',
    '/\\evil.example/connect',
    'https://evil.example',
    '/operator',
    '/connect#external',
  ])
    expect(connectionReturnPath(value)).toBe('/')
})

test('organization chooser requires an explicit destination', () => {
  const organizations = [
    { id: 'a', name: 'Alpha', membershipRole: 'member' as const },
    { id: 'b', name: 'Beta', membershipRole: null },
  ]
  const html = renderToStaticMarkup(
    <ConnectionView
      code="123456789A"
      connection={{
        code: '123456789A',
        repo: 'example/new',
        credentialId: 'a'.repeat(32),
        status: 'pending',
      }}
      context={{ assignment: 'new', organizations, assignedOrganization: null }}
    />,
  )
  expect(html).toContain('type="radio"')
  expect(html).toContain('Add it to an organization')
  expect(html).toContain('disabled')
})

test('approval payload policy submits visible single membership and fixed reconnects', async () => {
  const { approvalOrganization, approvalBlocked } = await import('./Connection')
  const org = { id: 'a', name: 'A', membershipRole: 'member' as const }
  expect(
    approvalOrganization({ assignment: 'new', assignedOrganization: null, organizations: [org] }),
  ).toBe('a')
  expect(
    approvalOrganization({
      assignment: 'new',
      assignedOrganization: null,
      organizations: [{ ...org, membershipRole: null }],
    }),
  ).toBe('a')
  expect(
    approvalOrganization(
      { assignment: 'fixed', assignedOrganization: { id: 'a', name: 'A' }, organizations: [org] },
      'a',
    ),
  ).toBeUndefined()
  expect(
    approvalBlocked({ assignment: 'new', assignedOrganization: null, organizations: [] }),
  ).toBe(true)
  expect(
    approvalBlocked({
      assignment: 'new',
      assignedOrganization: null,
      organizations: [org, { ...org, id: 'b' }],
    }),
  ).toBe(true)
  expect(
    approvalBlocked(
      { assignment: 'new', assignedOrganization: null, organizations: [org, { ...org, id: 'b' }] },
      'b',
    ),
  ).toBe(false)
})

test('code links render checking before effects; missing and malformed codes retain entry', async () => {
  const { default: Page } = await import('./page')
  for (const code of ['abcdef1234', 'ABCDEF1234']) {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ code }) }))
    expect(html).toContain('Checking connection code')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Approve project')
  }
  for (const code of [undefined, 'bad', '123456789Z'])
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ code }) }))).toContain(
      'Review project',
    )
  expect(renderToStaticMarkup(<Connection initialCode="bad" />)).toContain('Review project')
})

test('single, fixed, unavailable and missing organization states are explicit', async () => {
  const { approvalBlocked } = await import('./Connection')
  const connection = {
    code: '123456789A',
    repo: 'example/repo',
    credentialId: 'a'.repeat(32),
    status: 'pending' as const,
  }
  const org = { id: 'a', name: 'Example organization', membershipRole: 'member' as const }
  const single = renderToStaticMarkup(
    <ConnectionView
      code={connection.code}
      connection={connection}
      context={{ assignment: 'new', assignedOrganization: null, organizations: [org] }}
    />,
  )
  expect(single).toContain('checked=""')
  expect(single).toContain(org.name)
  expect(single).not.toContain('disabled=""')
  const fixed = renderToStaticMarkup(
    <ConnectionView
      code={connection.code}
      connection={connection}
      context={{ assignment: 'fixed', assignedOrganization: org, organizations: [] }}
    />,
  )
  expect(fixed).toContain('Organization: <strong>Example organization')
  expect(fixed).not.toContain('type="radio"')
  const zero = renderToStaticMarkup(
    <ConnectionView
      code={connection.code}
      connection={connection}
      context={{ assignment: 'new', assignedOrganization: null, organizations: [] }}
    />,
  )
  expect(zero).toContain('No organization is available')
  expect(zero.match(/disabled=""/g)).toHaveLength(1)
  expect(approvalBlocked()).toBe(true)
})

test('decision JSON explicitly assigns sole options for members and super users; denial omits assignment', async () => {
  const { approvalDecision } = await import('./Connection')
  for (const membershipRole of ['member', null] as const) {
    const context = {
      assignment: 'new' as const,
      assignedOrganization: null,
      organizations: [{ id: 'a', name: 'A', membershipRole }],
    }
    expect(JSON.parse(JSON.stringify(approvalDecision('123456789A', true, context)))).toEqual({
      code: '123456789A',
      approve: true,
      organizationId: 'a',
    })
    expect(approvalDecision('123456789A', false, context, 'a')).toEqual({
      code: '123456789A',
      approve: false,
    })
    expect(
      approvalDecision(
        '123456789A',
        true,
        { ...context, assignment: 'fixed', assignedOrganization: { id: 'a', name: 'A' } },
        'a',
      ),
    ).toEqual({
      code: '123456789A',
      approve: true,
    })
  }
})

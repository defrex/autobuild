import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConnectionView } from './Connection'
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

test('organization chooser only for new projects with multiple destinations', () => {
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
      context={{ assignment: 'new', organizations }}
    />,
  )
  expect(html).toContain('type="radio"')
  expect(html).toContain('Add it to an organization')
  expect(html).toContain('disabled')
})

test('approval payload policy preserves single membership defaults and fixed reconnects', async () => {
  const { approvalOrganization, approvalBlocked } = await import('./Connection')
  const org = { id: 'a', name: 'A', membershipRole: 'member' as const }
  expect(approvalOrganization({ assignment: 'new', organizations: [org] })).toBeUndefined()
  expect(
    approvalOrganization({ assignment: 'new', organizations: [{ ...org, membershipRole: null }] }),
  ).toBe('a')
  expect(approvalOrganization({ assignment: 'fixed', organizations: [org] }, 'a')).toBeUndefined()
  expect(approvalBlocked({ assignment: 'new', organizations: [] })).toBe(true)
  expect(approvalBlocked({ assignment: 'new', organizations: [org, { ...org, id: 'b' }] })).toBe(
    true,
  )
  expect(
    approvalBlocked({ assignment: 'new', organizations: [org, { ...org, id: 'b' }] }, 'b'),
  ).toBe(false)
})

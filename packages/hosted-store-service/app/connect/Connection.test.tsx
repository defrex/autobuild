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

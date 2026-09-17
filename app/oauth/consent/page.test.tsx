import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ConsentPage from './page'

describe('the OAuth consent page', () => {
  test('reuses the sign-in page masthead and buttons under DESIGN.md rules', async () => {
    const html = renderToStaticMarkup(
      await ConsentPage({
        searchParams: Promise.resolve({
          consent_code: 'code-1',
          client_id: 'client-123',
          scope: 'openid profile email',
        }),
        // Unnamed-client render path: no registered name to show.
        lookupClientName: () => Promise.resolve(null),
      }),
    )
    // Same masthead copy and frame as the sign-in page.
    expect(html).toContain('frame signin')
    expect(html).toContain('masthead-copy')
    expect(html).toContain('Autobuild operator')
    expect(html).toContain('card')
    // The action is the existing btn class; no new components or styles.
    expect(html).toContain('class="btn"')
    expect(html).toContain('client-123')
    expect(html).toContain('openid profile email')
  })

  test('shows the registered client name alongside the client id', async () => {
    const html = renderToStaticMarkup(
      await ConsentPage({
        searchParams: Promise.resolve({
          consent_code: 'code-1',
          client_id: 'client-123',
          scope: 'openid profile email',
        }),
        lookupClientName: () => Promise.resolve('Acme MCP Console'),
      }),
    )
    expect(html).toContain('Acme MCP Console')
    // The raw id stays visible for transparency on a consent page.
    expect(html).toContain('client-123')
  })

  test('falls back to the client id when the name lookup rejects', async () => {
    const html = renderToStaticMarkup(
      await ConsentPage({
        searchParams: Promise.resolve({
          consent_code: 'code-1',
          client_id: 'client-123',
          scope: 'openid profile email',
        }),
        lookupClientName: () => Promise.reject(new Error('lookup exploded')),
      }),
    )
    expect(html).toContain('client-123')
    expect(html).not.toContain('lookup exploded')
  })

  test('names the missing authorization code instead of rendering a form', async () => {
    const html = renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('missing its authorization code')
  })
})

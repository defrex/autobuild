import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { Consent } from './Consent'
import ConsentPage from './page'

async function render(element: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element)
  return await new Response(stream).text()
}

describe('the OAuth consent view', () => {
  test('reuses the sign-in page masthead and buttons under DESIGN.md rules', async () => {
    const html = await Consent({
      query: {
        consent_code: 'code-1',
        client_id: 'client-123',
        scope: 'openid profile email',
      },
      // Unnamed-client render path: no registered name to show.
      lookupClientName: () => Promise.resolve(null),
    }).then((el) => render(el))
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
    const html = await Consent({
      query: {
        consent_code: 'code-1',
        client_id: 'client-123',
        scope: 'openid profile email',
      },
      lookupClientName: () => Promise.resolve('Acme MCP Console'),
    }).then((el) => render(el))
    expect(html).toContain('Acme MCP Console')
    // The raw id stays visible for transparency on a consent page.
    expect(html).toContain('client-123')
  })

  test('falls back to the client id when the name lookup rejects', async () => {
    const html = await Consent({
      query: {
        consent_code: 'code-1',
        client_id: 'client-123',
        scope: 'openid profile email',
      },
      lookupClientName: () => Promise.reject(new Error('lookup exploded')),
    }).then((el) => render(el))
    expect(html).toContain('client-123')
    expect(html).not.toContain('lookup exploded')
  })

  test('names the missing authorization code instead of rendering a form', async () => {
    const html = await Consent({
      query: {},
    }).then((el) => render(el))
    expect(html).toContain('missing its authorization code')
  })
})

describe('the OAuth consent page wrapper', () => {
  // No client_id, so no lookup fires and no DB is touched; the wrapper must
  // await searchParams and forward the query to Consent. Consent is an async
  // component, so the wrapper's element goes through the streaming renderer,
  // not the synchronous renderToStaticMarkup (React 19 throws on suspended
  // sync renders).
  test('awaits searchParams and renders the consent view', async () => {
    const html = await render(
      await ConsentPage({
        searchParams: Promise.resolve({ consent_code: 'code-9', scope: 'openid profile' }),
      }),
    )
    // The awaited query reached the view (scope copy) and the consent form
    // rendered instead of the missing-code warning. (The streaming renderer
    // separates adjacent text nodes with a comment marker, so the scope
    // assertion is split.)
    expect(html).toContain('Requested scopes:')
    expect(html).toContain('openid profile')
    expect(html).toContain('class="btn"')
    expect(html).not.toContain('missing its authorization code')
  })

  test('returns a Consent element carrying the awaited query', async () => {
    const query = { consent_code: 'code-7' }
    const element = await ConsentPage({ searchParams: Promise.resolve(query) })
    expect(element.type).toBe(Consent)
    expect(element.props.query).toEqual(query)
  })
})

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

  test('names the missing authorization code instead of rendering a form', async () => {
    const html = renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('missing its authorization code')
  })
})

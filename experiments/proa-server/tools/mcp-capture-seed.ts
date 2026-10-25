/** Consent requests are created by the same DCR/authorize endpoints clients use. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { SQL } from 'bun'
export async function seedConsentCapture(origin: string, capability: string, database: string) {
  const session = await fetch(`${origin}/auth/dev-session`, {
    method: 'POST',
    headers: { 'x-proa-dev-capability': capability },
    redirect: 'manual',
  })
  const cookie = session.headers
    .getSetCookie()
    .find((s) => s.startsWith('proa-session=') && !s.includes('Max-Age=0'))
    ?.split(';')[0]
  assert.ok(cookie)
  const states: Record<string, string> = {
    missing: '',
    refusal: 'not-a-real-request',
  }
  const sql = new SQL(database, { max: 1 })
  try {
    for (const state of [
      'named',
      'unnamed',
      'long',
      'expired',
      'used',
      'browser-accept',
      'browser-deny',
    ]) {
      const redirect = 'http://127.0.0.1:8765/callback'
      const client = await (
        await fetch(`${origin}/api/auth/mcp/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(state === 'unnamed'
              ? {}
              : {
                  client_name:
                    state === 'long'
                      ? 'An agent with a long client name for narrow screen review'
                      : 'Proa agent',
                }),
            redirect_uris: [redirect],
            token_endpoint_auth_method: 'none',
          }),
        })
      ).json()
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirect,
        state: 'proa-consent-browser',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
        scope: 'openid profile email offline_access',
        resource: `${origin}/mcp`,
        prompt: 'consent',
      })
      const response: Response = await fetch(`${origin}/api/auth/mcp/authorize?${query}`, {
        headers: { cookie },
        redirect: 'manual',
      })
      assert.equal(response.status, 302)
      const code = new URL(response.headers.get('location')!, origin).searchParams.get(
        'consent_code',
      )!
      assert.ok(code)
      states[state] = code
      states[`client-${state}`] = client.client_id
      if (state === 'used') {
        assert.equal(
          (
            await fetch(`${origin}/api/auth/oauth2/consent`, {
              method: 'POST',
              headers: { cookie, origin, 'content-type': 'application/json' },
              body: JSON.stringify({ accept: false, consent_code: code }),
            })
          ).status,
          200,
        )
      }
      if (state === 'expired') {
        const key = createHash('sha256').update(code).digest('base64url')
        await sql`UPDATE proa_oauth.state SET document=jsonb_set(document,${['pending', key, 'expires']},'0'::jsonb) WHERE singleton=true`
      }
    }
    return states
  } finally {
    await sql.close()
  }
}

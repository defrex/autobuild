/**
 * Access-token refresh over the hosted OAuth + MCP router (AUT-341). Expiry
 * needs a real wait past a one-second access token; the rest of the memory
 * adapter flow runs in memory in mcp.test.ts, and mcp.integration.test.ts
 * runs the flow against Postgres.
 */
import { describe, expect, test } from 'bun:test'
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  authorizeFlow,
  baseEnv,
  buildApp,
  buildAuth,
  discoverMetadata,
  dynamicRegister,
  ORIGIN,
  routerFetch,
  seedUser,
  toolsListRequest,
} from '../testing/mcp-oauth'

describe('hosted MCP over OAuth (memory adapter)', () => {
  test('refresh works after access-token expiry', async () => {
    // A dedicated instance with a 1-second access token: waiting out the
    // production hour would be absurd in a test.
    const shortAuth = buildAuth({ ...baseEnv }, 1)
    const short = buildApp({ ...baseEnv }, shortAuth)
    const seeded = await seedUser(shortAuth, 'ada@example.com')
    const metadata = await discoverMetadata(short.app)
    const client = await dynamicRegister(short.app, metadata)
    const tokens = await authorizeFlow(short.app, seeded.cookie, client)
    expect(tokens.expires_in).toBe(1)
    await Bun.sleep(1200)

    const expired = await short.app(toolsListRequest(tokens.access_token!, 2))
    expect(expired.status).toBe(401)

    const refreshed = await refreshAuthorization(ORIGIN, {
      metadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token!,
      fetchFn: routerFetch(short.app),
    })
    expect(refreshed.access_token).toBeTruthy()
    const works = await short.app(toolsListRequest(refreshed.access_token!, 3))
    expect(works.status).toBe(200)
  })
})

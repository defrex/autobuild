import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { chatgptStateSchema, earliestRefreshAt, type ChatGPTState } from './chatgpt-state'

const issuer = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const failure = () => new Error('ChatGPT authorization failed; sign in again')
type Fetch = typeof globalThis.fetch
export interface OAuthTransaction {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  hostId: string
  previous?: ChatGPTState
}
export function transaction(
  redirectUri: string,
  hostId: string,
  previous?: ChatGPTState,
): OAuthTransaction {
  const random = () => randomBytes(32).toString('base64url')
  return {
    state: random(),
    nonce: random(),
    verifier: random(),
    redirectUri,
    hostId,
    ...(previous ? { previous } : {}),
  }
}
export function authorizationUrl(t: OAuthTransaction): string {
  const url = new URL(`${issuer}/api/accounts/authorize`)
  url.search = new URLSearchParams({
    client_id: t.previous?.clientId ?? 'dynamic_agent_client',
    ...(t.previous ? { id_token_hint: t.previous.idToken } : { agent_name_hint: 'autobuild' }),
    ext_agent_host_id: t.hostId,
    response_type: 'code',
    redirect_uri: t.redirectUri,
    resource: CHATGPT_RESOURCE,
    scope: scopes,
    state: t.state,
    nonce: t.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(t.verifier).digest('base64url'),
  }).toString()
  return url.href
}
export function callback(t: OAuthTransaction, url: URL): { code: string; clientId: string } {
  if (
    url.pathname !== '/auth/callback' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== t.state ||
    url.searchParams.has('error')
  )
    throw failure()
  const clientId = url.searchParams.get('client_id') ?? t.previous?.clientId
  const code = url.searchParams.get('code')
  if (
    !code ||
    !clientId ||
    clientId === 'dynamic_agent_client' ||
    (t.previous && clientId !== t.previous.clientId) ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.getAll('client_id').length > 1
  )
    throw failure()
  return { code, clientId }
}
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
  timeoutDuration: 15000,
})
export async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce?: string,
  keys: JWTVerifyGetKey = jwks,
): Promise<string> {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer,
    audience: clientId,
    requiredClaims: ['exp', 'sub', ...(nonce ? ['nonce'] : [])],
    algorithms: ['RS256'],
    clockTolerance: 5,
  })
  if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw failure()
  return payload.sub
}
async function request(
  body: URLSearchParams,
  signal: AbortSignal,
  fetcher: Fetch,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetcher(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal,
      redirect: 'error',
    })
    if (!response.ok) throw failure()
    const text = await response.text()
    if (text.length > 300000) throw failure()
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure()
    return value as Record<string, unknown>
  } catch {
    throw failure()
  }
}
export async function parseTokens(
  raw: Record<string, unknown>,
  registration: {
    hostId: string
    clientId: string
    subject?: string
    nonce?: string
    previous?: ChatGPTState
  },
  verify = verifyIdentity,
  now = Date.now(),
): Promise<ChatGPTState> {
  try {
    if (
      typeof raw.access_token !== 'string' ||
      typeof raw.refresh_token !== 'string' ||
      typeof raw.expires_in !== 'number' ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 30 ||
      typeof raw.token_type !== 'string' ||
      raw.token_type.toLowerCase() !== 'bearer'
    )
      throw failure()
    const idToken = raw.id_token === undefined ? registration.previous?.idToken : raw.id_token
    if (typeof idToken !== 'string') throw failure()
    const subject =
      raw.id_token === undefined && registration.previous
        ? registration.previous.subject
        : await verify(idToken, registration.clientId, registration.nonce)
    if (registration.subject !== undefined && registration.subject !== subject) throw failure()
    const granted =
      raw.scope === undefined && registration.previous
        ? registration.previous.scopes
        : typeof raw.scope === 'string'
          ? raw.scope.split(/\s+/)
          : []
    const earliest = earliestRefreshAt(raw.earliest_refresh_at)
    return chatgptStateSchema.parse({
      version: 1,
      hostId: registration.hostId,
      clientId: registration.clientId,
      subject,
      scopes: granted,
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      idToken,
      expiresAt: now + raw.expires_in * 1000 - 5000,
      ...(earliest === undefined ? {} : { earliestRefreshAt: earliest }),
    })
  } catch {
    throw failure()
  }
}
export async function exchangeCode(
  t: OAuthTransaction,
  url: URL,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<ChatGPTState> {
  const { code, clientId } = callback(t, url)
  const raw = await request(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: t.verifier,
      redirect_uri: t.redirectUri,
      resource: CHATGPT_RESOURCE,
    }),
    signal,
    fetcher,
  )
  return parseTokens(raw, {
    hostId: t.hostId,
    clientId,
    nonce: t.nonce,
    subject: t.previous?.subject,
  })
}
export async function refreshChatGPT(
  state: ChatGPTState,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<ChatGPTState> {
  chatgptStateSchema.parse(state)
  if ((state.earliestRefreshAt ?? 0) > Date.now()) throw failure()
  const raw = await request(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: state.clientId,
      refresh_token: state.refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
    signal,
    fetcher,
  )
  return parseTokens(raw, {
    hostId: state.hostId,
    clientId: state.clientId,
    subject: state.subject,
    previous: state,
  })
}

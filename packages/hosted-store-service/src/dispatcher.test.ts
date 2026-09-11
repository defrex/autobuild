import { describe, expect, test } from 'bun:test'
import type { DispatchOpts } from 'autobuild/cli'
import { verifyToken } from 'autobuild/remote-store'
import { parseHostedStoreEnv } from './config'
import {
  createDispatcherEndpoint,
  createHostedDispatcher,
  parseHostedDispatcherEnv,
  type HostedDispatcherOptions,
} from './dispatcher'

const storeEnv = {
  AB_STORE_SECRET: 'test-signing-secret',
  AB_POSTGRES_URL: 'postgres://unused/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}

const baseEnv = {
  ...storeEnv,
  AB_DISPATCHER_ORIGIN: 'https://hosted.example.test',
  AB_DISPATCHER_REPOSITORIES: 'https://github.com/acme/one,git@github.com:acme/two.git',
  CRON_SECRET: 'cron-secret',
}

const at = new Date('2026-09-10T00:00:00.000Z')
const clock = () => at

describe('parseHostedDispatcherEnv', () => {
  test('parses defaults, normalizes and deduplicates repositories, and keeps order', () => {
    const config = parseHostedDispatcherEnv(baseEnv)
    // The signing secret is the store secret, through the one validated source.
    expect(config.secret).toBe(parseHostedStoreEnv(baseEnv).secret)
    expect(config.origin).toBe('https://hosted.example.test')
    expect(config.repositories).toEqual([
      'https://github.com/acme/one',
      'https://github.com/acme/two',
    ])
    expect(config.budgetSeconds).toBe(240)
    expect(config.tokenTtlSeconds).toBe(604800)
    expect(config.cronSecret).toBe('cron-secret')
  })

  test('falls back to AB_WEB_REPOSITORIES when AB_DISPATCHER_REPOSITORIES is unset', () => {
    const config = parseHostedDispatcherEnv({
      ...baseEnv,
      AB_DISPATCHER_REPOSITORIES: undefined,
      AB_WEB_REPOSITORIES: 'git@github.com:acme/web.git, https://github.com/acme/web',
    })
    expect(config.repositories).toEqual(['https://github.com/acme/web'])
  })

  test('rejects an empty repository set, unsafe repositories, and a bad origin', () => {
    expect(() =>
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_REPOSITORIES: '  ' }),
    ).toThrow(/AB_WEB_REPOSITORIES/)
    expect(() =>
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_REPOSITORIES: 'file:///etc/repo' }),
    ).toThrow(/unsafe repository name/)
    expect(() =>
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_ORIGIN: 'hosted.example.test' }),
    ).toThrow(/AB_DISPATCHER_ORIGIN must be an absolute/)
    expect(() =>
      parseHostedDispatcherEnv({
        ...baseEnv,
        AB_DISPATCHER_ORIGIN: 'https://hosted.example.test/app',
      }),
    ).toThrow(/without credentials or a path/)
    expect(() =>
      parseHostedDispatcherEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        AB_DISPATCHER_ORIGIN: 'http://hosted.example.test',
      }),
    ).toThrow(/must use https in production/)
  })

  test('clamps the budget and enforces the token TTL minimum', () => {
    expect(
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_BUDGET_SECONDS: '99999' }).budgetSeconds,
    ).toBe(780)
    expect(
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_BUDGET_SECONDS: '1' }).budgetSeconds,
    ).toBe(10)
    expect(() =>
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_BUDGET_SECONDS: 'soon' }),
    ).toThrow(/must be an integer/)
    expect(
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_TOKEN_TTL_SECONDS: '7200' })
        .tokenTtlSeconds,
    ).toBe(7200)
    expect(() =>
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_TOKEN_TTL_SECONDS: '3599' }),
    ).toThrow(/must be at least 3600/)
    // Blank CRON_SECRET means the endpoint is disabled, not a missing variable.
    expect(parseHostedDispatcherEnv({ ...baseEnv, CRON_SECRET: '  ' }).cronSecret).toBeUndefined()
  })

  test('parses per-repository forge credential overrides, normalized to served identities', () => {
    const config = parseHostedDispatcherEnv({
      ...baseEnv,
      AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({
        'git@github.com:acme/one.git': 'override-one',
        'https://github.com/acme/two': 'override-two',
      }),
    })
    expect([...config.githubTokenOverrides.entries()]).toEqual([
      ['https://github.com/acme/one', 'override-one'],
      ['https://github.com/acme/two', 'override-two'],
    ])
  })

  test('unset or blank AB_DISPATCHER_GITHUB_TOKENS means no overrides', () => {
    expect(parseHostedDispatcherEnv(baseEnv).githubTokenOverrides.size).toBe(0)
    expect(
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_GITHUB_TOKENS: '  ' })
        .githubTokenOverrides.size,
    ).toBe(0)
  })

  test('rejects malformed AB_DISPATCHER_GITHUB_TOKENS without echoing values', () => {
    const token = 'secret-forge-token'
    const cases: Array<Record<string, string | undefined>> = [
      // Malformed JSON — JSON.parse error text can embed input fragments, so
      // the rethrown message is fixed and never contains the input.
      { AB_DISPATCHER_GITHUB_TOKENS: `{"https://github.com/acme/one": "${token}"` },
      // Not a JSON object.
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify([token]) },
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify(token) },
      // Blank value.
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'https://github.com/acme/one': '  ' }) },
      // Non-string value.
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'https://github.com/acme/one': 42 }) },
      // Key outside the resolved served set (and an unsafe spelling).
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'https://github.com/acme/other': token }) },
      { AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'file:///etc/repo': token }) },
      // Two spellings normalizing to the same served identity.
      {
        AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({
          'https://github.com/acme/one': token,
          'git@github.com:acme/one.git': 'other-token',
        }),
      },
    ]
    for (const env of cases) {
      let message = ''
      try {
        parseHostedDispatcherEnv({ ...baseEnv, ...env })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain('AB_DISPATCHER_GITHUB_TOKENS')
      expect(message).not.toContain(token)
      expect(message).not.toContain('other-token')
    }
  })
})

describe('createHostedDispatcher', () => {
  function recordingDispatch(outcomes: Array<'ok' | 'throw'>) {
    const calls: DispatchOpts[] = []
    const dispatch = async (opts: DispatchOpts): Promise<void> => {
      calls.push(opts)
      if (outcomes[calls.length - 1] === 'throw') throw new Error('AB_STORE is misconfigured')
    }
    return { calls, dispatch }
  }

  function dispatcher(env: Record<string, string | undefined>, outcomes: Array<'ok' | 'throw'>) {
    const { calls, dispatch } = recordingDispatch(outcomes)
    const options: HostedDispatcherOptions = { env, clock, dispatch }
    return { calls, ...createHostedDispatcher(options) }
  }

  test('ticks each repository sequentially with isolated kernel env, identity, and deadline', async () => {
    const { calls, tick } = dispatcher(baseEnv, ['ok', 'ok'])
    const summary = await tick()
    expect(summary.deadlineAt).toBe(at.getTime() + 240 * 1000)
    expect(summary.repositories).toEqual([
      { repository: 'https://github.com/acme/one', outcome: 'ticked', runId: expect.any(String) },
      { repository: 'https://github.com/acme/two', outcome: 'ticked', runId: expect.any(String) },
    ])
    expect(calls).toHaveLength(2)
    for (const [index, call] of calls.entries()) {
      expect(call.repository).toBe(summary.repositories[index]!.repository)
      expect(call.once).toBe(true)
      expect(call.plain).toBe(true)
      expect(call.deadlineAt).toBe(summary.deadlineAt)
      expect(call.kernelRunId).toMatch(/^hosted-dispatcher-/)
      expect(call.env?.AB_STORE).toBe('https://hosted.example.test')
      const token = call.env?.AB_TOKEN ?? ''
      // The minted credential is a deployment operator token signed with the
      // store secret: accepted by the store and ticket servers alike.
      expect(verifyToken(storeEnv.AB_STORE_SECRET, token, at)).toMatchObject({
        operator: true,
        session: '*',
      })
    }
    expect(calls[0]!.kernelRunId).not.toBe(calls[1]!.kernelRunId)
  })

  test('one repository failing never stops another and carries a variable-naming error', async () => {
    const { tick } = dispatcher(baseEnv, ['throw', 'ok'])
    const summary = await tick()
    expect(summary.repositories[0]).toMatchObject({
      repository: 'https://github.com/acme/one',
      outcome: 'failed',
      error: 'AB_STORE is misconfigured',
    })
    expect(summary.repositories[1]).toMatchObject({
      repository: 'https://github.com/acme/two',
      outcome: 'ticked',
    })
  })

  test('an expired budget records further repositories as skipped', async () => {
    let calls = 0
    let now = at.getTime()
    const advancingClock = () => {
      calls += 1
      // Advance real time past the deadline once the first repository started.
      if (calls > 3) now += 1000 * 1000
      return new Date(now)
    }
    const { calls: dispatchCalls, dispatch } = recordingDispatch(['ok'])
    const summary = await createHostedDispatcher({
      env: baseEnv,
      clock: advancingClock,
      dispatch,
    }).tick()
    expect(dispatchCalls).toHaveLength(1)
    expect(summary.repositories).toEqual([
      { repository: 'https://github.com/acme/one', outcome: 'ticked', runId: expect.any(String) },
      { repository: 'https://github.com/acme/two', outcome: 'skipped' },
    ])
  })

  test('an override authenticates one repository while the other keeps the shared credential', async () => {
    const env = {
      ...baseEnv,
      GITHUB_TOKEN: 'shared-forge-token',
      AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({
        'https://github.com/acme/one': 'override-forge-token',
      }),
    }
    const { calls, tick } = dispatcher(env, ['ok', 'ok'])
    const summary = await tick()
    expect(summary.repositories.every((entry) => entry.outcome === 'ticked')).toBe(true)
    // The overridden repository's kernel env carries the override on BOTH
    // variables, so no reader can straddle two identities within one tick.
    expect(calls[0]!.env?.GITHUB_TOKEN).toBe('override-forge-token')
    expect(calls[0]!.env?.GH_TOKEN).toBe('override-forge-token')
    // The non-overridden repository's env keeps the shared credential
    // unchanged — the fallback path.
    expect(calls[1]!.env?.GITHUB_TOKEN).toBe('shared-forge-token')
    expect(calls[1]!.env?.GH_TOKEN).toBeUndefined()
  })

  test('an override works with no shared forge credential in the environment at all', async () => {
    const { calls, tick } = dispatcher(
      {
        ...baseEnv,
        AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({
          'https://github.com/acme/two': 'override-forge-token',
        }),
      },
      ['ok', 'ok'],
    )
    await tick()
    expect(calls[0]!.env?.GITHUB_TOKEN).toBeUndefined()
    expect(calls[1]!.env?.GITHUB_TOKEN).toBe('override-forge-token')
    expect(calls[1]!.env?.GH_TOKEN).toBe('override-forge-token')
  })

  test('token material never appears in the tick summary or a failed outcome', async () => {
    const override = 'override-forge-token'
    const { tick } = dispatcher(
      {
        ...baseEnv,
        GITHUB_TOKEN: 'shared-forge-token',
        AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'https://github.com/acme/one': override }),
      },
      ['throw', 'ok'],
    )
    const summary = await tick()
    expect(JSON.stringify(summary)).not.toContain(override)
    expect(JSON.stringify(summary)).not.toContain('shared-forge-token')
  })

  test('a misconfigured deployment fails loudly per invocation, naming the variable', async () => {
    const { tick } = dispatcher({ ...baseEnv, AB_DISPATCHER_ORIGIN: undefined }, [])
    expect(tick()).rejects.toThrow(/AB_DISPATCHER_ORIGIN/)
  })
})

describe('createDispatcherEndpoint', () => {
  function endpoint(options: HostedDispatcherOptions = {}) {
    return createDispatcherEndpoint({ clock, ...options })
  }
  const url = 'https://hosted.example.test/api/dispatch'
  const authorized = { authorization: 'Bearer cron-secret' }

  test('answers GET only', async () => {
    const response = await endpoint({ env: baseEnv }).fetch(
      new Request(url, { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(405)
  })

  test('is disabled without CRON_SECRET and never runs work', async () => {
    let dispatched = false
    const response = await endpoint({
      env: { ...baseEnv, CRON_SECRET: undefined },
      dispatch: async () => {
        dispatched = true
      },
    }).fetch(new Request(url))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ kind: 'disabled' })
    expect(dispatched).toBe(false)
  })

  test('rejects wrong and missing bearers with 401 and no work', async () => {
    let dispatched = false
    const dispatch = async (): Promise<void> => {
      dispatched = true
    }
    for (const headers of [
      { authorization: 'Bearer wrong' },
      { authorization: 'bearer cron-secret' },
      {} as Record<string, string>,
    ]) {
      const response = await endpoint({ env: baseEnv, dispatch }).fetch(
        new Request(url, { headers }),
      )
      expect(response.status).toBe(401)
      expect(dispatched).toBe(false)
    }
  })

  test('authorized GET runs one tick and answers the per-repository summary', async () => {
    const response = await endpoint({
      env: baseEnv,
      dispatch: async () => {},
    }).fetch(new Request(url, { headers: authorized }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      ok: true,
      repositories: [
        { repository: 'https://github.com/acme/one', outcome: 'ticked', runId: expect.any(String) },
        { repository: 'https://github.com/acme/two', outcome: 'ticked', runId: expect.any(String) },
      ],
    })
  })

  test('the authorized response body never carries forge credential material', async () => {
    const override = 'override-forge-token'
    const response = await endpoint({
      env: {
        ...baseEnv,
        GITHUB_TOKEN: 'shared-forge-token',
        AB_DISPATCHER_GITHUB_TOKENS: JSON.stringify({ 'https://github.com/acme/one': override }),
      },
      dispatch: async () => {},
    }).fetch(new Request(url, { headers: authorized }))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(override)
    expect(body).not.toContain('shared-forge-token')
  })

  test('a misconfigured deployment surfaces as a 500 naming the variable, never a value', async () => {
    const response = await endpoint({
      env: { ...baseEnv, AB_STORE_SECRET: undefined },
    }).fetch(new Request(url, { headers: authorized }))
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('AB_STORE_SECRET')
    expect(body.error).not.toContain('cron-secret')
  })
})

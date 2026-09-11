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

  test('parses AB_DISPATCHER_FORGE_CREDENTIALS into a name-only mapping with normalized keys', () => {
    const config = parseHostedDispatcherEnv({
      ...baseEnv,
      AB_DISPATCHER_FORGE_CREDENTIALS: JSON.stringify({
        'git@github.com:acme/one.git': 'ONE_FORGE_TOKEN',
        'https://github.com/acme/two': 'two_forge_token',
      }),
    })
    expect(config.forgeCredentials).toEqual({
      'https://github.com/acme/one': 'ONE_FORGE_TOKEN',
      'https://github.com/acme/two': 'two_forge_token',
    })
  })

  test('AB_DISPATCHER_FORGE_CREDENTIALS unset or blank means no overrides', () => {
    expect(parseHostedDispatcherEnv(baseEnv).forgeCredentials).toEqual({})
    expect(
      parseHostedDispatcherEnv({ ...baseEnv, AB_DISPATCHER_FORGE_CREDENTIALS: '  ' })
        .forgeCredentials,
    ).toEqual({})
  })

  test('invalid AB_DISPATCHER_FORGE_CREDENTIALS fails the invocation, naming the variable only', () => {
    const value = 'token-value-never-echoed'
    const envWithMapping = (mapping: string) => ({
      ...baseEnv,
      AB_DISPATCHER_FORGE_CREDENTIALS: mapping,
    })
    for (const mapping of ['not json', '["https://github.com/acme/one"]', '5', '"str"']) {
      try {
        parseHostedDispatcherEnv(envWithMapping(mapping))
        throw new Error(`expected ${mapping} to be rejected`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('AB_DISPATCHER_FORGE_CREDENTIALS')
        expect(message).not.toContain(value)
      }
    }
    // A key outside the repository set fails loudly instead of quietly
    // dropping the override (a quiet drop would cross identities).
    expect(() =>
      parseHostedDispatcherEnv(
        envWithMapping(JSON.stringify({ 'https://github.com/acme/other': 'OTHER_TOKEN' })),
      ),
    ).toThrow(/outside AB_DISPATCHER_REPOSITORIES/)
    expect(() =>
      parseHostedDispatcherEnv(envWithMapping(JSON.stringify({ 'file:///etc/repo': 'TOKEN' }))),
    ).toThrow(/unsafe repository name/)
    // Values must be plausible environment variable names.
    expect(() =>
      parseHostedDispatcherEnv(
        envWithMapping(JSON.stringify({ 'https://github.com/acme/one': 'not a var name' })),
      ),
    ).toThrow(/environment variable names/)
    expect(() =>
      parseHostedDispatcherEnv(
        envWithMapping(JSON.stringify({ 'https://github.com/acme/one': '9BAD' })),
      ),
    ).toThrow(/environment variable names/)
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

  test('a misconfigured deployment fails loudly per invocation, naming the variable', async () => {
    const { tick } = dispatcher({ ...baseEnv, AB_DISPATCHER_ORIGIN: undefined }, [])
    expect(tick()).rejects.toThrow(/AB_DISPATCHER_ORIGIN/)
  })

  test('an overridden repository injects its own GITHUB_TOKEN and drops the shared GH_TOKEN', async () => {
    const env = {
      ...baseEnv,
      GITHUB_TOKEN: 'shared-forge-token',
      GH_TOKEN: 'shared-gh-token',
      APP_FORGE_TOKEN: 'app-override-token',
      AB_DISPATCHER_FORGE_CREDENTIALS: JSON.stringify({
        'https://github.com/acme/one': 'APP_FORGE_TOKEN',
      }),
    }
    const { calls, tick } = dispatcher(env, ['ok', 'ok'])
    const summary = await tick()
    expect(summary.repositories.map((r) => r.outcome)).toEqual(['ticked', 'ticked'])
    // Overridden: the referenced variable's value is injected as GITHUB_TOKEN
    // and the shared GH_TOKEN fallback must not survive into the tick, so
    // cross-identity selection is unambiguous.
    expect(calls[0]!.env?.GITHUB_TOKEN).toBe('app-override-token')
    expect(calls[0]!.env).not.toHaveProperty('GH_TOKEN')
    // Non-overridden: the shared credential flows through verbatim, unchanged.
    expect(calls[1]!.env?.GITHUB_TOKEN).toBe('shared-forge-token')
    expect(calls[1]!.env?.GH_TOKEN).toBe('shared-gh-token')
    // Redaction: the summary never carries credential material.
    expect(JSON.stringify(summary)).not.toContain('app-override-token')
  })

  test('a blank override variable fails only that repository and never falls back', async () => {
    const env = {
      ...baseEnv,
      GITHUB_TOKEN: 'shared-forge-token',
      APP_FORGE_TOKEN: '   ',
      AB_DISPATCHER_FORGE_CREDENTIALS: JSON.stringify({
        'https://github.com/acme/one': 'APP_FORGE_TOKEN',
      }),
    }
    const { calls, tick } = dispatcher(env, ['ok'])
    const summary = await tick()
    expect(summary.repositories[0]).toMatchObject({
      repository: 'https://github.com/acme/one',
      outcome: 'failed',
      error: expect.stringContaining('APP_FORGE_TOKEN'),
    })
    // Fail closed: no dispatch call was made for the failed repository and
    // the shared credential was not substituted for the missing override.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.repository).toBe('https://github.com/acme/two')
    expect(calls[0]!.env?.GITHUB_TOKEN).toBe('shared-forge-token')
    // The failure never echoes a value — only the variable name.
    expect(JSON.stringify(summary)).not.toContain('shared-forge-token')
  })

  test('captured stdout/stderr passthrough never carries an override value', async () => {
    const env = {
      ...baseEnv,
      GITHUB_TOKEN: 'shared-forge-token',
      APP_FORGE_TOKEN: 'app-override-token',
      AB_DISPATCHER_FORGE_CREDENTIALS: JSON.stringify({
        'https://github.com/acme/one': 'APP_FORGE_TOKEN',
      }),
    }
    const outLines: string[] = []
    const errLines: string[] = []
    await createHostedDispatcher({
      env,
      clock,
      dispatch: async (opts) => {
        opts.stdout?.('tick line')
        opts.stderr?.('kernel error line')
      },
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
    }).tick()
    expect(outLines.join('\n')).not.toContain('app-override-token')
    expect(errLines.join('\n')).not.toContain('app-override-token')
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

  test('a misconfigured deployment surfaces as a 500 naming the variable, never a value', async () => {
    const response = await endpoint({
      env: { ...baseEnv, AB_STORE_SECRET: undefined },
    }).fetch(new Request(url, { headers: authorized }))
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('AB_STORE_SECRET')
    expect(body.error).not.toContain('cron-secret')
  })

  test('an authorized GET with a credential mapping answers the unchanged shape, no credential material', async () => {
    const response = await endpoint({
      env: {
        ...baseEnv,
        GITHUB_TOKEN: 'shared-forge-token',
        APP_FORGE_TOKEN: 'app-override-token',
        AB_DISPATCHER_FORGE_CREDENTIALS: JSON.stringify({
          'https://github.com/acme/one': 'APP_FORGE_TOKEN',
        }),
      },
      dispatch: async () => {},
    }).fetch(new Request(url, { headers: authorized }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; repositories: unknown[]; error?: string }
    expect(body.ok).toBe(true)
    expect(body.repositories).toHaveLength(2)
    expect(body.error).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('app-override-token')
    expect(JSON.stringify(body)).not.toContain('APP_FORGE_TOKEN')
  })
})

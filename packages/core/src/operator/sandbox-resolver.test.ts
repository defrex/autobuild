import { describe, expect, test } from 'bun:test'
import { historicalEffectiveConfig } from '../config/effective-artifact.fixture'
import { parseConfig } from '../config/load'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT } from '../store/retention'
import { manualClock } from '../testing/fixed'
import {
  operatorSandboxCallReadBudget,
  operatorSandboxStatusReadBudget,
} from '../testing/reduced-read-budget'
import type { OperatorSandboxService } from './sandbox'
import { createOperatorSandboxResolver, SandboxUnavailableError } from './sandbox-resolver'

const REPO = 'https://github.com/example/resolver'

test('a sandbox call costs the same store reads at 1 and 1,000 effective-config revisions', async () => {
  const one = await operatorSandboxCallReadBudget({ revisions: 1 })
  const many = await operatorSandboxCallReadBudget({ revisions: 1000 })
  expect(many.callVector).toEqual(one.callVector)
  expect(one.callVector.listRepoArtifacts).toBeUndefined()
  expect(many.rows).toBe(one.rows)
  for (const run of [one, many]) {
    expect(run.issued).toBe(1)
    expect(run.composed).toBe(1)
  }
})

test('sandbox.status costs the same at 10 and 5,000 journal events and reads no rows when unchanged', async () => {
  const short = await operatorSandboxStatusReadBudget({ history: 10 })
  const long = await operatorSandboxStatusReadBudget({ history: 5000 })
  expect(long.callVector).toEqual(short.callVector)
  expect(long.rows).toBe(short.rows)
  for (const run of [short, long]) {
    expect(run.repoRows).toBe(0)
    expect(run.appended).toBe(0)
  }
})

function fakeService(disposed: string[], label: string): OperatorSandboxService {
  return { canPublish: true, dispose: async () => void disposed.push(label) } as never
}

async function fixture(
  options: { enabled?: boolean; deposit?: boolean; preflight?: () => void } = {},
) {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  const deposit = (enabled: boolean) =>
    store.putRepoArtifact(REPO, {
      kind: DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT,
      content: JSON.stringify(historicalEffectiveConfig(enabled)),
    })
  if (options.deposit !== false) await deposit(options.enabled ?? true)
  const clock = manualClock('2026-11-24T00:00:00.000Z')
  const issued: Date[] = []
  const composed: { storeToken: string; oidc?: string }[] = []
  const disposed: string[] = []
  const reported: unknown[] = []
  let failCompose: Error | undefined
  const resolver = createOperatorSandboxResolver({
    store,
    clock,
    canPublish: true,
    issueStoreToken: async (_repo, expiresAt) => {
      issued.push(expiresAt)
      return `token-${issued.length}`
    },
    credentialKey: (credentials) => credentials?.oidcToken ?? '',
    ...(options.preflight !== undefined ? { preflight: options.preflight } : {}),
    report: (error) => void reported.push(error),
    compose: async ({ storeToken, credentials }) => {
      if (failCompose) throw failCompose
      composed.push({
        storeToken,
        ...(credentials?.oidcToken ? { oidc: credentials.oidcToken } : {}),
      })
      return fakeService(disposed, `service-${composed.length}`)
    },
  })
  return {
    store,
    clock,
    resolver,
    deposit,
    issued,
    composed,
    disposed,
    reported,
    failNext: (error: Error | undefined) => {
      failCompose = error
    },
  }
}

const reasonOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(SandboxUnavailableError)
  return (error as SandboxUnavailableError).reason
}

describe('gate reasons', () => {
  test('no repository record or no deposit is no-effective-config', async () => {
    const { resolver } = await fixture({ deposit: false })
    expect(await reasonOf(resolver.resolve(REPO))).toBe('no-effective-config')
    expect(await reasonOf(resolver.resolve('https://github.com/example/unknown'))).toBe(
      'no-effective-config',
    )
  })

  test('a disabled latest config is orchestrator-disabled', async () => {
    const { resolver, deposit } = await fixture({ enabled: true })
    await deposit(false)
    expect(await reasonOf(resolver.resolve(REPO))).toBe('orchestrator-disabled')
  })

  test('a deposit that never names enabled is served: the hosted default', async () => {
    const { resolver, store, composed } = await fixture({ deposit: false })
    await store.putRepoArtifact(REPO, {
      kind: DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(
        parseConfig('[tickets]\nsource = "file"\nreadyState = "ready"\n'),
      ),
    })
    await resolver.resolve(REPO)
    expect(composed).toHaveLength(1)
  })

  test('a preflight refusal keeps its reason, mints no token, and is retried next call', async () => {
    let missing = true
    const { resolver, issued, composed, reported } = await fixture({
      preflight: () => {
        if (missing)
          throw new SandboxUnavailableError('credentials-missing', 'missing: GITHUB_TOKEN')
      },
    })
    const error = await resolver.resolve(REPO).catch((caught: unknown) => caught)
    expect((error as SandboxUnavailableError).reason).toBe('credentials-missing')
    expect((error as Error).message).toBe('missing: GITHUB_TOKEN')
    expect(issued).toHaveLength(0)
    expect(composed).toHaveLength(0)
    expect(reported).toHaveLength(0)
    missing = false
    await resolver.resolve(REPO)
    expect(composed).toHaveLength(1)
  })

  test('a composition refusing with a typed reason propagates unwrapped', async () => {
    const { resolver, failNext, reported } = await fixture()
    failNext(new SandboxUnavailableError('credentials-missing', 'missing: GH_TOKEN'))
    expect(await reasonOf(resolver.resolve(REPO))).toBe('credentials-missing')
    expect(reported).toHaveLength(0)
  })

  test('an invalid latest config is effective-config-invalid', async () => {
    const { resolver, store } = await fixture()
    await store.putRepoArtifact(REPO, { kind: DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT, content: '{' })
    expect(await reasonOf(resolver.resolve(REPO))).toBe('effective-config-invalid')
  })

  test('a composition failure is backend-unavailable, redacted, and retried next call', async () => {
    const { resolver, failNext, composed } = await fixture()
    const secret = 'super-secret-token-value'
    const previous = process.env.VERCEL_TOKEN
    process.env.VERCEL_TOKEN = secret
    try {
      failNext(new Error(`credential ${secret} rejected`))
      const error = await resolver.resolve(REPO).catch((caught: unknown) => caught)
      expect((error as SandboxUnavailableError).reason).toBe('backend-unavailable')
      expect((error as Error).message).not.toContain(secret)
    } finally {
      if (previous === undefined) delete process.env.VERCEL_TOKEN
      else process.env.VERCEL_TOKEN = previous
    }
    failNext(undefined)
    await resolver.resolve(REPO)
    expect(composed).toHaveLength(1)
  })
})

describe('cache keys', () => {
  test('a new revision recomposes and disposes the old service without a new credential', async () => {
    const { resolver, deposit, issued, composed, disposed } = await fixture()
    const first = await resolver.resolve(REPO)
    expect(await resolver.resolve(REPO)).toBe(first)
    await deposit(true)
    const second = await resolver.resolve(REPO)
    expect(second).not.toBe(first)
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toEqual(['service-1'])
    expect(composed).toHaveLength(2)
    expect(issued).toHaveLength(1)
  })

  test('a changed credential key recomposes without a new credential', async () => {
    const { resolver, issued, composed } = await fixture()
    await resolver.resolve(REPO, { oidcToken: 'a' })
    await resolver.resolve(REPO, { oidcToken: 'b' })
    expect(composed.map((entry) => entry.oidc)).toEqual(['a', 'b'])
    expect(issued).toHaveLength(1)
  })

  test('a token near expiry is renewed exactly once', async () => {
    const { resolver, clock, issued, composed } = await fixture()
    await resolver.resolve(REPO, { oidcToken: 'a' })
    clock.advance(51 * 60_000)
    await resolver.resolve(REPO, { oidcToken: 'b' })
    await resolver.resolve(REPO, { oidcToken: 'c' })
    expect(issued).toHaveLength(2)
    expect(composed.map((entry) => entry.storeToken)).toEqual(['token-1', 'token-2', 'token-2'])
  })

  test('concurrent first calls compose once', async () => {
    const { resolver, composed, issued } = await fixture()
    const [a, b] = await Promise.all([resolver.resolve(REPO), resolver.resolve(REPO)])
    expect(a).toBe(b)
    expect(composed).toHaveLength(1)
    expect(issued).toHaveLength(1)
  })
})

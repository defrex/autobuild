import { describe, expect, test } from 'bun:test'
import { FakeForge } from '../ports/forge/fake'
import { SandboxOperationError } from '../ports/workspace/operator-sandbox'
import { sandboxStates } from '../processes/sandbox-state'
import { MemoryBuildStore } from '../store/memory'
import {
  memoryOperatorSandbox,
  type MemoryOperatorSandboxOptions,
} from '../testing/memory-operator-sandbox'
import { OPERATOR_TOOL_ANNOTATIONS } from './annotations'
import { buildRegistry, type RegistryError } from './registry'
import {
  createOperatorSandboxService,
  resolveSandboxRelativePath,
  truncateSandboxOutput,
  SANDBOX_TRUNCATION_MARKER,
  sandboxPublicationBranch,
} from './sandbox'

describe('resolveSandboxRelativePath', () => {
  test('normalizes safe relative paths and rejects every escape shape', () => {
    expect(resolveSandboxRelativePath('src/a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('./src/./a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('src/../a.txt')).toBe('a.txt')
    for (const bad of ['../x', '/abs', 'a/../../b', '', '.', 'a/..', 'C:/x']) {
      expect(() => resolveSandboxRelativePath(bad)).toThrow(SandboxOperationError)
    }
  })
})

describe('truncateSandboxOutput', () => {
  test('returns output at the bound unchanged and appends the marker past it', () => {
    const exact = 'a'.repeat(65_536)
    expect(truncateSandboxOutput(exact)).toBe(exact)
    const over = 'b'.repeat(65_537)
    const truncated = truncateSandboxOutput(over)
    expect(truncated.startsWith('b'.repeat(65_536))).toBe(true)
    expect(truncated).toContain(SANDBOX_TRUNCATION_MARKER)
  })
})

test('branch naming: an operator with no alphanumerics still yields a canonical branch', () => {
  const branch = sandboxPublicationBranch('https://github.com/acme/widgets', '@@@')
  expect(branch).toMatch(/^ab\/orch--[0-9a-f]{8}$/)
  expect(branch).toMatch(/^ab\/[a-z0-9][a-z0-9-]*$/)
  const normal = sandboxPublicationBranch('https://github.com/acme/widgets', 'Ada Lovelace!')
  expect(normal).toBe(
    `ab/orch-ada-lovelace-${require('node:crypto')
      .createHash('sha256')
      .update('https://github.com/acme/widgets\0Ada Lovelace!')
      .digest('hex')
      .slice(0, 8)}`,
  )
})

// ── Lifecycle contract (#1223), over the IO-free memory provider ──────────

const REPO = 'https://github.com/example/lifecycle'
const BASE = 'a'.repeat(40)

async function lifecycle(opts: MemoryOperatorSandboxOptions & { store?: MemoryBuildStore } = {}) {
  const store = opts.store ?? new MemoryBuildStore()
  const sandbox = memoryOperatorSandbox('mem', opts)
  const make = () =>
    createOperatorSandboxService({
      store,
      repo: REPO,
      provider: sandbox.provider,
      sandbox: { idleMinutes: 30, environmentVariables: [] },
      baseBranch: 'main',
      forge: new FakeForge(),
      sleep: async () => {},
    })
  const service = await make()
  const types = async () =>
    (await store.getRepoEvents(REPO)).map((event) =>
      event.type.replace('orchestrator.sandbox.', ''),
    )
  const snapshot = async () =>
    sandboxStates(await store.getRepoStateEvents(REPO)).find((state) => state.operator === 'ops')
  return { store, sandbox, service, make, types, snapshot }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (error: unknown) => error as SandboxOperationError,
  )

/** The background settle handler's attempts: one plus its bounded retries. */
const BACKGROUND_ATTEMPTS = 4

/** A store whose next appends of `type` (plain or conditional) reject,
 * `times` times. */
function rejectAppends(store: MemoryBuildStore, type: string, times: number) {
  const real = store.appendRepo.bind(store)
  const realIfCurrent = store.appendRepoIfCurrent.bind(store)
  let remaining = times
  const refuse = (event: { type: string }): void => {
    if (event.type === type && remaining > 0) {
      remaining--
      throw new Error('store unavailable')
    }
  }
  store.appendRepo = (async (repo: string, event: { type: string }) => {
    refuse(event)
    return real(repo, event as never)
  }) as typeof store.appendRepo
  store.appendRepoIfCurrent = (async (repo: string, seq: number, event: { type: string }) => {
    refuse(event)
    return realIfCurrent(repo, seq, event as never)
  }) as typeof store.appendRepoIfCurrent
}

describe('OperatorSandboxService lifecycle', () => {
  test('before open every operation refuses not-ready/absent without provisioning', async () => {
    const fx = await lifecycle()
    const calls: Promise<unknown>[] = [
      fx.service.exec('ops', { repo: REPO, command: 'true' }),
      fx.service.start('ops', { repo: REPO, command: 'true' }),
      fx.service.readFile('ops', { repo: REPO, path: 'a' }),
      fx.service.writeFile('ops', { repo: REPO, path: 'a', content: 'x', encoding: 'utf8' }),
      fx.service.publish('ops', { repo: REPO, title: 'Fix' }),
      fx.service.refresh('ops', { repo: REPO }),
    ]
    for (const call of calls) {
      expect(await refusal(call)).toMatchObject({ stage: 'not-ready', state: 'absent' })
    }
    expect(fx.sandbox.opened).toEqual([])
    expect(fx.sandbox.commands).toEqual([])
    expect(fx.sandbox.ensureCalls).toEqual([])
    expect(await fx.types()).toEqual([])
  })

  test('deferred open returns provisioning, gates exec, and journals the settled base', async () => {
    const fx = await lifecycle({ provisioning: 'deferred' })
    const [first, second] = await Promise.all([
      fx.service.open('ops', { repo: REPO }),
      fx.service.open('ops', { repo: REPO }),
    ])
    expect(first.state).toBe('provisioning')
    expect(second.state).toBe('provisioning')
    expect(await fx.types()).toEqual(['provisioning'])
    expect(await refusal(fx.service.exec('ops', { repo: REPO, command: 'true' }))).toMatchObject({
      stage: 'not-ready',
      state: 'provisioning',
    })
    fx.sandbox.complete('ready', BASE)
    await fx.service.settled('ops')
    expect(await fx.types()).toEqual(['provisioning', 'provisioned'])
    expect((await fx.snapshot())?.baseSha).toBe(BASE)
    await fx.service.exec('ops', { repo: REPO, command: 'echo hi' })
    expect(fx.sandbox.commands.map((entry) => entry.command)).toEqual(['echo hi'])
  })

  test('a failed attempt journals a redacted provision-failed; status reports it and writes nothing', async () => {
    const previous = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ghp-secret-value'
    try {
      const fx = await lifecycle({ provisioning: 'deferred' })
      await fx.service.open('ops', { repo: REPO })
      fx.sandbox.complete({ stage: 'setup', message: 'boom ghp-secret-value' })
      await fx.service.settled('ops')
      const events = await fx.store.getRepoEvents(REPO)
      expect(events.at(-1)?.payload).toMatchObject({ stage: 'setup', message: 'boom [REDACTED]' })
      for (let i = 0; i < 3; i++) {
        expect(await fx.service.status('ops', { repo: REPO })).toMatchObject({
          state: 'failed',
          failure: { stage: 'setup', message: 'boom [REDACTED]' },
        })
      }
      expect(await fx.store.getRepoEvents(REPO)).toHaveLength(events.length)
      expect((await fx.service.open('ops', { repo: REPO })).state).toBe('provisioning')
      expect(await fx.types()).toEqual(['provisioning', 'provision-failed', 'provisioning'])
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previous
    }
  })

  test('close stops a live environment, open resumes it, and closing nothing is a noop', async () => {
    const fx = await lifecycle()
    expect((await fx.service.close('ops', { repo: REPO })).outcome).toBe('noop')
    expect((await fx.service.open('ops', { repo: REPO })).state).toBe('ready')
    expect((await fx.service.close('ops', { repo: REPO })).outcome).toBe('closed')
    expect(await refusal(fx.service.exec('ops', { repo: REPO, command: 'true' }))).toMatchObject({
      state: 'stopped',
    })
    expect((await fx.service.close('ops', { repo: REPO })).outcome).toBe('noop')
    expect((await fx.service.open('ops', { repo: REPO })).state).toBe('ready')
    await fx.service.exec('ops', { repo: REPO, command: 'true' })
    expect(await fx.types()).toEqual(['provisioned', 'closed', 'resumed'])
  })

  test('close during provisioning cancels the attempt; its late completion records nothing', async () => {
    const fx = await lifecycle({ provisioning: 'deferred' })
    await fx.service.open('ops', { repo: REPO })
    expect((await fx.service.close('ops', { repo: REPO })).outcome).toBe('closed')
    expect(fx.sandbox.cancelled).toHaveLength(1)
    fx.sandbox.complete('ready')
    await fx.service.settled('ops')
    expect(await fx.types()).toEqual(['provisioning', 'closed'])
    expect((await fx.snapshot())?.state).toBe('stopped')
    expect(await refusal(fx.service.exec('ops', { repo: REPO, command: 'true' }))).toMatchObject({
      state: 'stopped',
    })
    expect((await fx.service.status('ops', { repo: REPO })).state).not.toBe('ready')
    await fx.service.open('ops', { repo: REPO })
    fx.sandbox.complete('ready', BASE)
    await fx.service.settled('ops')
    expect(await fx.types()).toEqual(['provisioning', 'closed', 'provisioning', 'provisioned'])
  })

  test('close racing a completed provision keeps its base and journals once', async () => {
    const fx = await lifecycle({ provisioning: 'deferred', completeBeforeClose: true })
    await fx.service.open('ops', { repo: REPO })
    await fx.service.close('ops', { repo: REPO })
    await fx.service.settled('ops')
    expect(await fx.types()).toEqual(['provisioning', 'provisioned', 'closed'])
    expect((await fx.snapshot())?.baseSha).toBeDefined()
  })

  test('release during provisioning cancels without waiting for the attempt', async () => {
    const fx = await lifecycle({ provisioning: 'deferred' })
    await fx.service.open('ops', { repo: REPO })
    await fx.service.release('ops', { repo: REPO })
    await fx.service.settled('ops')
    fx.sandbox.complete('ready')
    expect(await fx.types()).toEqual(['provisioning', 'released'])
  })

  for (const outcome of ['ready', 'failed'] as const) {
    test(`reset during provisioning journals the replacement attempt (${outcome})`, async () => {
      const fx = await lifecycle({ provisioning: 'deferred' })
      await fx.service.open('ops', { repo: REPO })
      expect((await fx.service.reset('ops', { repo: REPO })).state).toBe('provisioning')
      const sentinel = Symbol('pending')
      expect(await Promise.race([fx.service.settled('ops'), Promise.resolve(sentinel)])).toBe(
        sentinel,
      )
      fx.sandbox.complete(outcome === 'ready' ? 'ready' : { stage: 'setup', message: 'boom' }, BASE)
      await fx.service.settled('ops')
      fx.sandbox.complete('ready')
      const tail = outcome === 'ready' ? 'provisioned' : 'provision-failed'
      expect(await fx.types()).toEqual(['provisioning', 'reset', 'released', 'provisioning', tail])
      if (outcome === 'ready') {
        expect((await fx.snapshot())?.baseSha).toBe(BASE)
        await fx.service.exec('ops', { repo: REPO, command: 'true' })
      } else {
        expect((await fx.service.status('ops', { repo: REPO })).failure?.stage).toBe('setup')
        expect(
          await refusal(fx.service.exec('ops', { repo: REPO, command: 'true' })),
        ).toMatchObject({ state: 'failed' })
      }
    })
  }

  test('a failure whose append was rejected is recorded exactly once by the next open or exec', async () => {
    for (const recovery of ['open', 'exec'] as const) {
      const store = new MemoryBuildStore()
      rejectAppends(store, 'orchestrator.sandbox.provision-failed', BACKGROUND_ATTEMPTS)
      const fx = await lifecycle({ provisioning: 'deferred', store })
      await fx.service.open('ops', { repo: REPO })
      fx.sandbox.complete({ stage: 'setup', message: 'boom' })
      await fx.service.settled('ops')
      expect(await fx.types()).toEqual(['provisioning'])
      if (recovery === 'open') {
        await fx.service.open('ops', { repo: REPO })
        fx.sandbox.complete('ready')
        await fx.service.settled('ops')
        expect(await fx.types()).toEqual([
          'provisioning',
          'provision-failed',
          'provisioning',
          'provisioned',
        ])
      } else {
        expect(
          await refusal(fx.service.exec('ops', { repo: REPO, command: 'true' })),
        ).toMatchObject({ state: 'failed' })
        await fx.service.open('ops', { repo: REPO })
        expect(await fx.types()).toEqual(['provisioning', 'provision-failed', 'provisioning'])
      }
      await fx.service.open('ops', { repo: REPO })
      expect((await fx.types()).filter((type) => type === 'provision-failed')).toHaveLength(1)
    }
  })

  test('a flush whose append fails again refuses open without starting a new attempt', async () => {
    const store = new MemoryBuildStore()
    rejectAppends(store, 'orchestrator.sandbox.provision-failed', BACKGROUND_ATTEMPTS + 1)
    const fx = await lifecycle({ provisioning: 'deferred', store })
    await fx.service.open('ops', { repo: REPO })
    fx.sandbox.complete({ stage: 'setup', message: 'boom' })
    await fx.service.settled('ops')
    expect(await refusal(fx.service.open('ops', { repo: REPO }))).toMatchObject({
      stage: 'provision',
    })
    expect(fx.sandbox.opened).toHaveLength(1)
    await fx.service.open('ops', { repo: REPO })
    expect((await fx.types()).filter((type) => type === 'provision-failed')).toHaveLength(1)
  })

  test('refresh journals a fast-forward as the new base; current and refusals write nothing', async () => {
    const fx = await lifecycle()
    await fx.service.open('ops', { repo: REPO })
    const refreshedBase = '2'.repeat(40)
    expect((await fx.service.refresh('ops', { repo: REPO })).outcome).toBe('refreshed')
    expect((await fx.snapshot())?.baseSha).toBe(refreshedBase)
    fx.sandbox.refreshResult = {
      outcome: 'current',
      headSha: refreshedBase,
      baseSha: refreshedBase,
      previousHeadSha: refreshedBase,
    }
    expect((await fx.service.refresh('ops', { repo: REPO })).outcome).toBe('current')
    for (const reason of ['dirty', 'diverged'] as const) {
      fx.sandbox.refreshResult = { outcome: 'refused', reason, message: `refused ${reason}` }
      expect(await refusal(fx.service.refresh('ops', { repo: REPO }))).toMatchObject({
        stage: `refresh-${reason}`,
      })
    }
    expect(await fx.types()).toEqual(['provisioned', 'refreshed'])
  })

  for (const kind of ['provision', 'resume'] as const) {
    test(`a restarted service reconciles a lagging ${kind} from the provider`, async () => {
      const store = new MemoryBuildStore()
      const fx = await lifecycle({ provisioning: 'deferred', store })
      await fx.service.open('ops', { repo: REPO })
      if (kind === 'resume') {
        fx.sandbox.complete('ready', BASE)
        await fx.service.settled('ops')
        await fx.service.close('ops', { repo: REPO })
        await fx.service.open('ops', { repo: REPO })
      }
      const fact = kind === 'provision' ? 'provisioned' : 'resumed'
      rejectAppends(store, `orchestrator.sandbox.${fact}`, BACKGROUND_ATTEMPTS)
      fx.sandbox.complete('ready', BASE)
      await fx.service.settled('ops')
      expect((await fx.types()).at(-1)).toBe('provisioning')
      const restarted = await fx.make()
      expect(await restarted.status('ops', { repo: REPO })).toMatchObject({
        state: 'ready',
        baseSha: BASE,
      })
      await restarted.exec('ops', { repo: REPO, command: 'true' })
      expect((await fx.types()).at(-1)).toBe(fact)
      expect((await fx.snapshot())?.baseSha).toBe(BASE)
      expect((await restarted.publish('ops', { repo: REPO, title: 'Fix' })).sha).toBeDefined()
    })
  }

  test('a provider without the lifecycle answers unsupported and never provisions', async () => {
    const fx = await lifecycle({ lifecycle: false })
    const lifecycleCalls = () => [
      fx.service.open('ops', { repo: REPO }),
      fx.service.status('ops', { repo: REPO }),
      fx.service.close('ops', { repo: REPO }),
      fx.service.refresh('ops', { repo: REPO }),
      fx.service.reset('ops', { repo: REPO }),
    ]
    const env = { operator: 'ops', environmentId: `mem:${REPO}:ops` }
    const actor = { kind: 'human' as const, user: 'ops' }
    for (const journal of ['absent', 'live', 'stopped'] as const) {
      if (journal === 'live') {
        await fx.store.appendRepo(REPO, {
          actor,
          type: 'orchestrator.sandbox.provisioned',
          payload: { ...env, provider: 'mem', workspacePath: '/checkout' },
        })
      }
      if (journal === 'stopped') {
        await fx.store.appendRepo(REPO, {
          actor,
          type: 'orchestrator.sandbox.closed',
          payload: env,
        })
      }
      for (const call of lifecycleCalls()) {
        expect(await refusal(call)).toMatchObject({ stage: 'unsupported' })
      }
      const exec = fx.service.exec('ops', { repo: REPO, command: 'true' })
      if (journal === 'live') await exec
      else expect(await refusal(exec)).toMatchObject({ stage: 'not-ready' })
    }
    expect(fx.sandbox.opened).toEqual([])
    expect(fx.sandbox.closed).toEqual([])
    expect(fx.sandbox.refreshes).toEqual([])
    expect(fx.sandbox.ensureCalls).toEqual([])
    expect(fx.sandbox.releases).toEqual([])
  })

  test('the registry maps a not-ready refusal with its state and annotates the lifecycle tools', async () => {
    const fx = await lifecycle()
    const registry = buildRegistry({ store: fx.store, sandbox: fx.service })
    const failure = (await registry
      .call('sandbox.exec', { repo: REPO, command: 'true' }, { identity: 'ops' })
      .catch((error: unknown) => error)) as RegistryError
    expect(failure.body).toMatchObject({
      kind: 'refusal',
      code: 'sandbox-not-ready',
      state: 'absent',
    })
    expect(OPERATOR_TOOL_ANNOTATIONS['sandbox.status']).toMatchObject({
      readOnlyHint: true,
      approval: 'never',
    })
    for (const name of ['sandbox.open', 'sandbox.close', 'sandbox.refresh'] as const) {
      expect(OPERATOR_TOOL_ANNOTATIONS[name]).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        approval: 'default',
      })
    }
  })
})

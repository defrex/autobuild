import { describe, expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { parseConfig } from '../config/load'
import { KERNEL } from '../events/envelope'
import { sequentialIds, randomUuids } from '../ids'
import { nativeHandle } from '../ports/runner/native-session'
import { ScriptedAgentRunner, defaultTurnResult, failedTurnResult } from '../ports/runner/fake'
import type { AgentRunner } from '../ports/types'
import { MemoryBuildStore } from '../store/memory'
import { FakeTicketSource } from '../ports/tickets/fake'
import { steppingClock } from '../testing/fixed'
import { HarvestRunner } from './harvest-runner'

async function suspendedFixture(handle = nativeHandle('scripted', 'native-old', '/workspace')) {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo('/repo')
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.started',
    payload: {
      run: 'run',
      observations: [{ build: 'b', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.step.started',
    payload: { run: 'run', step: 'synthesize', round: 1 },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.session.started',
    payload: {
      run: 'run',
      session: 'old',
      role: 'harvest',
      runner: 'scripted',
      args: [],
      step: 'synthesize',
      round: 1,
    },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.session.native-handle-recorded',
    payload: { run: 'run', session: 'old', handle },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.session.suspended',
    payload: {
      run: 'run',
      session: 'old',
      cause: 'cutover',
      transcript: { kind: 'harvest-transcript', rev: 0 },
    },
  })
  const config = parseConfig(
    '[tickets]\nsource="file"\nreadyState="Ready"\n[roles.default]\nruntime="scripted"\n[policy]\nharvestThreshold=100',
  )
  const stop = new AbortController()
  const run = (runner: AgentRunner, primary?: AgentRunner) =>
    new HarvestRunner({
      store,
      config,
      tickets: new FakeTicketSource(),
      runtimes: {
        scripted: { runner, servesModels: [''] },
        ...(primary ? { primary: { runner: primary, servesModels: [''] } } : {}),
      },
      repo: '/repo',
      workspacePath: '/workspace',
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'next',
      shutdownSignal: stop.signal,
    }).run()
  return { store, config, stop, run, handle }
}

describe('harvest native continuation boundaries', () => {
  for (const reason of [
    'unsupported',
    'wrong-host',
    'wrong-workspace',
    'missing-state',
    'changed-route',
  ] as const) {
    test(`records ${reason} and suspends the fresh fallback without recovery`, async () => {
      const handle = nativeHandle(
        'scripted',
        'native-old',
        reason === 'wrong-workspace' ? '/other' : '/workspace',
        reason === 'wrong-host' ? 'other-host' : hostname(),
      )
      const fx = await suspendedFixture(handle)
      if (reason === 'changed-route') fx.config.roles.default!.args = ['changed']
      const adapter = new ScriptedAgentRunner({
        script: () => {
          fx.stop.abort()
          return defaultTurnResult('fresh partial')
        },
      })
      const runner =
        reason === 'unsupported'
          ? {
              name: adapter.name,
              start: adapter.start.bind(adapter),
              continue: adapter.continue.bind(adapter),
              end: adapter.end.bind(adapter),
            }
          : adapter
      expect((await fx.run(runner)).outcome).toBe('suspended')
      const events = await fx.store.getRepoEvents('/repo')
      expect(
        events
          .filter((e) => e.type === 'harvest.session.resume-fallback')
          .map((e) => e.payload.reason),
      ).toEqual([reason])
      expect(
        events.some((e) => e.type === 'harvest.failed' || e.type === 'harvest.recovery-requested'),
      ).toBe(false)
    })
  }

  test('provider credential failure retains ordinary failure accounting', async () => {
    const fx = await suspendedFixture()
    const adapter = new ScriptedAgentRunner({
      nativeState: new Map([['native-old', []]]),
      script: () => failedTurnResult('credentials denied', true, '', 'credentials'),
    })
    expect((await fx.run(adapter)).outcome).toBe('failed')
    const events = await fx.store.getRepoEvents('/repo')
    expect(events.some((e) => e.type === 'harvest.session.resume-fallback')).toBe(false)
    expect(events.find((e) => e.type === 'harvest.failed')?.payload.error).toBe(
      'credentials denied',
    )
  })

  test('suspension persistence rejection propagates without a false graceful result', async () => {
    const fx = await suspendedFixture()
    const append = fx.store.appendRepoWithArtifacts.bind(fx.store)
    fx.store.appendRepoWithArtifacts = async (...args) => {
      if (args[1].some((a) => a.kind === 'harvest-transcript')) throw new Error('store unavailable')
      return append(...args)
    }
    const adapter = new ScriptedAgentRunner({
      nativeState: new Map([['native-old', []]]),
      script: () => {
        fx.stop.abort()
        return defaultTurnResult()
      },
    })
    await expect(fx.run(adapter)).rejects.toThrow('Harvest suspension persistence failed')
    const events = await fx.store.getRepoEvents('/repo')
    expect(events.filter((e) => e.type === 'harvest.session.suspended')).toHaveLength(1)
    expect(events.some((e) => e.type === 'harvest.failed')).toBe(false)
  })

  test('a crashed unaccepted continuation retains its inherited handle and spends crash recovery', async () => {
    const fx = await suspendedFixture()
    await fx.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.session.started',
      payload: {
        run: 'run',
        session: 'crashed',
        role: 'harvest',
        runner: 'scripted',
        args: [],
        step: 'synthesize',
        round: 1,
        continuation: { predecessor: 'old', root: 'old', handle: fx.handle, cause: 'cutover' },
      },
    })
    const adapter = new ScriptedAgentRunner({
      nativeState: new Map([['native-old', []]]),
      script: () => {
        fx.stop.abort()
        return defaultTurnResult()
      },
    })
    expect((await fx.run(adapter)).outcome).toBe('suspended')
    const events = await fx.store.getRepoEvents('/repo')
    expect(events.filter((e) => e.type === 'harvest.recovery-requested')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'harvest.failed')).toHaveLength(1)
    const accepted = events.find((e) => e.type === 'harvest.session.resumed')
    expect(accepted?.payload).toMatchObject({
      predecessor: 'crashed',
      root: 'old',
      handle: fx.handle,
    })
  })
})

test('a typed terminal deposited during cancellation cleanup wins suspension', async () => {
  const fx = await suspendedFixture()
  let logicalSession = ''
  const adapter = new ScriptedAgentRunner({
    nativeState: new Map([['native-old', []]]),
    script: ({ opts }) => {
      logicalSession = opts.env.AB_SESSION!
      fx.stop.abort()
      return defaultTurnResult()
    },
  })
  const end = adapter.end.bind(adapter)
  adapter.end = async (session) => {
    await fx.store.appendRepo('/repo', {
      actor: { kind: 'agent', role: 'harvest', session: logicalSession },
      type: 'harvest.proposals.submitted',
      payload: { run: 'run', round: 1, artifact: { kind: 'harvest-proposals', rev: 0 } },
    })
    return end(session)
  }
  expect((await fx.run(adapter)).outcome).toBe('suspended')
  const events = await fx.store.getRepoEvents('/repo')
  expect(events.filter((e) => e.type === 'harvest.session.suspended')).toHaveLength(1)
  expect(
    events.some(
      (e) =>
        e.type === 'harvest.step.completed' &&
        e.payload.step === 'synthesize' &&
        e.payload.outcome === 'completed',
    ),
  ).toBe(true)
  expect(events.some((e) => e.type === 'harvest.failed')).toBe(false)
})

test('a suspended alternate resumes its original route before trying the primary', async () => {
  const fx = await suspendedFixture()
  fx.config.roles.default!.runtime = 'primary'
  fx.config.roles.default!.alternates = [{ runtime: 'scripted', args: [] }]
  const primary = new ScriptedAgentRunner({
    script: () => {
      throw new Error('must not select primary')
    },
  })
  const alternate = new ScriptedAgentRunner({
    nativeState: new Map([['native-old', []]]),
    script: () => {
      fx.stop.abort()
      return defaultTurnResult()
    },
  })
  expect((await fx.run(alternate, primary)).outcome).toBe('suspended')
  const events = await fx.store.getRepoEvents('/repo')
  expect(
    events.some(
      (e) => e.type === 'harvest.session.resumed' && e.payload.handle.nativeId === 'native-old',
    ),
  ).toBe(true)
  expect(events.some((e) => e.type === 'harvest.session.resume-fallback')).toBe(false)
  expect(primary.sessions.size).toBe(0)
})

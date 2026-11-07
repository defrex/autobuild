import { expect, test } from 'bun:test'
import { KERNEL, DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { buildReadFactsReducer } from './read-facts'
import { readDispatcherLiveness, StandbyIdentityResolver } from '../cli/dispatcher-liveness'
import { detail, detailFromFacts, renderDetail } from '../cli/status'
import { runtimeIdentitySchema } from '../events/runtime'
import { eventPayloadSchemas } from '../events/payloads'
import { repositoryEventPayloadSchemas } from '../events/repository'
import { buildEventPolicy, repositoryEventPolicy } from '../events/policy'
import { formatDispatcherIdentity } from './dispatcher-liveness'

const first = {
  version: '1.0.0',
  commit: 'a'.repeat(40),
  source: { kind: 'source' as const, location: '/runtime/first' },
}
const second = { ...first, commit: 'b'.repeat(40) }

test('runtime schemas are strict and companions advisory; original boundaries remain valid', () => {
  expect(buildEventPolicy['runner.runtime-recorded']).toBe('advisory')
  expect(repositoryEventPolicy['dispatcher.runtime-recorded']).toBe('advisory')
  expect(buildEventPolicy['runner.attached']).toBe('decisive')
  expect(repositoryEventPolicy['dispatcher.run-started']).toBe('decisive')
  expect(
    eventPayloadSchemas['runner.attached'].safeParse({ instance: 'i', host: 'h' }).success,
  ).toBe(true)
  for (const runtime of [
    { ...first, extra: true },
    { ...first, commit: 'bad' },
    { ...first, version: ' ' },
    { ...first, source: { kind: 'source', location: '' } },
  ])
    expect(runtimeIdentitySchema.safeParse(runtime).success).toBe(false)
  expect(
    eventPayloadSchemas['runner.runtime-recorded'].safeParse({
      instance: 'i',
      attachedSeq: 0,
      runtime: first,
    }).success,
  ).toBe(false)
  expect(
    repositoryEventPayloadSchemas['dispatcher.runtime-recorded'].safeParse({
      run: 'r',
      startedSeq: 0,
      runtime: first,
    }).success,
  ).toBe(false)
})

test('runner history correlates exact sequences across cold, warm, incremental and whole-log reads', async () => {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'history', repo: '/repo' })
  const attach = () =>
    store.append(record.slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'reused', host: 'host' },
    })
  const a = await attach()
  expect((await readBuildFacts(store, record.slug)).value.runnerAttaches[0]?.runtime).toBeNull()
  await store.append(record.slug, {
    actor: KERNEL,
    type: 'runner.runtime-recorded',
    payload: { instance: 'wrong', attachedSeq: a.seq, runtime: second },
  })
  await store.append(record.slug, {
    actor: KERNEL,
    type: 'runner.runtime-recorded',
    payload: { instance: 'reused', attachedSeq: a.seq, runtime: first },
  })
  const b = await attach()
  await store.append(record.slug, {
    actor: KERNEL,
    type: 'runner.runtime-recorded',
    payload: { instance: 'reused', attachedSeq: b.seq, runtime: second },
  })
  await attach() // interrupted/legacy boundary
  const facts = (await readBuildFacts(store, record.slug)).value
  expect(facts.runnerAttaches.map((a) => a.runtime)).toEqual([first, second, null])
  const events = await store.getEvents(record.slug)
  let acc = buildReadFactsReducer.initial()
  for (const event of events)
    acc = buildReadFactsReducer.advance(JSON.parse(JSON.stringify(acc)), [event])
  expect(buildReadFactsReducer.finish(acc)).toEqual(buildReadFactsReducer.reduce(events))
  const now = new Date()
  const whole = detail(record, events, now)
  const cached = detailFromFacts(record, facts, now)
  expect(whole.runnerAttaches).toEqual(cached.runnerAttaches)
  expect(renderDetail(whole, now).join('\n')).toContain('runtime unrecorded')
  expect(renderDetail(whole, now).join('\n')).toContain(first.commit)
  expect((await readBuildFacts(store, record.slug)).value.runnerAttaches).toEqual(
    facts.runnerAttaches,
  )
})

test('historical lease holder runtime survives newer starts without changing standby text', async () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const store = new MemoryBuildStore({ clock: () => now })
  const repo = '/runtime-repo'
  await store.ensureRepo(repo)
  const start = (run: string) =>
    store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid: 123,
        host: 'host',
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
  const owner = await start('owner')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-recorded',
    payload: { run: 'owner', startedSeq: owner.seq, runtime: first },
  })
  await store.claimRepoLease(repo, 'owner', 60000)
  await start('newer')
  const liveness = (await readDispatcherLiveness(store, repo, now)).dispatcher
  expect(liveness.holder?.runtime).toEqual(first)
  expect(liveness.latestRun?.runtime).toBeNull()
  expect(
    (await store.getRepoStateEvents(repo)).some(
      (e) => e.type === 'dispatcher.runtime-recorded' && e.payload.run === 'owner',
    ),
  ).toBe(false)
  const resolver = new StandbyIdentityResolver(store, repo)
  expect(await resolver.refresh('self', undefined, now)).toBe(
    formatDispatcherIdentity(liveness.holder!),
  )
  expect(resolver.current('self', undefined, now)).not.toContain('runtime')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-recorded',
    payload: { run: 'newer', startedSeq: owner.seq, runtime: second },
  })
  expect((await readDispatcherLiveness(store, repo, now)).dispatcher.latestRun?.runtime).toBeNull()
})

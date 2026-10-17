import { decodeLog } from './log-index-value'
import { expect, test } from 'bun:test'
import { randomBuildLog } from './generators/build-log'
import { buildReadFactsReducer, buildStreamSeedReducer } from './read-facts'
import { buildReducer, reduceBuild } from './reducer'
import { currentDeferralObservationReducer } from './auto-merge'
import { mergeDecision } from '../cli/attention'
import { indexLog } from './log-index'
import { publicationStateReducer } from '../processes/publication-state'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts, readBuildStreamSeed } from '../store/reduced-reads'
import { KERNEL, humanActor } from '../events/envelope'

const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))

test('persisted stream seed preserves every prefix and first-eligibility order through JSON', () => {
  for (let id = 1; id <= 12; id++) {
    const events = randomBuildLog(id, 100)
    let seed = buildStreamSeedReducer.initial()
    const expected: number[] = []
    for (let i = 0; i < events.length; i++) {
      seed = buildStreamSeedReducer.advance(roundtrip(seed), [events[i]!])
      const prefix = events.slice(0, i + 1)
      const decision = mergeDecision(prefix, new Date(0))
      if (decision && !expected.includes(decision.pr.number)) expected.push(decision.pr.number)
      expect(buildReducer.finish(seed.build)).toEqual(reduceBuild(prefix))
      expect(seed.deferral).toEqual(currentDeferralObservationReducer.reduce(prefix))
      expect(seed.mergeAttentionPrs).toEqual(expected)
      const before = roundtrip(seed)
      const finished = buildStreamSeedReducer.finish(seed)
      finished.mergeAttentionPrs.push(-1)
      expect(seed).toEqual(before)
    }
  }
})

test('JSON-safe build facts reconstruct collection and publication contracts', () => {
  for (let id = 1; id <= 8; id++) {
    const events = randomBuildLog(id, 150)
    let acc = buildReadFactsReducer.initial()
    for (let i = 0; i < events.length; i += 7) {
      acc = buildReadFactsReducer.advance(roundtrip(acc), events.slice(i, i + 7))
      const prefix = events.slice(0, i + 7)
      const facts = roundtrip(buildReadFactsReducer.finish(acc))
      expect(facts.state).toEqual(roundtrip(reduceBuild(prefix)))
      expect(decodeLog(facts.log)).toEqual(indexLog(prefix))
      const publication = publicationStateReducer.finish(facts.publication)
      const oracle = publicationStateReducer.reduce(prefix)
      expect(publication.pending()).toEqual(oracle.pending())
      expect(publication.latestUncompletedRequest()).toEqual(oracle.latestUncompletedRequest())
      expect(facts.observations).toEqual(
        prefix
          .filter((event) => event.type === 'observation.recorded')
          .map((event) => event.payload),
      )
    }
  }
})

test('one persisted seed includes transient attention even when consent is armed at the boundary', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'seed', repo: 'repo' })
  await store.append('seed', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://example.test/7', headSha: 'abc' } },
  })
  await store.append('seed', {
    actor: humanActor('human'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  const current = await readBuildStreamSeed(store, 'seed')
  expect(current.value.mergeAttentionPrs).toEqual([7])
  expect(mergeDecision(await store.getEvents('seed'), new Date(0))).toBeNull()
  const facts = await readBuildFacts(store, 'seed')
  expect(facts.cursor).toBe(current.cursor)
  expect(facts.value.state).toEqual(reduceBuild(await store.getEvents('seed')))
})

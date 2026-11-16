/** `ab build status` shows the head merge consent was given at beside the
 * current candidate head (SPEC §merge policy). */
import { expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { MemoryBuildStore } from '../store/memory'
import { detail, renderDetail } from './status'

const decided = (head: string): EventWrite<'landing.decided'> => ({
  actor: DISPATCHER,
  type: 'landing.decided',
  payload: {
    candidate: { head, parent: 'base', cycle: '1' },
    from: 'leaf',
    into: { kind: 'root' },
    labels: [],
    mode: 'consent',
    rule: { default: true },
  },
})
const finalized = (headSha: string) =>
  ({
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha } },
  }) as const

async function render(build: (store: MemoryBuildStore, slug: string) => Promise<void>) {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'consent', repo: '/repo' })
  await build(store, record.slug)
  const now = new Date('2026-11-16T00:00:00Z')
  const shown = detail(record, await store.getEvents(record.slug), now)
  return { shown, lines: renderDetail(shown, now) }
}

test('a build without a merge candidate shows no merge line', async () => {
  const { lines } = await render(async () => {})
  expect(lines.some((line) => line.startsWith('  merge:'))).toBe(false)
})

test('a candidate awaiting consent shows the current head', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, decided('aaa'))
  })
  expect(lines).toContain('  merge:    no consent recorded · current head aaa')
})

test('consent given at an old head shows both heads in text and JSON', async () => {
  const { shown, lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    const decision = await store.append(slug, decided('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.land-requested',
      payload: { decisionSeq: decision.seq },
    })
    await store.append(slug, finalized('bbb'))
  })
  expect(lines).toContain('  merge:    consented at aaa · current head bbb')
  expect(shown.tree).toMatchObject({ consentedHead: 'aaa', currentHead: 'bbb' })
})

test('a hold shows held', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, decided('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
  })
  expect(lines).toContain('  merge:    held · current head aaa')
})

test('legacy consent has no recorded head', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
  })
  expect(lines).toContain('  merge:    consented (head not recorded) · current head aaa')
})

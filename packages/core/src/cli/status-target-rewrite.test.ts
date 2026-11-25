/** `ab build status` explains a `target.rewritten` wait, and names a base the
 * build's first provision adopted from a pre-existing branch (#1261). */
import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { WorkspaceBase } from '../ontology'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { detail, renderDetail } from './status'

const STALE = '8'.repeat(40)
const MAIN = '0'.repeat(40)

async function rewritten(base: WorkspaceBase | undefined) {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  const record = await store.createBuild({ slug: 'stale', repo: '/repo', branch: 'ab/stale' })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'A' }, repo: '/repo', baseBranch: 'main' },
  })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'workspace.provisioned',
    payload: {
      provider: 'git-worktree',
      ref: '/ws/ab-stale',
      remote: false,
      branch: 'ab/stale',
      base: { source: 'existing', sha: STALE },
    },
  })
  if (base !== undefined)
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'target.rewritten',
      payload: { branch: 'main', previousSha: base.sha, sha: MAIN },
    })
  const now = new Date('2026-11-25T00:00:00Z')
  const shown = detail(record, await store.getEvents(record.slug), now)
  return { shown, waiting: renderDetail(shown, now).filter((line) => line.includes('waiting:')) }
}

test('a rewrite of a base adopted from a pre-existing branch names it and says abort', async () => {
  const { shown, waiting } = await rewritten({ source: 'existing', sha: STALE })
  expect(shown.targetRewrite).toEqual({
    branch: 'main',
    previousSha: STALE,
    sha: MAIN,
    adoptedBase: { branch: 'ab/stale', sha: STALE },
  })
  expect(waiting).toHaveLength(1)
  expect(waiting[0]).toContain('pre-existing branch ab/stale')
  expect(waiting[0]).toContain(STALE.slice(0, 7))
  expect(waiting[0]).toContain('Abort it')
})

test('a rewrite of any other base is the plain withheld-adoption wait', async () => {
  const { shown, waiting } = await rewritten({ source: 'remote', sha: '9'.repeat(40) })
  expect(shown.targetRewrite?.adoptedBase).toBeUndefined()
  expect(waiting).toEqual([
    `  waiting:  target main rewritten 9999999 → 0000000; automatic adoption withheld until the target returns or the build is aborted`,
  ])
})

test('no rewrite, no wait line', async () => {
  const { shown, waiting } = await rewritten(undefined)
  expect(shown.targetRewrite).toBeUndefined()
  expect(waiting).toEqual([])
})

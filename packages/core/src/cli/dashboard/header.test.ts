import { expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../../events/envelope'
import { MemoryBuildStore } from '../../store/memory'
import { dispatchWarningLines, projectRepositoryHeader } from './header'
import { buildDashboardFromProjected } from './model'

const REPO = '/header'

async function journals() {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  const lists = [await store.getRepoEvents(REPO, 0)]
  await store.appendRepo(REPO, {
    actor: humanActor('op'),
    type: 'dispatcher.pause-set',
    payload: { enabled: true },
  })
  lists.push(await store.getRepoEvents(REPO, 0))
  await store.appendRepo(REPO, {
    actor: humanActor('op'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  const config = await store.putRepoArtifact(REPO, { kind: 'config', content: '{}' })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'r',
      pid: 1,
      roleWarnings: ['careful'],
      effectiveConfig: { kind: config.kind, rev: config.revision },
    },
  })
  lists.push(await store.getRepoEvents(REPO, 0))
  return lists
}

test('the repository header equals the terminal model members it replaces', async () => {
  for (const events of await journals()) {
    for (const input of [
      { repo: REPO, queued: 0 },
      {
        repo: REPO,
        queued: 3,
        triage: 2,
        standby: 'host-a',
        availableUpgrade: 'v2',
        warningLines: ['w'],
      },
    ]) {
      const { header } = projectRepositoryHeader(input, events)
      const model = buildDashboardFromProjected(
        [],
        { ...input, activeCount: 0, capacity: 1 },
        events,
      )
      const { active: _active, builds: _builds, ...members } = model
      expect(header).toEqual(members)
      // Same members in the same order, so serialized frames match too.
      expect(Object.keys(header)).toEqual(
        Object.keys(model).filter((key) => key !== 'active' && key !== 'builds'),
      )
    }
  }
})

test('dispatch warning lines keep role, readiness and notice order', () => {
  expect(
    dispatchWarningLines({
      run: 'r',
      health: 'running',
      roleWarnings: ['role'],
      diagnostics: [],
      warningNotice: 'notice',
      lastSeq: 1,
    }),
  ).toEqual(['role', 'notice'])
})

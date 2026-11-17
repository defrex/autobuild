import { expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { MemoryBuildStore } from '../store/memory'
import { hookProgressKind } from '../store/retention'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'
import { readRepositoryFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import { readRepositoryHooks, renderHookStatus } from './repository-status'

const REPO = '/main/repo'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[hooks.notify]
command = "./notify.sh"

[hooks.audit]
command = "cat >> audit.log"
events = ["escalation.*"]

[hooks.relay]
url = "https://hooks.example/autobuild"
secretEnv = "RELAY_SECRET"
`)

async function storeWithRun(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  await store.appendRepoWithArtifacts(
    REPO,
    [
      {
        kind: 'dispatcher-effective-config',
        content: effectiveBuildConfigContent(config),
        metadata: { run: 'r1' },
      },
    ],
    (deposited) => ({
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'r1',
        pid: 1,
        host: 'h',
        effectiveConfig: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        roleWarnings: [],
      },
    }),
  )
  return store
}

test('repository status lists each configured hook with its delivery progress', async () => {
  const store = await storeWithRun()
  await store.putRepoArtifact(REPO, {
    kind: hookProgressKind('notify'),
    content: JSON.stringify({
      v: 1,
      hook: 'notify',
      position: 'v1.x',
      delivered: 4,
      lastSuccessAt: '2026-11-17T10:00:00.000Z',
      lastDeliveredId: 'repo:9',
      pending: 2,
      failing: {
        since: '2026-11-17T10:01:00.000Z',
        attempts: 3,
        error: 'exit status 1',
        reported: false,
      },
      updatedAt: '2026-11-17T10:02:00.000Z',
    }),
  })
  const hooks = await readRepositoryHooks(
    store,
    REPO,
    (await readRepositoryFacts(store, REPO)).value,
  )
  expect(hooks).toEqual([
    {
      name: 'notify',
      command: './notify.sh',
      url: null,
      lastSuccessAt: '2026-11-17T10:00:00.000Z',
      backlog: 2,
      caughtUp: false,
      failing: {
        since: '2026-11-17T10:01:00.000Z',
        attempts: 3,
        error: 'exit status 1',
        reported: false,
      },
      updatedAt: '2026-11-17T10:02:00.000Z',
    },
    {
      name: 'audit',
      command: 'cat >> audit.log',
      url: null,
      lastSuccessAt: null,
      backlog: 0,
      caughtUp: true,
      failing: null,
      updatedAt: null,
    },
    {
      name: 'relay',
      command: null,
      url: 'https://hooks.example/autobuild',
      lastSuccessAt: null,
      backlog: 0,
      caughtUp: true,
      failing: null,
      updatedAt: null,
    },
  ])
  expect(hooks.map(renderHookStatus)).toEqual([
    'hook notify — last delivered 2026-11-17T10:00:00.000Z — 2 pending — failing since 2026-11-17T10:01:00.000Z: exit status 1',
    'hook audit — last delivered never — caught up',
    'hook relay — last delivered never — caught up',
  ])
})

test('no run or no hooks lists none', async () => {
  const empty = new MemoryBuildStore()
  await empty.ensureRepo(REPO)
  expect(
    await readRepositoryHooks(empty, REPO, (await readRepositoryFacts(empty, REPO)).value),
  ).toEqual([])
})

import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { harvestStartedWrite, sampleBuildInput, sampleEventWrite } from './contract'
import { MemoryBuildStore } from './memory'
import { scopeLocalStoreToSession, SessionScopeError } from './session-scope'
import type { BuildStore } from './types'

const REPO = 'acme/project'
const OTHER_REPO = 'other/project'
const BUILD = 'build-a'
const OTHER_BUILD = 'build-b'
const SESSION = 's_ambient'

async function seeded(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore()
  await store.createBuild({ ...sampleBuildInput(BUILD), repo: REPO })
  await store.createBuild({ ...sampleBuildInput(OTHER_BUILD), repo: REPO })
  await store.ensureRepo(REPO)
  await store.ensureRepo(OTHER_REPO)
  return store
}

function proposalWrite(
  session: string,
  rev = 0,
): RepositoryEventWrite<'harvest.proposals.submitted'> {
  return {
    actor: agentActor('harvest', session),
    type: 'harvest.proposals.submitted',
    payload: {
      run: 'h_1',
      round: 1,
      artifact: { kind: 'harvest-proposals', rev },
    },
  }
}

async function authorityError(run: () => unknown | Promise<unknown>): Promise<SessionScopeError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(SessionScopeError)
    return error as SessionScopeError
  }
  throw new Error('expected a SessionScopeError')
}

describe('local build-session scope', () => {
  test('allows every exact-build data operation and trusted kernel writes', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'build',
      id: BUILD,
      session: SESSION,
    })

    expect((await store.getBuild(BUILD))?.slug).toBe(BUILD)
    expect(await store.getEvents(BUILD)).toEqual([])
    expect((await store.putArtifact(BUILD, { kind: 'notes', content: 'one' })).revision).toBe(0)
    expect((await store.getArtifact(BUILD, 'notes'))?.content).toEqual(
      new TextEncoder().encode('one'),
    )
    expect(await store.listArtifacts(BUILD, 'notes')).toHaveLength(1)

    expect(await store.claimLease(BUILD, 'holder', 1_000)).toBe(true)
    expect(await store.heartbeat(BUILD, 'holder')).toBe(true)
    await store.releaseLease(BUILD, 'holder')

    const mine = await store.append(BUILD, {
      ...sampleEventWrite('mine'),
      actor: agentActor('implement', SESSION),
    })
    expect(mine.seq).toBe(1)
    expect(
      await store.appendIfCurrent(BUILD, 1, {
        ...sampleEventWrite('conditional'),
        actor: agentActor('implement', SESSION),
      }),
    ).toMatchObject({ seq: 2 })
    expect(
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'implement.started',
        payload: { round: 1 },
      }),
    ).toMatchObject({ seq: 3, actor: KERNEL })
    const kernelDeposit = await store.appendWithArtifacts(
      BUILD,
      [{ kind: 'kernel-note', content: 'trusted plumbing' }],
      () => ({
        actor: KERNEL,
        type: 'observation.recorded',
        payload: { id: 'o_kernel', kind: 'followup', summary: 'kernel follow-up' },
      }),
    )
    expect(kernelDeposit.event.actor).toEqual(KERNEL)
    expect(kernelDeposit.artifacts[0]?.revision).toBe(0)

    const received: number[] = []
    const unsubscribe = store.subscribe(BUILD, { pollMs: 5 }, (event) => received.push(event.seq))
    unsubscribe()

    expect(store.scopeBuild(BUILD)).toBe(store)
    await store.close()
  })

  test('rejects foreign, repository, collection, and admin access', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'build',
      id: BUILD,
      session: SESSION,
    })

    const foreignBuildCalls: Array<() => unknown | Promise<unknown>> = [
      () => store.getBuild(OTHER_BUILD),
      () => store.append(OTHER_BUILD, sampleEventWrite()),
      () => store.appendIfCurrent(OTHER_BUILD, 0, sampleEventWrite()),
      () => store.appendWithArtifacts(OTHER_BUILD, [], () => sampleEventWrite()),
      () => store.getEvents(OTHER_BUILD),
      () => store.putArtifact(OTHER_BUILD, { kind: 'x', content: 'x' }),
      () => store.getArtifact(OTHER_BUILD, 'x'),
      () => store.listArtifacts(OTHER_BUILD),
      () => store.claimLease(OTHER_BUILD, 'h', 1_000),
      () => store.heartbeat(OTHER_BUILD, 'h'),
      () => store.releaseLease(OTHER_BUILD, 'h'),
      () => store.scopeBuild(OTHER_BUILD),
    ]
    for (const call of foreignBuildCalls) await authorityError(call)
    expect(() => store.subscribe(OTHER_BUILD, {}, () => {})).toThrow(SessionScopeError)

    const repositoryCalls: Array<() => unknown | Promise<unknown>> = [
      () => store.ensureRepo(REPO),
      () => store.getRepo(REPO),
      () => store.appendRepo(REPO, harvestStartedWrite()),
      () => store.appendRepoWithArtifacts(REPO, [], () => harvestStartedWrite()),
      () => store.getRepoEvents(REPO),
      () => store.putRepoArtifact(REPO, { kind: 'x', content: 'x' }),
      () => store.getRepoArtifact(REPO, 'x'),
      () => store.listRepoArtifacts(REPO),
      () => store.claimRepoLease(REPO, 'h', 1_000),
      () => store.heartbeatRepo(REPO, 'h'),
      () => store.releaseRepoLease(REPO, 'h'),
    ]
    for (const call of repositoryCalls) await authorityError(call)
    await authorityError(() => store.createBuild(sampleBuildInput('new')))
    await authorityError(() => store.listBuilds())

    expect(await underlying.getEvents(OTHER_BUILD)).toEqual([])
    expect(await underlying.getRepoEvents(REPO)).toEqual([])
    await store.close()
  })

  test('rejects another agent session before direct, conditional, or atomic mutation', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'build',
      id: BUILD,
      session: SESSION,
    })
    const forged = {
      ...sampleEventWrite('forged'),
      actor: agentActor('implement', 's_other'),
    }

    await authorityError(() => store.append(BUILD, forged))
    await authorityError(() => store.appendIfCurrent(BUILD, 0, forged))
    await authorityError(() =>
      store.appendWithArtifacts(BUILD, [{ kind: 'plan', content: 'not visible' }], (deposited) => ({
        actor: agentActor('plan', 's_other'),
        type: 'plan.completed',
        payload: { round: 1, artifact: { kind: 'plan', rev: deposited[0]!.revision } },
      })),
    )

    expect(await underlying.getEvents(BUILD)).toEqual([])
    expect(await underlying.listArtifacts(BUILD, 'plan')).toEqual([])
    await store.close()
  })
})

describe('local Harvest-session scope', () => {
  test('allows every exact-repository operation, same-session events, and kernel plumbing', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'repo',
      id: REPO,
      session: SESSION,
    })

    expect((await store.getRepo(REPO))?.repo).toBe(REPO)
    expect(await store.getRepoEvents(REPO)).toEqual([])
    expect((await store.putRepoArtifact(REPO, { kind: 'scan', content: 'scan' })).revision).toBe(0)
    expect((await store.getRepoArtifact(REPO, 'scan'))?.content).toEqual(
      new TextEncoder().encode('scan'),
    )
    expect(await store.listRepoArtifacts(REPO, 'scan')).toHaveLength(1)
    expect(await store.claimRepoLease(REPO, 'harvest-holder', 1_000)).toBe(true)
    expect(await store.heartbeatRepo(REPO, 'harvest-holder')).toBe(true)
    await store.releaseRepoLease(REPO, 'harvest-holder')

    expect(await store.appendRepo(REPO, proposalWrite(SESSION))).toMatchObject({ seq: 1 })
    expect(await store.appendRepo(REPO, harvestStartedWrite('h_kernel'))).toMatchObject({
      seq: 2,
      actor: KERNEL,
    })
    const deposited = await store.appendRepoWithArtifacts(
      REPO,
      [{ kind: 'kernel-scan', content: '{}' }],
      (artifacts) => harvestStartedWrite('h_deposit', artifacts[0]!.revision),
    )
    expect(deposited.event.actor).toEqual(KERNEL)
    expect(deposited.artifacts).toHaveLength(1)
    await store.close()
  })

  test('rejects build, foreign-repository, and repository-admin access', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'repo',
      id: REPO,
      session: SESSION,
    })

    const buildCalls: Array<() => unknown | Promise<unknown>> = [
      () => store.getBuild(BUILD),
      () => store.append(BUILD, sampleEventWrite()),
      () => store.appendIfCurrent(BUILD, 0, sampleEventWrite()),
      () => store.appendWithArtifacts(BUILD, [], () => sampleEventWrite()),
      () => store.getEvents(BUILD),
      () => store.putArtifact(BUILD, { kind: 'x', content: 'x' }),
      () => store.getArtifact(BUILD, 'x'),
      () => store.listArtifacts(BUILD),
      () => store.claimLease(BUILD, 'h', 1_000),
      () => store.heartbeat(BUILD, 'h'),
      () => store.releaseLease(BUILD, 'h'),
      () => store.scopeBuild(BUILD),
    ]
    for (const call of buildCalls) await authorityError(call)
    expect(() => store.subscribe(BUILD, {}, () => {})).toThrow(SessionScopeError)

    const foreignRepoCalls: Array<() => unknown | Promise<unknown>> = [
      () => store.getRepo(OTHER_REPO),
      () => store.appendRepo(OTHER_REPO, harvestStartedWrite()),
      () => store.appendRepoWithArtifacts(OTHER_REPO, [], () => harvestStartedWrite()),
      () => store.getRepoEvents(OTHER_REPO),
      () => store.putRepoArtifact(OTHER_REPO, { kind: 'x', content: 'x' }),
      () => store.getRepoArtifact(OTHER_REPO, 'x'),
      () => store.listRepoArtifacts(OTHER_REPO),
      () => store.claimRepoLease(OTHER_REPO, 'h', 1_000),
      () => store.heartbeatRepo(OTHER_REPO, 'h'),
      () => store.releaseRepoLease(OTHER_REPO, 'h'),
    ]
    for (const call of foreignRepoCalls) await authorityError(call)
    await authorityError(() => store.ensureRepo(REPO))
    await authorityError(() => store.createBuild(sampleBuildInput('new')))
    await authorityError(() => store.listBuilds())
    await store.close()
  })

  test('rejects wrong-session direct and atomic writes without durable mutation', async () => {
    const underlying = await seeded()
    const store = scopeLocalStoreToSession(underlying, {
      kind: 'repo',
      id: REPO,
      session: SESSION,
    })

    await authorityError(() => store.appendRepo(REPO, proposalWrite('s_other')))
    await authorityError(() =>
      store.appendRepoWithArtifacts(
        REPO,
        [{ kind: 'harvest-proposals', content: '{}' }],
        (deposited) => proposalWrite('s_other', deposited[0]!.revision),
      ),
    )

    expect(await underlying.getRepoEvents(REPO)).toEqual([])
    expect(await underlying.listRepoArtifacts(REPO, 'harvest-proposals')).toEqual([])
    await store.close()
  })
})

// Compile-time assertion: the wrapper retains the complete Store surface used
// by phase CLI composition rather than exposing a narrowed test-only facade.
const _buildStore: (store: BuildStore) => BuildStore = (store) =>
  scopeLocalStoreToSession(store, { kind: 'build', id: BUILD, session: SESSION })
void _buildStore

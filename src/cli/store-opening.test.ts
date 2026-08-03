import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentActor, humanActor, KERNEL } from '../events/envelope'
import { FakeForge } from '../ports/forge/fake'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'
import { RemoteBuildStore } from '../store/remote/client'
import { SessionScopeError } from '../store/session-scope'
import { buildCreatedWrite, sampleEventWrite } from '../store/contract'
import type { CliEnv, HarvestCliEnv } from './env'
import { done } from './terminals'
import { openProductionSessionStore, openProductionStore } from './store-opening'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-session-store-'))
  dirs.push(root)
  return root
}

function buildEnv(store: string, build = 'build-a', session = 's_build'): CliEnv {
  return {
    store,
    build,
    phase: 'implement',
    round: 1,
    session,
  }
}

function harvestEnv(store: string, repo = 'acme/project', session = 's_harvest'): HarvestCliEnv {
  return {
    store,
    repo,
    run: 'h_1',
    phase: 'synthesize',
    round: 1,
    session,
  }
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return run().catch((error: unknown) => error)
}

describe('openProductionSessionStore', () => {
  test('opens a real local build handle with ambient resource and session authority', async () => {
    const root = tempRoot()
    const seed = openLocalStore(root)
    await seed.createBuild({ slug: 'build-a', repo: 'acme/project' })
    await seed.createBuild({ slug: 'build-b', repo: 'acme/project' })
    await seed.ensureRepo('acme/project')

    const store = openProductionSessionStore(buildEnv(root))
    try {
      expect((await store.getBuild('build-a'))?.slug).toBe('build-a')
      expect(
        await store.append('build-a', {
          ...sampleEventWrite('same build and session'),
          actor: agentActor('implement', 's_build'),
        }),
      ).toMatchObject({ seq: 1 })
      expect(await caught(() => store.getBuild('build-b'))).toBeInstanceOf(SessionScopeError)
      expect(await caught(() => store.getRepo('acme/project'))).toBeInstanceOf(SessionScopeError)
      expect(
        await caught(() =>
          store.append('build-a', {
            ...sampleEventWrite('forged session'),
            actor: agentActor('implement', 's_other'),
          }),
        ),
      ).toBeInstanceOf(SessionScopeError)
      expect(await seed.getEvents('build-b')).toEqual([])
      expect(await seed.getRepoEvents('acme/project')).toEqual([])
    } finally {
      await store.close()
      await seed.close()
    }
  })

  test('opens a real local Harvest handle with ambient repository and session authority', async () => {
    const root = tempRoot()
    const seed = openLocalStore(root)
    await seed.ensureRepo('acme/project')
    await seed.ensureRepo('other/project')
    await seed.createBuild({ slug: 'build-a', repo: 'acme/project' })

    const store = openProductionSessionStore(harvestEnv(root))
    try {
      expect((await store.getRepo('acme/project'))?.repo).toBe('acme/project')
      expect(
        await store.appendRepo('acme/project', {
          actor: agentActor('harvest', 's_harvest'),
          type: 'harvest.proposals.submitted',
          payload: {
            run: 'h_1',
            round: 1,
            artifact: { kind: 'harvest-proposals', rev: 0 },
          },
        }),
      ).toMatchObject({ seq: 1 })
      expect(await caught(() => store.getRepo('other/project'))).toBeInstanceOf(SessionScopeError)
      expect(await caught(() => store.getBuild('build-a'))).toBeInstanceOf(SessionScopeError)
      expect(
        await caught(() =>
          store.appendRepo('acme/project', {
            actor: agentActor('harvest', 's_other'),
            type: 'harvest.proposals.submitted',
            payload: {
              run: 'h_1',
              round: 2,
              artifact: { kind: 'harvest-proposals', rev: 1 },
            },
          }),
        ),
      ).toBeInstanceOf(SessionScopeError)
      expect(await seed.getEvents('build-a')).toEqual([])
      expect(await seed.getRepoEvents('other/project')).toEqual([])
    } finally {
      await store.close()
      await seed.close()
    }
  })

  test('leaves remote token composition and the generic local opener unchanged', async () => {
    const remote = openProductionSessionStore({
      ...buildEnv('https://store.example.test', 'build-a', 's_remote'),
      token: 'token-byte-for-byte',
    })
    expect(remote).toBeInstanceOf(RemoteBuildStore)
    await remote.close()

    const root = tempRoot()
    const generic = openProductionStore(root)
    try {
      await generic.createBuild({ slug: 'operator-a', repo: 'acme/project' })
      await generic.createBuild({ slug: 'operator-b', repo: 'other/project' })
      await generic.ensureRepo('acme/project')
      expect((await generic.listBuilds()).map((build) => build.slug)).toEqual([
        'operator-a',
        'operator-b',
      ])
      expect((await generic.getRepo('acme/project'))?.repo).toBe('acme/project')
    } finally {
      await generic.close()
    }
  })

  test('supports finalize done kernel plumbing through the production-scoped local handle', async () => {
    const workspace = tempRoot()
    const storeRoot = join(workspace, 'store')
    await Bun.$`git init -q ${workspace}`
    const seed = openLocalStore(storeRoot)
    await seed.createBuild({
      slug: 'finalize-build',
      repo: workspace,
      branch: 'ab/finalize-build',
    })
    await seed.append('finalize-build', buildCreatedWrite())
    await seed.append('finalize-build', {
      actor: KERNEL,
      type: 'finalize.started',
      payload: {},
    })
    const command = await seed.append('finalize-build', {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await seed.putArtifact('finalize-build', {
      kind: 'pr-description',
      content: '# Scoped finalize\n\nThe body.\n',
    })

    const env: CliEnv = {
      store: storeRoot,
      build: 'finalize-build',
      phase: 'finalize',
      round: 1,
      session: 's_finalize',
    }
    const store = openProductionSessionStore(env)
    const forge = new FakeForge()
    try {
      const terminal = await done({
        store,
        env,
        workspacePath: workspace,
        forge,
        exec: spawnExec,
        ids: (prefix) => `${prefix}_scoped`,
      })
      expect(terminal).toMatchObject({
        actor: KERNEL,
        type: 'finalize.completed',
      })
      expect(forge.opened).toHaveLength(1)
      expect(forge.autoMergeCalls).toHaveLength(1)
    } finally {
      await store.close()
    }

    const events = await seed.getEvents('finalize-build')
    expect(events.map((event) => event.type)).toContain('finalize.completed')
    expect(events).toContainEqual(
      expect.objectContaining({
        actor: KERNEL,
        type: 'pr.auto-merge-enabled',
        payload: { commandSeq: command.seq },
      }),
    )
    await seed.close()
  })
})

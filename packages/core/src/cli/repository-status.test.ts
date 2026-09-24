import { describe, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { describeStoreOpeningContract } from './store-opening.contract'
import {
  abRepositoryStatus,
  projectRepositoryStatus,
  renderRepositoryStatus,
  type RepositoryStatusOpts,
} from './repository-status'

const REPO = '/main/repo'
const noGit: Exec = async () => ({ stdout: '', stderr: 'not a git repository', exitCode: 128 })

function options(
  store: BuildStore,
  overrides: Partial<RepositoryStatusOpts> = {},
): RepositoryStatusOpts & { output: string[] } {
  const output: string[] = []
  return {
    targetRepo: REPO,
    env: {},
    exec: noGit,
    stdout: (line) => output.push(line),
    openStore: () => store,
    output,
    ...overrides,
  }
}

async function appendSetting(
  store: BuildStore,
  type: 'dispatcher.intake-set' | 'dispatcher.pause-set' | 'dispatcher.auto-merge-default-set',
  enabled: boolean,
): Promise<void> {
  await store.appendRepo(REPO, {
    actor: humanActor('operator'),
    type,
    payload: { enabled },
  })
}

describe('ab repository status', () => {
  test('projects reducer-owned defaults without creating a repository stream', async () => {
    const store = new MemoryBuildStore()
    let getRepoStateEvents = 0
    const readOnly = new Proxy(store, {
      get(target, property) {
        if (property === 'getRepoStateEvents') {
          return async (...args: Parameters<BuildStore['getRepoStateEvents']>) => {
            getRepoStateEvents += 1
            return target.getRepoStateEvents(...args)
          }
        }
        if (property === 'getRepo' || property === 'close') {
          const value = Reflect.get(target, property, target) as (...args: unknown[]) => unknown
          return value.bind(target)
        }
        const value = Reflect.get(target, property, target) as unknown
        if (typeof value === 'function') {
          return () => {
            throw new Error(`unexpected store operation ${String(property)}`)
          }
        }
        return value
      },
    }) as unknown as BuildStore
    const opts = options(readOnly, { json: true })

    await abRepositoryStatus(opts)

    expect(JSON.parse(opts.output.join('\n'))).toEqual({
      repo: REPO,
      intake: true,
      paused: false,
      defaultAutoMerge: false,
      sandboxes: [],
      publications: [],
    })
    expect(getRepoStateEvents).toBe(0)
    expect(await store.getRepo(REPO)).toBeNull()
  })

  test('reports paused and unpaused journals through the same reducer projection', async () => {
    for (const paused of [false, true]) {
      const store = new MemoryBuildStore()
      await store.ensureRepo(REPO)
      await appendSetting(store, 'dispatcher.pause-set', !paused)
      await appendSetting(store, 'dispatcher.intake-set', false)
      await appendSetting(store, 'dispatcher.auto-merge-default-set', true)
      await appendSetting(store, 'dispatcher.pause-set', paused)
      const before = await store.getRepoEvents(REPO)
      const opts = options(store, { json: true })

      await abRepositoryStatus(opts)

      expect(JSON.parse(opts.output.join('\n'))).toEqual({
        repo: REPO,
        intake: false,
        paused,
        defaultAutoMerge: true,
        sandboxes: [],
        publications: [],
      })
      expect(await store.getRepoEvents(REPO)).toEqual(before)
    }
  })

  test('human output labels the repository and every dispatcher setting', () => {
    const status = projectRepositoryStatus(REPO, [])
    expect(renderRepositoryStatus(status)).toEqual([
      `repository: ${REPO}`,
      'intake: ON',
      'repository pause: OFF',
      'default auto-merge: OFF',
    ])
  })

  test('operator sandboxes project from the journal; released environments are omitted', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.provisioned',
      payload: {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        provider: 'vercel-sandbox',
        workspacePath: '/vercel/sandbox/workspace',
      },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('other'),
      type: 'orchestrator.sandbox.provisioned',
      payload: {
        operator: 'other',
        environmentId: 'autobuild-sandbox-def456',
        provider: 'git-worktree',
        workspacePath: '/state/orchestrator-sandboxes/def456',
      },
    })
    await store.appendRepo(REPO, {
      actor: { kind: 'dispatcher' },
      type: 'orchestrator.sandbox.stopped',
      payload: { operator: 'other', environmentId: 'autobuild-sandbox-def456', reason: 'idle' },
    })
    const status = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(status.sandboxes).toEqual([
      {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        provider: 'vercel-sandbox',
        state: 'live',
        lastEvidenceAt: expect.any(String),
      },
      {
        operator: 'other',
        environmentId: 'autobuild-sandbox-def456',
        provider: 'git-worktree',
        state: 'stopped',
        lastEvidenceAt: expect.any(String),
      },
    ])
    const lines = renderRepositoryStatus(status)
    expect(lines).toContain(
      'operator sandbox autobuild-sandbox-abc123 (vercel-sandbox) — live, idle since ' +
        status.sandboxes[0]!.lastEvidenceAt,
    )
    await store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.released',
      payload: {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        snapshots: { outcome: 'confirmed' },
      },
    })
    const after = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(after.sandboxes.map((sandbox) => sandbox.operator)).toEqual(['other'])
  })

  test('the query leaves repository events and unrelated build state unchanged', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await appendSetting(store, 'dispatcher.pause-set', true)
    await store.createBuild({ slug: 'unrelated', repo: REPO })
    const beforeEvents = await store.getRepoEvents(REPO)
    const beforeBuilds = await store.listBuilds()
    const opts = options(store)

    await abRepositoryStatus(opts)

    expect(opts.output).toContain('repository pause: ON')
    expect(await store.getRepoEvents(REPO)).toEqual(beforeEvents)
    expect(await store.listBuilds()).toEqual(beforeBuilds)
  })
})

describeStoreOpeningContract('ab repository status', {
  run: (opts) => abRepositoryStatus({ ...opts, json: true }),
  canonicalMarker: (stdout) => (JSON.parse(stdout.join('\n')) as { repo?: string }).repo,
  expectedCanonicalMarker: REPO,
})

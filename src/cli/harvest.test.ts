import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL } from '../events/envelope'
import { sequentialIds } from '../ids'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import type { HarvestCliEnv } from './env'
import {
  buildHarvestContext,
  projectHarvestStatus,
  submitHarvestProposals,
  submitHarvestVerdict,
} from './harvest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'ab-harvest-cli-'))
  roots.push(workspacePath)
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo('/repo')
  const packet = {
    repo: '/repo',
    run: 'h_1',
    observations: [
      {
        occurrence: { build: 'build-a', seq: 4 },
        id: 'obs-1',
        kind: 'latent-bug' as const,
        summary: 'bug',
        ts: '2026-07-15T00:00:00.000Z',
      },
    ],
    ledger: [],
  }
  await store.appendRepoWithArtifacts(
    '/repo',
    [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_1',
        observations: [{ build: 'build-a', seq: 4 }],
        scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
      },
    }),
  )
  const env: HarvestCliEnv = {
    store: 'local',
    repo: '/repo',
    run: 'h_1',
    phase: 'synthesize',
    round: 1,
    session: 'hs_1',
  }
  return { store, workspacePath, env, ids: sequentialIds() }
}

describe('harvest CLI', () => {
  test('context scopes inputs; submit enforces coverage; reviewer deposits typed verdict', async () => {
    const deps = await fixture()
    const manifest = await buildHarvestContext(deps)
    expect(manifest.allowedTerminal).toBe('submit')
    expect(
      JSON.parse(await readFile(join(deps.workspacePath, '.ab', 'observations.json'), 'utf8')),
    ).toHaveLength(1)

    const bad = join(deps.workspacePath, 'bad.json')
    await writeFile(bad, JSON.stringify({ proposals: [{ action: 'suppress', reason: 'x', observations: [{ build: 'other', seq: 1 }] }] }))
    await expect(submitHarvestProposals(deps, bad)).rejects.toThrow(
      /cover every claimed observation exactly once/,
    )

    const good = join(deps.workspacePath, 'good.json')
    await writeFile(
      good,
      JSON.stringify({
        proposals: [
          {
            action: 'create',
            title: 'Bug',
            whatWhy: 'Users encounter the recorded bug.',
            acceptanceCriteria: ['The bug is fixed.'],
            outOfScope: ['Other behavior.'],
            observations: [{ build: 'build-a', seq: 4 }],
          },
        ],
      }),
    )
    const submitted = await submitHarvestProposals(deps, good)
    expect(submitted.type).toBe('harvest.proposals.submitted')
    await expect(submitHarvestProposals(deps, good)).rejects.toThrow(
      /second harvest terminal/,
    )

    const reviewDeps = {
      ...deps,
      env: { ...deps.env, phase: 'review' as const, session: 'hs_2' },
    }
    const reviewContext = await buildHarvestContext(reviewDeps)
    expect(reviewContext.allowedTerminal).toBe('verdict')
    const notes = join(deps.workspacePath, 'review.md')
    await writeFile(notes, 'approved')
    const verdict = await submitHarvestVerdict(reviewDeps, {
      verdict: 'approve',
      notes,
    })
    expect(verdict.payload.verdict).toBe('approve')

    const view = projectHarvestStatus('/repo', await deps.store.getRepoEvents('/repo'))
    expect(view.run).toBe('h_1')
    expect(view.rounds).toBe(1)
  })
})

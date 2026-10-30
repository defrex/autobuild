import { leafRestackLog } from '../kernel/generators/leaf-restack-log'
import { prepareAssetSnapshots } from '../store/ticket-asset-snapshots'
/**
 * `ab context` materializer tests (SPEC §8.3): the exact `.ab/` tree per
 * PHASE_SPECS.inputs for all seven phase shapes, against a seeded
 * MemoryBuildStore in a temp workspace. Assertions cover the manifest, key
 * file bodies, and the wipe-on-every-run rule.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import type { IdSource } from '../ids'
import type { Feedback, Finding } from '../ontology'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { MemoryBuildStore } from '../store/memory'
import { buildContext as hydrateContext } from './context'
let activeContext = '.ab/plan'
async function buildContext(deps: Parameters<typeof hydrateContext>[0]) {
  const result = await hydrateContext(deps)
  activeContext = result.contextDir
  return result
}
import { BUILD, makeEnv, seedStore } from './testkit'

let workspace: string
let store: MemoryBuildStore

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ab-context-'))
  store = await seedStore()
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await store.close()
})

const agent = (role: string) => agentActor(role, 's_seed')

function finding(id: string, persists: string[] = []): Finding {
  return { id, severity: 'blocking', summary: `finding ${id}`, persists }
}

async function treeOf(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...(await treeOf(join(dir, entry.name), rel)))
    } else {
      out.push(rel)
    }
  }
  return out.sort()
}

async function abFile(relPath: string): Promise<string> {
  return readFile(
    join(workspace, relPath === '.gitignore' ? '.ab' : activeContext, relPath),
    'utf8',
  )
}

async function seedPlanApproved(): Promise<void> {
  await store.putArtifact(BUILD, { kind: 'plan', content: '# Plan v1\n' })
  await store.append(BUILD, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await store.append(BUILD, {
    actor: agent('plan'),
    type: 'plan.completed',
    payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
  })
  await store.append(BUILD, {
    actor: agent('plan-review'),
    type: 'plan-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    },
  })
}

async function seedImplementRound(round: number, head: string, feedback?: Feedback): Promise<void> {
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round, ...(feedback !== undefined ? { feedback } : {}) },
  })
  await store.putArtifact(BUILD, {
    kind: 'implement-notes',
    content: `notes r${round}\n`,
  })
  await store.append(BUILD, {
    actor: agent('implement'),
    type: 'implement.completed',
    payload: {
      round,
      commits: { base: 'sha-base', head },
      artifact: { kind: 'implement-notes', rev: round - 1 },
    },
  })
}

describe('buildContext — plan (§8.3: ticket, spec; prior plan + findings on round > 1)', () => {
  test('round 1 materializes exactly ticket.md and spec.md', async () => {
    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'spec.md',
      'ticket.md',
    ])
    expect(manifest.required).toEqual(['plan'])
    expect(manifest.allowedTerminals).toEqual(['done', 'escalate'])
    expect(manifest.materialized).toEqual({
      'spec.md': { kind: 'spec', rev: 0 },
      'ticket.md': 'derived',
    })
    expect(manifest.feedback).toBeUndefined()

    const ticket = await abFile('ticket.md')
    expect(ticket).toContain('- source: linear')
    expect(ticket).toContain('- id: ENG-42')
    expect(ticket).toContain('- url: https://linear.app/acme/issue/ENG-42')
    expect(ticket).toContain('- title: Auth rate limiting')
    expect(await abFile('spec.md')).toBe('# Spec: auth rate limiting\n')
  })

  test('round 2 adds the prior plan rev and the review findings as feedback', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: '# Plan v1\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    await store.append(BUILD, {
      actor: agent('plan-review'),
      type: 'plan-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_1')],
        artifact: { kind: 'plan-review', rev: 0 },
      },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 2 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'findings.json',
      'plan.md',
      'spec.md',
      'ticket.md',
    ])
    expect(manifest.feedback).toEqual({ findings: ['f_1'] })
    expect(manifest.materialized['plan.md']).toEqual({ kind: 'plan', rev: 0 })
    expect(manifest.materialized['findings.json']).toBe('derived')
    // Ids resolve to the FULL finding objects from the verdict that produced
    // them (§8.3) — round N+1's prompt assembles deterministically (§10).
    expect(JSON.parse(await abFile('findings.json'))).toEqual([finding('f_1')])
    expect(await abFile('plan.md')).toBe('# Plan v1\n')
  })

  test('guidance carried by plan.started lands as guidance.json (§15.6-B delivery)', async () => {
    // Regression: a parked plan loop re-attaches with a FRESH session, so the
    // continue-message never runs — `ab context` is the only carrier of the
    // human's answer, and it used to materialize nothing for plan guidance.
    await store.putArtifact(BUILD, { kind: 'plan', content: '# Plan v1\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'plan.started',
      payload: {
        round: 2,
        feedback: { guidance: { escalation: 'esc_1', answer: 'Only the API surface.' } },
      },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 2 }),
      workspacePath: workspace,
    })

    expect(manifest.feedback).toEqual({
      guidance: { escalation: 'esc_1', answer: 'Only the API surface.' },
    })
    expect(manifest.materialized['guidance.json']).toBe('derived')
    expect(JSON.parse(await abFile('guidance.json'))).toEqual({
      escalation: 'esc_1',
      answer: 'Only the API surface.',
    })
  })
})

describe('buildContext — plan-review (§8.3: spec, plan@latest, all prior rounds)', () => {
  test('round 2 gets plan@latest, per-round history, and dismissed ids in the manifest', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: '# Plan v1\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    await store.append(BUILD, {
      actor: agent('plan-review'),
      type: 'plan-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_1'), finding('f_2')],
        artifact: { kind: 'plan-review', rev: 0 },
      },
    })
    await store.putArtifact(BUILD, { kind: 'plan', content: '# Plan v2\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 2, artifact: { kind: 'plan', rev: 1 } },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan-review', round: 2 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'history/findings-r1.json',
      'plan.md',
      'spec.md',
    ])
    expect(manifest.required).toEqual(['plan-review'])
    expect(manifest.allowedTerminals).toEqual(['verdict', 'escalate'])
    // Latest rev IS the round-2 plan under review.
    expect(manifest.materialized['plan.md']).toEqual({ kind: 'plan', rev: 1 })
    expect(await abFile('plan.md')).toBe('# Plan v2\n')
    expect(JSON.parse(await abFile('history/findings-r1.json'))).toEqual([
      finding('f_1'),
      finding('f_2'),
    ])
    // No dismissals yet — but the reviewer is told so explicitly (§15.6-B).
    expect(manifest.dismissedFindingIds).toEqual([])
  })
})

describe('buildContext — implement (§8.3: feedback is findings OR verify report OR guidance)', () => {
  test('findings feedback: full objects in findings.json plus own prior notes', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: agent('code-review'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_1')],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 2, feedback: { findings: ['f_1'] } },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 2 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'findings.json',
      'implement-notes.md',
      'plan.md',
      'spec.md',
    ])
    expect(manifest.feedback).toEqual({ findings: ['f_1'] })
    expect(JSON.parse(await abFile('findings.json'))).toEqual([finding('f_1')])
    // Own prior-round notes (§8.3), latest rev.
    expect(await abFile('implement-notes.md')).toBe('notes r1\n')
    expect(manifest.materialized['implement-notes.md']).toEqual({
      kind: 'implement-notes',
      rev: 0,
    })
  })

  test('verify-failure feedback: the cited report rev lands under $AB_CONTEXT_DIR/verify/', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.putArtifact(BUILD, {
      kind: 'verify-report:e2e',
      content: 'e2e failed: login times out\n',
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: {
        step: 'e2e',
        attempt: 1,
        pass: false,
        report: { kind: 'verify-report:e2e', rev: 0 },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: {
        round: 2,
        feedback: { verify: { step: 'e2e', report: { kind: 'verify-report:e2e', rev: 0 } } },
      },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 2 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'implement-notes.md',
      'plan.md',
      'spec.md',
      'verify/e2e.md',
    ])
    expect(manifest.feedback).toEqual({
      verify: { step: 'e2e', report: { kind: 'verify-report:e2e', rev: 0 } },
    })
    expect(await abFile('verify/e2e.md')).toBe('e2e failed: login times out\n')
    expect(manifest.materialized['verify/e2e.md']).toEqual({
      kind: 'verify-report:e2e',
      rev: 0,
    })
  })

  test('guidance feedback: the escalation answer lands as guidance.json (§15.6-B)', async () => {
    await seedPlanApproved()
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: {
        round: 2,
        feedback: { guidance: { escalation: 'esc_1', answer: 'use a fixed window' } },
      },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 2 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['guidance.json']).toBe('derived')
    expect(JSON.parse(await abFile('guidance.json'))).toEqual({
      escalation: 'esc_1',
      answer: 'use a fixed window',
    })
    expect(manifest.feedback).toEqual({
      guidance: { escalation: 'esc_1', answer: 'use a fixed window' },
    })
  })
})

describe('buildContext — code-review (§8.3: commit range, prior findings, dismissed ids)', () => {
  test('round 2 carries the latest commit range, history, and human dismissals', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: agent('code-review'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_1'), finding('f_2')],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_1',
        phase: 'code-review',
        round: 1,
        source: 'stall',
        question: 'finding chain persisted',
        refs: ['f_1', 'src/not-a-finding.ts'],
      },
    })
    await store.append(BUILD, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_1', answer: 'intentional tradeoff', resolution: 'dismiss-finding' },
    })
    await seedImplementRound(2, 'sha-head-2', { findings: ['f_2'] })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'code-review', round: 2 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'dismissed-findings.json',
      'history/findings-r1.json',
      'implement-notes.md',
      'plan.md',
      'spec.md',
    ])
    // Latest implement.completed wins (§8.3).
    expect(manifest.commitRange).toEqual({ base: 'sha-base', head: 'sha-head-2' })
    expect(manifest.dismissedFindingIds).toEqual(['f_1'])
    expect(JSON.parse(await abFile('dismissed-findings.json'))).toEqual(['f_1'])
    expect(await abFile('implement-notes.md')).toBe('notes r2\n')
    expect(JSON.parse(await abFile('history/findings-r1.json'))).toEqual([
      finding('f_1'),
      finding('f_2'),
    ])
  })
})

describe('buildContext — verify:<step> (§8.3: spec, step config, commit range)', () => {
  const TOML = [
    '[tickets]',
    'source = "file"',
    'readyState = "ready"',
    '',
    '[commands]',
    'typecheck = "bun tsc --noEmit"',
    '',
    '[verify]',
    'steps = ["types", "e2e"]',
    '',
    '[verify.types]',
    'kind = "check"',
    'command = "typecheck"',
    '',
    '[verify.e2e]',
    'kind = "agent"',
    'skill = "ab-verify-e2e"',
    '',
  ].join('\n')

  test('verify:e2e gets its step config from the workspace autobuild.toml (§16.1)', async () => {
    await writeFile(join(workspace, 'autobuild.toml'), TOML)
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'verify:e2e', round: 1 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual(['context.json', 'spec.md'])
    expect(manifest.step).toEqual({
      name: 'e2e',
      config: { kind: 'agent', skill: 'ab-verify-e2e' },
    })
    expect(manifest.commitRange).toEqual({ base: 'sha-base', head: 'sha-head-1' })
    // The report kind is per-step, required only on fail (§8.2).
    expect(manifest.required).toEqual(['verify-report:e2e'])
    expect(manifest.allowedTerminals).toEqual(['verdict', 'escalate'])
  })

  test('verify.started guidance materializes once from the exact step occurrence', async () => {
    await writeFile(join(workspace, 'autobuild.toml'), TOML)
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'verify.started',
      payload: {
        step: 'e2e',
        attempt: 1,
        feedback: {
          guidance: { escalation: 'esc_verify', answer: 'Use the seeded admin account.' },
        },
      },
    })

    let manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'verify:e2e', round: 1 }),
      workspacePath: workspace,
    })
    expect(manifest.feedback).toEqual({
      guidance: { escalation: 'esc_verify', answer: 'Use the seeded admin account.' },
    })
    expect(JSON.parse(await abFile('guidance.json'))).toEqual({
      escalation: 'esc_verify',
      answer: 'Use the seeded admin account.',
    })

    await store.append(BUILD, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'e2e', attempt: 1 },
    })
    manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'verify:e2e', round: 1 }),
      workspacePath: workspace,
    })
    expect(manifest.feedback).toBeUndefined()
    expect(existsSync(join(workspace, '.ab', 'guidance.json'))).toBe(false)
  })

  test('an unconfigured step errors listing the configured steps', async () => {
    await writeFile(join(workspace, 'autobuild.toml'), TOML)
    await expect(
      buildContext({
        store,
        env: makeEnv({ phase: 'verify:evals', round: 1 }),
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/verify step "evals" is not configured.*types, e2e/s)
  })

  test('a missing autobuild.toml errors naming the file', async () => {
    await expect(
      buildContext({
        store,
        env: makeEnv({ phase: 'verify:e2e', round: 1 }),
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/autobuild\.toml does not exist/)
  })
})

describe('buildContext — finalize (§8.3: spec, plan, verify reports)', () => {
  test('all verify reports land under $AB_CONTEXT_DIR/verify/, one file per step', async () => {
    await seedPlanApproved()
    await store.putArtifact(BUILD, { kind: 'verify-report:types', content: 'types ok\n' })
    await store.putArtifact(BUILD, { kind: 'verify-report:e2e', content: 'e2e ok\n' })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'finalize', round: 1 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'plan.md',
      'spec.md',
      'verify/e2e.md',
      'verify/types.md',
    ])
    expect(manifest.required).toEqual(['pr-description'])
    expect(await abFile('verify/types.md')).toBe('types ok\n')
    expect(manifest.materialized['verify/e2e.md']).toEqual({
      kind: 'verify-report:e2e',
      rev: 0,
    })
  })

  test('answered finalize guidance materializes — `ab context` IS its delivery channel (§15.6-B)', async () => {
    // Regression: finalize has no producer round for the engine to feed, so
    // the engine routes its guidance "via ab context" — which used to
    // materialize nothing: the answer was consumed by no one. Latest answer
    // wins; answers addressed to OTHER phases stay out of scope.
    await seedPlanApproved()
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc_f1', phase: 'finalize', source: 'agent', question: 'PR title format?' },
    })
    await store.append(BUILD, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_f1', answer: 'Conventional commits.', resolution: 'guidance' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc_f2', phase: 'finalize', source: 'agent', question: 'Link the ticket?' },
    })
    await store.append(BUILD, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_f2', answer: 'Yes, in the footer.', resolution: 'guidance' },
    })
    // A code-loop answer must NOT leak into finalize's context (§8.3 scoping).
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc_cr', phase: 'code-review', source: 'stall', question: 'chain?' },
    })
    await store.append(BUILD, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_cr', answer: 'Validate at the boundary.', resolution: 'guidance' },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'finalize', round: 1 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['guidance.json']).toBe('derived')
    expect(JSON.parse(await abFile('guidance.json'))).toEqual({
      escalation: 'esc_f2', // latest finalize answer wins
      answer: 'Yes, in the footer.',
    })
  })
})

describe('buildContext — reconcile (§8.3: conflict {baseSha} from phase start)', () => {
  test('materializes the fresh reconcile.started base instead of the detection snapshot', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-detected-base' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-current-base' },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'reconcile', round: 1 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, activeContext))).toEqual([
      'context.json',
      'implement-notes.md',
      'plan.md',
      'spec.md',
    ])
    expect(manifest.conflict).toEqual({ baseSha: 'sha-current-base' })
    expect(manifest.required).toEqual(['reconcile-notes'])
    expect(manifest.allowedTerminals).toEqual(['done', 'escalate'])
  })

  test('a crashed attempt exposes its newest matching reconcile.started base', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-detected-base' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-first-start' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-refreshed-rerun' },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'reconcile', round: 1 }),
      workspacePath: workspace,
    })
    expect(manifest.conflict).toEqual({ baseSha: 'sha-refreshed-rerun' })
  })

  test('fails clearly when the runner did not record this reconcile attempt start', async () => {
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-detected-base' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-other-attempt' },
    })

    await expect(
      buildContext({
        store,
        env: makeEnv({ phase: 'reconcile', round: 2 }),
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/reconcile@2 context requires a matching reconcile\.started/)
  })

  test('answered reconcile guidance materializes for the next attempt (§15.6-B, §15.7)', async () => {
    // e.g. a maxReconcileAttempts policy escalation answered "keep trying" —
    // the attempt that proceeds past the cap must actually see the answer.
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-conflict-base' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_r1',
        phase: 'reconcile',
        source: 'policy',
        policyCause: 'reconcile-no-progress',
        question: 'maxReconcileAttempts (3) exhausted',
      },
    })
    await store.append(BUILD, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_r1', answer: 'Keep trying, base settled.', resolution: 'guidance' },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 4, baseSha: 'sha-current-base' },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'reconcile', round: 4 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['guidance.json']).toBe('derived')
    expect(JSON.parse(await abFile('guidance.json'))).toEqual({
      escalation: 'esc_r1',
      answer: 'Keep trying, base settled.',
    })
  })
})

describe('buildContext — tracked legacy scratch', () => {
  test('preserves tracked bytes, relocates notes, ignores generated files, and observes once', async () => {
    const runGit = async (...args: string[]): Promise<string> => {
      const result = await spawnExec(['git', ...args], { cwd: workspace })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout
    }
    await runGit('init', '-q')
    await runGit('config', 'user.name', 'Test')
    await runGit('config', 'user.email', 'test@example.com')
    await mkdir(join(workspace, '.ab/implement'), { recursive: true })
    await writeFile(join(workspace, '.ab/implement/implement-notes.md'), 'repository content\n')
    await writeFile(join(workspace, '.ab/implement/context.json'), 'tracked manifest\n')
    await writeFile(join(workspace, '.ab/code-review-sibling'), 'sibling original\n')
    await runGit('add', '-f', '.ab/implement/context.json', '.ab/code-review-sibling')
    await runGit('add', '-f', '.ab/implement/implement-notes.md')
    await runGit('commit', '-qm', 'legacy scratch')
    const baseSha = (await runGit('rev-parse', 'HEAD')).trim()
    await seedPlanApproved()
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'git-worktree',
        ref: workspace,
        path: workspace,
        branch: `ab/${BUILD}`,
        base: { source: 'remote', sha: baseSha },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 1 },
    })
    let nextId = 0
    const ids: IdSource = (prefix) => `${prefix}_${++nextId}`
    const deps = {
      store,
      env: makeEnv({ phase: 'implement', round: 1 }),
      workspacePath: workspace,
      exec: spawnExec,
      ids,
    }

    const first = await buildContext(deps)
    expect(first.manifestPath).toBe('.ab/implement/generated/1/context.json')
    expect(await readFile(join(workspace, '.ab/implement/context.json'), 'utf8')).toBe(
      'tracked manifest\n',
    )
    expect(first.notesPath).toBe('.ab/implement/generated/1/implement-notes.md')
    expect(await abFile('implement-notes.md')).toBe('repository content\n')
    expect((await runGit('status', '--porcelain', '--', '.ab')).trim()).toBe('')
    expect((await runGit('check-ignore', first.notesPath!)).trim()).toBe(first.notesPath!)
    expect(await buildContext(deps)).toEqual(first)
    expect(await abFile('implement-notes.md')).toBe('repository content\n')
    expect((await runGit('status', '--porcelain', '--', '.ab')).trim()).toBe('')
    const observations = (await store.getEvents(BUILD)).filter(
      (event) =>
        event.type === 'observation.recorded' &&
        event.payload.refs?.includes('phase-scratch:tracked-at-provisioned-base'),
    )
    expect(observations).toHaveLength(1)
    const observation = observations[0]
    expect(observation?.type).toBe('observation.recorded')
    if (observation?.type !== 'observation.recorded') throw new Error('missing observation')
    expect(observation.payload.files).toEqual([
      '.ab/code-review-sibling',
      '.ab/implement/context.json',
      '.ab/implement/implement-notes.md',
    ])
    expect(
      (await runGit('ls-files', '-v', '.ab/implement/implement-notes.md')).startsWith('H '),
    ).toBe(true)

    // A later base update to the colliding tracked path must merge normally:
    // context introduced no skip-worktree/assume-unchanged state and kept the
    // index/worktree copy clean while generated notes remain ignored.
    const baseBranch = (await runGit('rev-parse', '--abbrev-ref', 'HEAD')).trim()
    await runGit('checkout', '-qb', 'feature')
    await writeFile(join(workspace, 'feature.txt'), 'feature\n')
    await runGit('add', 'feature.txt')
    await runGit('commit', '-qm', 'feature work')
    await runGit('checkout', '-q', baseBranch)
    await writeFile(join(workspace, '.ab/implement/implement-notes.md'), 'advanced base content\n')
    await runGit('add', '-f', '.ab/implement/implement-notes.md')
    await runGit('commit', '-qm', 'advance tracked scratch')
    await runGit('checkout', '-q', 'feature')
    await runGit('merge', '--no-edit', baseBranch)
    expect(await abFile('implement-notes.md')).toBe('advanced base content\n')
    expect((await runGit('status', '--porcelain', '--', '.ab')).trim()).toBe('')
  })
})

describe('buildContext — hygiene (§8.3)', () => {
  test('only the current session directory is wiped; the rest of the workspace is untouched', async () => {
    await mkdir(join(workspace, '.ab/plan', 'history'), { recursive: true })
    await writeFile(join(workspace, '.ab/plan', 'stale.txt'), 'stale context\n')
    await writeFile(join(workspace, '.ab/plan', 'history', 'old.json'), '[]\n')
    await writeFile(join(workspace, 'src.txt'), 'workspace file\n')

    await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })

    expect(existsSync(join(workspace, '.ab/plan', 'stale.txt'))).toBe(false)
    expect(existsSync(join(workspace, '.ab/plan', 'history'))).toBe(false)
    expect(await readFile(join(workspace, 'src.txt'), 'utf8')).toBe('workspace file\n')
  })

  test('the wipe removes legacy server scratch files', async () => {
    await mkdir(join(workspace, '.ab/implement'), { recursive: true })
    await writeFile(join(workspace, '.ab/implement', 'server.pid'), '12345\n')
    await writeFile(join(workspace, '.ab/implement', 'server.log'), 'listening on :3000\n')

    await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 2 }),
      workspacePath: workspace,
    })

    expect(existsSync(join(workspace, '.ab/implement', 'server.pid'))).toBe(false)
    expect(existsSync(join(workspace, '.ab/implement', 'server.log'))).toBe(false)
  })

  test('.ab/ is made self-gitignored on every run — the product establishes §7’s "gitignored .ab/"', async () => {
    // No repo .gitignore mentions .ab/ (the normal case: ab init does not
    // add one); the self-excluding .ab/.gitignore is what keeps implement's
    // clean-worktree check (D5) from wedging on scratch.
    await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect(await abFile('.gitignore')).toBe('*\n')
  })

  test('context.json on disk is exactly the returned manifest', async () => {
    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect(JSON.parse(await abFile('context.json'))).toEqual(JSON.parse(JSON.stringify(manifest)))
  })
})

describe('buildContext — spec and plan are pinned to event-anchored revs (§6.3)', () => {
  test('a stray spec deposit with no spec.* event never reaches a phase', async () => {
    // The CLI rejects `ab artifact put spec` (src/cli/artifact.ts), but the
    // materializer must not trust "latest" regardless: the spec a phase sees
    // is the rev the spec.imported/authored/revised events anchor — a
    // drifting spec silently converts approvals into
    // approvals-of-something-else (§6.3).
    await store.putArtifact(BUILD, { kind: 'spec', content: '# Tampered spec\n' })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'code-review', round: 1 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['spec.md']).toEqual({ kind: 'spec', rev: 0 })
    expect(await abFile('spec.md')).toBe('# Spec: auth rate limiting\n')
  })

  test('spec.revised moves the pin to the sanctioned rev', async () => {
    await store.putArtifact(BUILD, { kind: 'spec', content: '# Spec rev 1 (human-sanctioned)\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1 },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 2 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['spec.md']).toEqual({ kind: 'spec', rev: 1 })
    expect(await abFile('spec.md')).toBe('# Spec rev 1 (human-sanctioned)\n')
  })

  test('a plan rev deposited outside the plan loop never replaces the completed plan', async () => {
    // Downstream phases must see the rev the latest plan.completed cited —
    // the one plan-review actually approved (§10) — not whatever a later
    // phase deposited under the `plan` kind.
    await seedPlanApproved()
    await store.putArtifact(BUILD, { kind: 'plan', content: '# Never-reviewed plan\n' })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 1 }),
      workspacePath: workspace,
    })

    expect(manifest.materialized['plan.md']).toEqual({ kind: 'plan', rev: 0 })
    expect(await abFile('plan.md')).toBe('# Plan v1\n')
  })
})

describe('buildContext — frozen ticket assets (SPEC §6.3)', () => {
  const REPO = 'acme/app'
  const TICKET = 'ENG-42'
  const enc = (text: string) => new TextEncoder().encode(text)
  const fileAsset = (name: string, text: string) => ({
    kind: 'mock',
    name,
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: name, content: enc(text) }],
  })
  const treeAsset = (name: string, text: string) => ({
    kind: 'ref',
    name,
    layout: 'tree' as const,
    entries: [
      { type: 'dir' as const, path: 'empty' },
      { type: 'dir' as const, path: 'img' },
      { type: 'file' as const, path: 'index.html', content: enc(text) },
      { type: 'file' as const, path: 'img/logo.svg', content: enc('<svg/>') },
    ],
  })
  const pinOf = (meta: Awaited<ReturnType<typeof store.putTicketAsset>>) => ({
    kind: meta.kind,
    name: meta.name,
    revision: meta.revision,
    layout: meta.layout,
    size: meta.size,
    fileCount: meta.entries.filter((e) => e.type === 'file').length,
    dirCount: meta.entries.filter((e) => e.type === 'dir').length,
  })

  async function freeze(): Promise<void> {
    await store.close()
    // Assets exist before the claim; the build then pins what the ticket had.
    const staging = await seedStore()
    const shot = await staging.putTicketAsset(REPO, TICKET, fileAsset('home.png', 'v0 bytes'))
    const site = await staging.putTicketAsset(REPO, TICKET, treeAsset('site', '<h1>v0</h1>'))
    await staging.close()
    store = await seedStore({ assets: [pinOf(shot), pinOf(site)] })
    await store.putTicketAsset(REPO, TICKET, fileAsset('home.png', 'v0 bytes'))
    await store.putTicketAsset(REPO, TICKET, treeAsset('site', '<h1>v0</h1>'))
  }

  const TOML = [
    '[tickets]',
    'source = "file"',
    'readyState = "ready"',
    '',
    '[verify]',
    'steps = ["e2e"]',
    '',
    '[verify.e2e]',
    'kind = "agent"',
    'skill = "ab-verify-e2e"',
    '',
  ].join('\n')

  test('snapshot-backed assets hydrate with the same manifest and filesystem layout', async () => {
    const source = await seedStore()
    await source.putTicketAsset(REPO, TICKET, treeAsset('site', '<h1>hosted</h1>'))
    const assets = await prepareAssetSnapshots(source, store, REPO, TICKET)
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 0 }, escalation: 1, assets },
    })
    await source.removeTicketAsset(REPO, TICKET, 'ref', 'site')
    await source.close()
    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect(manifest.assets).toEqual([
      {
        kind: 'ref',
        name: 'site',
        revision: 0,
        layout: 'tree',
        size: 21,
        path: '.ab/plan/assets/ref/site',
      },
    ])
    expect(await abFile('assets/ref/site/index.html')).toBe('<h1>hosted</h1>')
    expect(existsSync(join(workspace, '.ab/plan/assets/ref/site/empty'))).toBe(true)
  })

  test('every phase writes the pinned assets and lists them in the manifest', async () => {
    await freeze()
    await writeFile(join(workspace, 'autobuild.toml'), TOML)
    await seedPlanApproved()
    await seedImplementRound(1, 'sha-head-1')
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-base-2' },
    })

    for (const phase of [
      'plan',
      'plan-review',
      'implement',
      'code-review',
      'verify:e2e',
      'finalize',
      'reconcile',
    ] as const) {
      const manifest = await buildContext({
        store,
        env: makeEnv({ phase, round: 1 }),
        workspacePath: workspace,
      })
      expect(manifest.assets).toEqual([
        {
          kind: 'mock',
          name: 'home.png',
          revision: 0,
          layout: 'file',
          size: 8,
          path: `${manifest.contextDir}/assets/mock/home.png`,
        },
        {
          kind: 'ref',
          name: 'site',
          revision: 0,
          layout: 'tree',
          size: 17,
          path: `${manifest.contextDir}/assets/ref/site`,
        },
      ])
      expect(await abFile('assets/mock/home.png/home.png')).toBe('v0 bytes')
      expect(await abFile('assets/ref/site/index.html')).toBe('<h1>v0</h1>')
      expect(await abFile('assets/ref/site/img/logo.svg')).toBe('<svg/>')
      expect(existsSync(join(workspace, `${manifest.contextDir}/assets/ref/site/empty`))).toBe(true)
      const written = JSON.parse(await abFile('context.json'))
      expect(written.assets).toEqual(manifest.assets)
    }
  })

  test('attaching, replacing, or removing after the claim changes nothing', async () => {
    await freeze()
    await store.putTicketAsset(REPO, TICKET, fileAsset('home.png', 'REPLACED'))
    await store.putTicketAsset(REPO, TICKET, fileAsset('new.png', 'new'))
    await store.removeTicketAsset(REPO, TICKET, 'ref', 'site')

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })

    expect(manifest.assets?.map((a) => `${a.kind}/${a.name}@${a.revision}`)).toEqual([
      'mock/home.png@0',
      'ref/site@0',
    ])
    expect(await abFile('assets/mock/home.png/home.png')).toBe('v0 bytes')
    expect(await abFile('assets/ref/site/index.html')).toBe('<h1>v0</h1>')
    expect(existsSync(join(workspace, '.ab/plan/assets/mock/new.png'))).toBe(false)
  })

  test('a spec re-pin changes what later phases see', async () => {
    await freeze()
    const replaced = await store.putTicketAsset(REPO, TICKET, fileAsset('home.png', 'REPLACED'))
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'escalation.raised',
      payload: { id: 'e_1', phase: 'plan', source: 'agent', question: 'q' },
    })
    await store.putArtifact(BUILD, { kind: 'spec', content: '# Spec v1\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 4, assets: [pinOf(replaced)] },
    })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })

    expect(manifest.assets?.map((a) => `${a.kind}/${a.name}@${a.revision}`)).toEqual([
      'mock/home.png@1',
    ])
    expect(await abFile('assets/mock/home.png/home.png')).toBe('REPLACED')
    expect(existsSync(join(workspace, '.ab/plan/assets/ref'))).toBe(false)
  })

  test('a build with no pinned assets has no assets key and no directory', async () => {
    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect('assets' in manifest).toBe(false)
    expect(existsSync(join(workspace, '.ab/plan/assets'))).toBe(false)
  })

  test('a pin the store cannot produce fails clearly', async () => {
    await store.close()
    store = await seedStore({
      assets: [
        {
          kind: 'mock',
          name: 'gone',
          revision: 0,
          layout: 'file',
          size: 1,
          fileCount: 1,
          dirCount: 0,
        },
      ],
    })
    await expect(
      buildContext({ store, env: makeEnv({ phase: 'plan', round: 1 }), workspacePath: workspace }),
    ).rejects.toThrow(/pinned ticket asset mock\/gone revision 0 is missing/)
  })
})

test.each(['restack', 'reconcile'])(
  'review and all configured agent verifies consume %s ranges before PR creation',
  async (kind) => {
    await seedPlanApproved()
    await seedImplementRound(1, 'original')
    await writeFile(
      join(workspace, 'autobuild.toml'),
      `
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = ["first", "second"]
[verify.first]
kind = "agent"
skill = "verify-first"
[verify.second]
kind = "agent"
skill = "verify-second"
`,
    )
    for (const event of leafRestackLog().slice(6))
      await store.append(BUILD, { actor: event.actor, type: event.type, payload: event.payload })
    let base = 'c'.repeat(40)
    let head = 'e'.repeat(40)
    if (kind === 'reconcile') {
      base = '1'.repeat(40)
      head = '2'.repeat(40)
      const transaction = leafRestackLog().find((e) => e.type === 'restack.rewritten')!
      const {
        trigger: _trigger,
        cycle: _cycle,
        observation: _observation,
        message: _message,
        ...tx
      } = transaction.payload
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.rewritten',
        payload: {
          ...tx,
          attempt: 1,
          targetBase: base,
          headSha: head,
          conflicted: false,
        },
      })
      await store.append(BUILD, {
        actor: agent('reconcile'),
        type: 'reconcile.completed',
        payload: {
          headSha: head,
          rewriteId: tx.id,
          artifact: { kind: 'reconcile-notes', rev: 0 },
        },
      })
    }
    for (const phase of ['code-review', 'verify:first', 'verify:second'] as const) {
      const context = await buildContext({
        store,
        env: makeEnv({ phase, round: 1 }),
        workspacePath: workspace,
      })
      expect(context.commitRange).toEqual({ base, head })
    }
  },
)

describe('own-build read evidence', () => {
  test('only the initial read failure is classified, and a transient read can recover', async () => {
    const original = store.getReducerValue.bind(store)
    const error = new Error('cannot decode own build')
    store.getReducerValue = async () => {
      throw error
    }
    await expect(
      buildContext({ store, env: makeEnv({ phase: 'plan' }), workspacePath: workspace }),
    ).rejects.toBe(error)
    store.getReducerValue = original
    const evidence = (await store.getEvents(BUILD)).filter(
      (event) => event.type === 'session.build-read-failed',
    )
    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.payload).toMatchObject({
      operation: 'context',
      reason: 'own-build-read',
      diagnostic: error.message,
    })
    await buildContext({ store, env: makeEnv({ phase: 'plan' }), workspacePath: workspace })
    expect(
      (await store.getEvents(BUILD)).filter((event) => event.type === 'session.build-read-failed'),
    ).toHaveLength(1)
  })
  test('an evidence write outage preserves the original read error', async () => {
    const read = store.getReducerValue.bind(store)
    const append = store.append.bind(store)
    const error = new Error('original read failed')
    store.getReducerValue = async () => {
      throw error
    }
    store.append = async () => {
      throw new Error('write also failed')
    }
    await expect(
      buildContext({ store, env: makeEnv({ phase: 'plan' }), workspacePath: workspace }),
    ).rejects.toBe(error)
    store.getReducerValue = read
    store.append = append
    expect(
      (await store.getEvents(BUILD)).some((event) => event.type === 'session.build-read-failed'),
    ).toBe(false)
  })
})

test('overlapping verifier hydration and repeat hydration retain sibling inputs', async () => {
  await writeFile(
    join(workspace, 'autobuild.toml'),
    '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = ["one", "two"]\n[verify.one]\nkind = "agent"\nskill = "one"\n[verify.two]\nkind = "agent"\nskill = "two"\n',
  )
  const second = await seedStore()
  try {
    await second.putArtifact(BUILD, { kind: 'spec', content: '# Second verifier spec\n' })
    await second.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1 },
    })
    const deps = (name: 'one' | 'two') => ({
      store: name === 'one' ? store : second,
      env: makeEnv({ phase: `verify:${name}`, session: `s_${name}` }),
      workspacePath: workspace,
    })
    for (const [name, target] of [
      ['one', store],
      ['two', second],
    ] as const) {
      await target.append(BUILD, {
        actor: KERNEL,
        type: 'verify.started',
        payload: {
          step: name,
          attempt: 1,
          feedback: { guidance: { escalation: `esc_${name}`, answer: name } },
        },
      })
    }
    const manifests = await Promise.all([hydrateContext(deps('one')), hydrateContext(deps('two'))])
    const before = await readFile(join(workspace, '.ab/verify-two/context.json'), 'utf8')
    for (const [index, name] of ['one', 'two'].entries()) {
      const dir = `.ab/verify-${name}`
      expect(manifests[index]!.contextDir).toBe(dir)
      expect(JSON.parse(await readFile(join(workspace, dir, 'guidance.json'), 'utf8')).answer).toBe(
        name,
      )
      expect(await readFile(join(workspace, dir, 'spec.md'), 'utf8')).toContain(
        name === 'one' ? 'auth rate limiting' : 'Second verifier spec',
      )
    }
    await writeFile(join(workspace, '.ab/verify-one/stale'), 'stale')
    await hydrateContext(deps('one'))
    expect(existsSync(join(workspace, '.ab/verify-one/stale'))).toBe(false)
    expect(await readFile(join(workspace, '.ab/verify-two/context.json'), 'utf8')).toBe(before)
    expect(existsSync(join(workspace, '.ab/context.json'))).toBe(false)
    expect(existsSync(join(workspace, '.ab/spec.md'))).toBe(false)
  } finally {
    await second.close()
  }
})

test('a tracked file blocking the named directory is preserved with a diagnostic', async () => {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    expect((await spawnExec(['git', ...args], { cwd: workspace })).exitCode).toBe(0)
  }
  await mkdir(join(workspace, '.ab'))
  await writeFile(join(workspace, '.ab/plan'), 'repository bytes')
  await spawnExec(['git', 'add', '-f', '.ab/plan'], { cwd: workspace })
  await expect(
    hydrateContext({
      store,
      env: makeEnv({ phase: 'plan' }),
      workspacePath: workspace,
      exec: spawnExec,
    }),
  ).rejects.toThrow('Tracked content blocks context directory .ab/plan')
  expect(await readFile(join(workspace, '.ab/plan'), 'utf8')).toBe('repository bytes')
})

test('cancellation feedback belongs only to the routed implement receipt, never later rounds or finalize', async () => {
  await seedPlanApproved()
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step: 'slow', attempt: 1 },
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'verify.cancelled',
    payload: { step: 'slow', attempt: 1, cause: { step: 'fast' } },
  })
  const receipt = await store.append(BUILD, {
    actor: KERNEL,
    type: 'verify.stage-failed',
    payload: {
      cycle: 0,
      attempt: 1,
      stage: ['fast', 'slow'],
      failed: [{ step: 'fast' }],
      cancelled: [{ step: 'slow', cause: { step: 'fast' } }],
    },
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round: 2, verifyStageFailure: receipt.seq },
  })
  const routed = await buildContext({
    store,
    workspacePath: workspace,
    env: makeEnv({ phase: 'implement', round: 2 }),
  })
  expect(routed.cancelledVerify).toEqual([
    { step: 'slow', attempt: 1, cause: { step: 'fast' }, status: 'not-run' },
  ])
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round: 3, feedback: { findings: ['new-finding'] } },
  })
  for (const phase of ['implement', 'finalize'] as const) {
    const manifest = await buildContext({
      store,
      workspacePath: workspace,
      env: makeEnv({ phase, round: 3 }),
    })
    expect(manifest.cancelledVerify).toBeUndefined()
    expect(manifest.verifyStageFailure).toBeUndefined()
  }
})

test.each(['implement', 'reconcile'] as const)(
  'recovery notes tell %s the known loss and survive repeated hydration',
  async (phase) => {
    await seedPlanApproved()
    if (phase === 'reconcile') {
      await store.append(BUILD, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha: 'fresh-base' },
      })
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: 1, baseSha: 'fresh-base' },
      })
    }
    const sha = '9'.repeat(40)
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'workspace.commits-lost',
      payload: {
        workspace: 1,
        execution: 0,
        ref: 'gone',
        branch: `ab/${BUILD}`,
        phase,
        round: 1,
        shas: [sha],
        inventory: 'additional-shas-unavailable',
        reason: 'source environment is absent',
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'publication.candidate-retired',
      payload: {
        request: 1,
        operation: 'reconcile',
        id: 'lost',
        sha,
        replacementId: 'replacement',
      },
    })
    for (let hydration = 0; hydration < 2; hydration++) {
      const manifest = await buildContext({
        store,
        env: makeEnv({ phase, round: 1 }),
        workspacePath: workspace,
      })
      expect(manifest.workspaceRecovery).toBeDefined()
      const notes = await readFile(join(workspace, manifest.workspaceRecovery!), 'utf8')
      expect(notes).toContain(`${phase}@1`)
      expect(notes).toContain(sha)
      expect(notes).toContain('Additional unpublished SHAs are unavailable')
      expect(notes).toContain('do not search for the retired candidate')
      expect(manifest.materialized['workspace-recovery.md']).toBe('derived')
    }
  },
)

test('workspace recovery notes relocate around tracked scratch', async () => {
  const git = async (...args: string[]) => {
    const result = await spawnExec(['git', ...args], { cwd: workspace })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await mkdir(join(workspace, '.ab/implement'), { recursive: true })
  const tracked = '.ab/implement/workspace-recovery.md'
  await writeFile(join(workspace, tracked), 'repository-owned recovery document\n')
  await git('add', '-f', tracked)
  await git('commit', '-qm', 'legacy scratch')
  const base = await git('rev-parse', 'HEAD')
  await seedPlanApproved()
  const source = await store.append(BUILD, {
    actor: DISPATCHER,
    type: 'workspace.provisioned',
    payload: {
      provider: 'git-worktree',
      ref: workspace,
      path: workspace,
      branch: `ab/${BUILD}`,
      base: { source: 'remote', sha: base },
    },
  })
  await store.append(BUILD, {
    actor: DISPATCHER,
    type: 'workspace.commits-lost',
    payload: {
      workspace: source.seq,
      execution: 0,
      ref: 'gone',
      branch: `ab/${BUILD}`,
      phase: 'implement',
      round: 1,
      shas: ['9'.repeat(40)],
      inventory: 'additional-shas-unavailable',
      reason: 'source environment is absent',
    },
  })
  const manifest = await buildContext({
    store,
    env: makeEnv({ phase: 'implement', round: 1 }),
    workspacePath: workspace,
    exec: spawnExec,
  })
  expect(manifest.workspaceRecovery).not.toBe(tracked)
  expect(await readFile(join(workspace, tracked), 'utf8')).toBe(
    'repository-owned recovery document\n',
  )
  expect(await readFile(join(workspace, manifest.workspaceRecovery!), 'utf8')).toContain(
    'source environment is absent',
  )
})

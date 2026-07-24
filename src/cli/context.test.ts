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
import type { Feedback, Finding } from '../ontology'
import type { MemoryBuildStore } from '../store/memory'
import { buildContext } from './context'
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
  return readFile(join(workspace, '.ab', relPath), 'utf8')
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

  test('verify-failure feedback: the cited report rev lands under .ab/verify/', async () => {
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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
        refs: ['f_1'],
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
      'context.json',
      'history/findings-r1.json',
      'implement-notes.md',
      'plan.md',
      'spec.md',
    ])
    // Latest implement.completed wins (§8.3).
    expect(manifest.commitRange).toEqual({ base: 'sha-base', head: 'sha-head-2' })
    expect(manifest.dismissedFindingIds).toEqual(['f_1'])
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
    '[server]',
    'start = "bun dev"',
    'url = "http://localhost:3000"',
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
    'needsServer = true',
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual(['.gitignore', 'context.json', 'spec.md'])
    expect(manifest.step).toEqual({
      name: 'e2e',
      config: { kind: 'agent', skill: 'ab-verify-e2e', needsServer: true },
    })
    expect(manifest.commitRange).toEqual({ base: 'sha-base', head: 'sha-head-1' })
    // The report kind is per-step, required only on fail (§8.2).
    expect(manifest.required).toEqual(['verify-report:e2e'])
    expect(manifest.allowedTerminals).toEqual(['verdict', 'escalate'])
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
  test('all verify reports land under .ab/verify/, one file per step', async () => {
    await seedPlanApproved()
    await store.putArtifact(BUILD, { kind: 'verify-report:types', content: 'types ok\n' })
    await store.putArtifact(BUILD, { kind: 'verify-report:e2e', content: 'e2e ok\n' })

    const manifest = await buildContext({
      store,
      env: makeEnv({ phase: 'finalize', round: 1 }),
      workspacePath: workspace,
    })

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

    expect(await treeOf(join(workspace, '.ab'))).toEqual([
      '.gitignore',
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

describe('buildContext — hygiene (§8.3)', () => {
  test('.ab/ is wiped on every run; the rest of the workspace is untouched', async () => {
    await mkdir(join(workspace, '.ab', 'history'), { recursive: true })
    await writeFile(join(workspace, '.ab', 'stale.txt'), 'stale context\n')
    await writeFile(join(workspace, '.ab', 'history', 'old.json'), '[]\n')
    await writeFile(join(workspace, 'src.txt'), 'workspace file\n')

    await buildContext({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })

    expect(existsSync(join(workspace, '.ab', 'stale.txt'))).toBe(false)
    expect(existsSync(join(workspace, '.ab', 'history'))).toBe(false)
    expect(await readFile(join(workspace, 'src.txt'), 'utf8')).toBe('workspace file\n')
  })

  test('the wipe preserves the dev-server control state — server.pid/server.log (§16.2 D10)', async () => {
    // ServerControl's ONLY handle to the (deliberately CLI-outliving) server
    // is .ab/server.pid; wiping it would orphan a running server from every
    // later `ab server` command — status would lie, stop would no-op, and
    // start would EADDRINUSE against the unreachable original.
    await mkdir(join(workspace, '.ab'), { recursive: true })
    await writeFile(join(workspace, '.ab', 'server.pid'), '12345\n')
    await writeFile(join(workspace, '.ab', 'server.log'), 'listening on :3000\n')
    await writeFile(join(workspace, '.ab', 'stale.txt'), 'stale\n')

    await buildContext({
      store,
      env: makeEnv({ phase: 'implement', round: 2 }),
      workspacePath: workspace,
    })

    expect(await abFile('server.pid')).toBe('12345\n')
    expect(await abFile('server.log')).toBe('listening on :3000\n')
    expect(existsSync(join(workspace, '.ab', 'stale.txt'))).toBe(false)
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

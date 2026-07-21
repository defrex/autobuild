/**
 * Terminal-command tests (SPEC §8.4 D5, §8.5 D6, §8.6 D7): second-terminal
 * discipline, per-phase preconditions, push-before-event ordering, verdict
 * vocabulary, findings validation-as-feedback, and deposit atomicity — over
 * a seeded MemoryBuildStore, FakeForge, and real throwaway git repos.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentActor, humanActor, KERNEL } from '../events/envelope'
import { FakeForge } from '../ports/forge/fake'
import { GitHubForge } from '../ports/forge/github'
import type { Finding } from '../ontology'
import type { MemoryBuildStore } from '../store/memory'
import { textContent } from '../store/types'
import { buildContext } from './context'
import { done, escalate, verdict } from './terminals'
import {
  BRANCH,
  BUILD,
  commitFile,
  initBareOrigin,
  initWorkspaceRepo,
  makeDeps,
  makeEnv,
  remoteBranchHead,
  runGit,
  seedStore,
  type TestDeps,
} from './testkit'

let tmp: string
let filesDir: string
let planWorkspace: string
let store: MemoryBuildStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-terminals-'))
  filesDir = join(tmp, 'files')
  planWorkspace = join(tmp, 'plan-workspace')
  await mkdir(filesDir)
  await mkdir(planWorkspace)
  await writeFile(
    join(planWorkspace, 'autobuild.toml'),
    [
      '[tickets]',
      'source = "file"',
      'readyState = "ready"',
      '[commands]',
      'types = "bun typecheck"',
      'unit = "bun test"',
      '[verify]',
      'steps = ["types", "unit"]',
      '[verify.types]',
      'kind = "check"',
      'command = "types"',
      '[verify.unit]',
      'kind = "check"',
      'command = "unit"',
      '',
    ].join('\n'),
  )
  store = await seedStore()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
  await store.close()
})

async function stash(name: string, content: string): Promise<string> {
  const path = join(filesDir, name)
  await writeFile(path, content)
  return path
}

async function eventTypes(): Promise<string[]> {
  return (await store.getEvents(BUILD)).map((event) => event.type)
}

function finding(id: string, persists: string[] = []): Finding {
  return { id, severity: 'blocking', summary: `finding ${id}`, persists }
}

const agent = (role: string) => agentActor(role, 's_seed')

function planDeps(overrides: Parameters<typeof makeEnv>[0] = {}): TestDeps {
  return makeDeps({
    store,
    env: makeEnv({ phase: 'plan', ...overrides }),
    workspacePath: planWorkspace,
  })
}

// ── ab done — phase-kind and second-terminal discipline (D5) ─────────────────

describe('ab done — discipline (D5)', () => {
  test('done in a review phase is rejected naming the right terminal', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    await expect(done(deps)).rejects.toThrow(
      /'ab done' is not code-review's terminal.*review phase.*use 'ab verdict'/s,
    )
  })

  test('done in an agent-verify phase is rejected naming verdict', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e' }) })
    await expect(done(deps)).rejects.toThrow(/use 'ab verdict'/)
  })

  test('done after done for the same round is rejected citing the existing event', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    const deps = planDeps({ round: 1 })
    await expect(done(deps)).rejects.toThrow(
      /second terminal call rejected \(D5\): plan\.completed for plan@1 already recorded at seq \d+/,
    )
  })

  test('escalate after done for the same phase+round is rejected', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    const deps = makeDeps({ store, env: makeEnv({ phase: 'plan', round: 1 }) })
    await expect(escalate(deps, { question: 'unsure about scope' })).rejects.toThrow(
      /second terminal call rejected/,
    )
  })

  test('done after this session escalated is rejected citing the escalation', async () => {
    await store.append(BUILD, {
      actor: agentActor('plan', 's_test'),
      type: 'escalation.raised',
      payload: { id: 'esc_9', phase: 'plan', round: 1, source: 'agent', question: 'stuck' },
    })
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    const deps = planDeps({ round: 1 })
    await expect(done(deps)).rejects.toThrow(
      /this session already escalated.*esc_9/s,
    )
  })

  test("a different session's escalation does not block this session's terminal", async () => {
    await store.append(BUILD, {
      actor: agentActor('plan', 's_earlier'),
      type: 'escalation.raised',
      payload: { id: 'esc_1', phase: 'plan', round: 1, source: 'agent', question: 'was stuck' },
    })
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    const deps = planDeps({ round: 1 })
    const event = await done(deps)
    expect(event.type).toBe('plan.completed')
  })
})

// ── ab done — plan ───────────────────────────────────────────────────────────

describe('ab done — plan', () => {
  test('rejected without this round’s deposit, naming the fix', async () => {
    const deps = planDeps({ round: 1 })
    await expect(done(deps)).rejects.toThrow(
      /requires this round's plan deposit.*found 0.*ab artifact put plan/s,
    )
  })

  test('round 2 whose only revision was already cited by round 1 is rejected', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan v1\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    const deps = planDeps({ round: 2, session: 's_r2' })
    await expect(done(deps)).rejects.toThrow(
      /requires this round's plan deposit.*no plan revision newer than rev 0/s,
    )
  })

  test('a stale plan cannot re-enter review: revision COUNT is no proxy for a fresh deposit (D5)', async () => {
    // Round 1 self-corrects with TWO deposits and cites rev 1. Round 2 then
    // calls done WITHOUT depositing — the old count check (revs ≥ round)
    // passed here, re-submitting the identical, already-reviewed plan.
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan draft\n' })
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan self-corrected\n' })
    await store.append(BUILD, {
      actor: agent('plan'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 1 } },
    })
    const deps = planDeps({ round: 2, session: 's_r2' })
    await expect(done(deps)).rejects.toThrow(
      /requires this round's plan deposit.*no plan revision newer than rev 1.*already cited/s,
    )

    // Depositing this round's revision unblocks it, citing the NEW rev.
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan revised for r2\n' })
    const event = await done(deps)
    expect(event.payload).toEqual({
      round: 2,
      artifact: { kind: 'plan', rev: 2 },
      verifySteps: ['types', 'unit'],
    })
  })

  test('with the deposit, emits plan.completed carrying the latest plan ref and agent actor', async () => {
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan v1\n' })
    const deps = planDeps({ round: 1 })
    const event = await done(deps)
    expect(event.type).toBe('plan.completed')
    expect(event.payload).toEqual({
      round: 1,
      artifact: { kind: 'plan', rev: 0 },
      verifySteps: ['types', 'unit'],
    })
    expect(event.actor).toEqual({ kind: 'agent', role: 'plan', session: 's_test' })
  })

  test('records an explicit selection in config order, including an empty optional set', async () => {
    await store.putArtifact(BUILD, {
      kind: 'plan',
      content: '+++\nverifySteps = ["unit", "types"]\n+++\n# Plan\n',
    })
    const first = await done(planDeps({ round: 1 }))
    expect(first.payload).toEqual({
      round: 1,
      artifact: { kind: 'plan', rev: 0 },
      verifySteps: ['types', 'unit'],
    })

    await store.putArtifact(BUILD, {
      kind: 'plan',
      content: '+++\nverifySteps = []\n+++\n# Revised plan\n',
    })
    const second = await done(planDeps({ round: 2, session: 's_r2' }))
    expect(second.payload).toEqual({
      round: 2,
      artifact: { kind: 'plan', rev: 1 },
      verifySteps: [],
    })
  })

  test('rejects malformed, duplicate, and unknown metadata before appending a terminal fact', async () => {
    const deps = planDeps({ round: 1 })
    const invalidPlans = [
      ['+++\nverifySteps = "types"\n+++\n', /front matter is invalid/],
      ['+++\nverifySteps = ["types", "types"]\n+++\n', /duplicate step "types"/],
      ['+++\nverifySteps = ["ghost"]\n+++\n', /unknown step "ghost".*verify\.ghost/s],
      ['+++\nverifySteps = ["types"]\n', /missing its closing/],
    ] as const

    for (const [content, error] of invalidPlans) {
      await store.putArtifact(BUILD, { kind: 'plan', content })
      await expect(done(deps)).rejects.toThrow(error)
      expect(await eventTypes()).not.toContain('plan.completed')
    }
  })

  test('rejects omission of a mandatory step, then accepts a corrected fresh revision', async () => {
    await writeFile(
      join(planWorkspace, 'autobuild.toml'),
      (await Bun.file(join(planWorkspace, 'autobuild.toml')).text()).replace(
        'command = "types"',
        'command = "types"\nalways = true',
      ),
    )
    const deps = planDeps({ round: 1 })
    await store.putArtifact(BUILD, {
      kind: 'plan',
      content: '+++\nverifySteps = ["unit"]\n+++\n# Invalid plan\n',
    })
    await expect(done(deps)).rejects.toThrow(/omits mandatory step "types"/)
    expect(await eventTypes()).not.toContain('plan.completed')

    await store.putArtifact(BUILD, {
      kind: 'plan',
      content: '+++\nverifySteps = ["unit", "types"]\n+++\n# Corrected plan\n',
    })
    const event = await done(deps)
    expect(event.payload).toEqual({
      round: 1,
      artifact: { kind: 'plan', rev: 1 },
      verifySteps: ['types', 'unit'],
    })
    expect((await store.getEvents(BUILD)).filter((item) => item.type === 'plan.completed')).toHaveLength(1)
  })
})

// ── ab done — implement (real git; push-before-event D3/D7) ──────────────────

describe('ab done — implement', () => {
  let workspace: string
  let implementationBase: string

  beforeEach(async () => {
    workspace = join(tmp, 'ws')
    await initWorkspaceRepo(workspace)
    // Simulate a branch cut from a freshly fetched remote tip while the
    // operator-owned local main ref remains one commit behind.
    implementationBase = await commitFile(
      workspace,
      'remote-base.ts',
      'export const alreadyOnBase = true\n',
      'base: remote-only work',
    )
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'git-worktree',
        ref: workspace,
        branch: BRANCH,
        base: { source: 'remote', sha: implementationBase },
      },
    })
    await commitFile(workspace, 'feature.ts', 'export const x = 1\n', 'feature work')
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 1 },
    })
  })

  function implementDeps(
    forge?: FakeForge,
    overrides: Parameters<typeof makeEnv>[0] = {},
  ): TestDeps {
    return makeDeps({
      store,
      env: makeEnv({ phase: 'implement', round: 1, ...overrides }),
      workspacePath: workspace,
      ...(forge !== undefined ? { forge } : {}),
    })
  }

  test('--notes is required', async () => {
    const deps = implementDeps()
    await expect(done(deps)).rejects.toThrow(/--notes <file> is required/)
  })

  test('missing initial provisioning evidence is rejected before push or deposit', async () => {
    await store.close()
    store = await seedStore()
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 1 },
    })
    const deps = implementDeps()
    const notes = await stash('missing-base-notes.md', 'must not be deposited\n')

    await expect(done(deps, { notes })).rejects.toThrow(
      /requires a workspace\.provisioned base SHA.*no workspace\.provisioned event/,
    )
    expect(deps.forge.pushes).toEqual([])
    expect(await store.getArtifact(BUILD, 'implement-notes')).toBeNull()
  })

  test('a dirty worktree is rejected, listing the offending files', async () => {
    await writeFile(join(workspace, 'uncommitted.ts'), 'dirty\n')
    const deps = implementDeps()
    const notes = await stash('notes.md', 'did the thing\n')
    await expect(done(deps, { notes })).rejects.toThrow(
      /requires a clean worktree \(D5\)[\s\S]*uncommitted\.ts/,
    )
    // Precondition failure means no plumbing ran and no event was appended.
    expect(deps.forge.pushes).toEqual([])
    expect(await eventTypes()).not.toContain('implement.completed')
  })

  test('.ab/ scratch never dirties the worktree — ab context establishes the gitignore itself (§7, §8.3)', async () => {
    // The fixture repo, like any real repo, does NOT gitignore .ab/ — the
    // product must establish "the gitignored .ab/" (§7) on its own, or every
    // implement/reconcile done wedges on `?? .ab/` (or coerces committing
    // scratch). `ab context` writes a self-excluding .ab/.gitignore.
    const deps = implementDeps()
    await buildContext({ store, env: deps.env, workspacePath: workspace })
    const notes = join(workspace, '.ab', 'implement-notes.md')
    await writeFile(notes, 'notes live in scratch\n')

    const event = await done(deps, { notes })
    expect(event.type).toBe('implement.completed')
    // The scratch dir is intact and invisible to git — not committed away.
    expect(await runGit(['status', '--porcelain'], workspace)).toBe('')
    expect(await runGit(['ls-files', '.ab'], workspace)).toBe('')
  })

  test('anchors every review round to the first provisioned base and deposits atomically', async () => {
    const deps = implementDeps()
    const notes = await stash('notes.md', 'implemented rate limiting\n')
    const firstHead = await runGit(['rev-parse', 'HEAD'], workspace)
    const staleLocalMain = await runGit(['rev-parse', 'main'], workspace)

    const first = await done(deps, { notes })

    expect(implementationBase).not.toBe(staleLocalMain)
    expect(deps.forge.pushes).toEqual([{ workspacePath: workspace, branch: BRANCH }])
    expect(first.type).toBe('implement.completed')
    expect(first.payload).toEqual({
      round: 1,
      commits: { base: implementationBase, head: firstHead },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(
      await runGit(
        ['log', '--reverse', '--format=%s', `${implementationBase}..${firstHead}`],
        workspace,
      ),
    ).toBe('feature work')

    // A recovered sandbox records the existing branch tip. It is resume
    // evidence, not a replacement for the original review anchor.
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'git-worktree',
        ref: workspace,
        branch: BRANCH,
        base: { source: 'existing', sha: firstHead },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 2 },
    })
    const secondHead = await commitFile(
      workspace,
      'follow-up.ts',
      'export const followUp = true\n',
      'feature follow-up',
    )
    const secondNotes = await stash('notes-r2.md', 'addressed review feedback\n')
    const second = await done(
      implementDeps(deps.forge, { round: 2, session: 's_r2' }),
      { notes: secondNotes },
    )

    expect(second.payload).toEqual({
      round: 2,
      commits: { base: implementationBase, head: secondHead },
      artifact: { kind: 'implement-notes', rev: 1 },
    })
    expect(deps.forge.pushes).toEqual([
      { workspacePath: workspace, branch: BRANCH },
      { workspacePath: workspace, branch: BRANCH },
    ])
    expect(
      await runGit(
        ['log', '--reverse', '--format=%s', `${implementationBase}..${secondHead}`],
        workspace,
      ),
    ).toBe('feature work\nfeature follow-up')
    expect(
      (await store.getEvents(BUILD))
        .filter((event) => event.type === 'implement.completed')
        .map((event) => event.payload.commits.base),
    ).toEqual([implementationBase, implementationBase])
    expect(textContent((await store.getArtifact(BUILD, 'implement-notes', 0))!)).toBe(
      'implemented rate limiting\n',
    )
    expect(textContent((await store.getArtifact(BUILD, 'implement-notes'))!)).toBe(
      'addressed review feedback\n',
    )
  })

  test('detached HEAD publishes the completed commit to the durable build branch', async () => {
    const remote = join(tmp, 'implement-origin.git')
    await initBareOrigin(workspace, remote)
    const attachedTip = await runGit(['rev-parse', BRANCH], workspace)
    expect(await remoteBranchHead(remote)).toBe(attachedTip)

    await runGit(['checkout', '-q', '--detach', 'HEAD'], workspace)
    const head = await commitFile(
      workspace,
      'detached.ts',
      'export const detached = true\n',
      'detached implementation',
    )
    expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).toBe(
      'HEAD',
    )
    expect(await runGit(['rev-parse', BRANCH], workspace)).toBe(attachedTip)

    const notes = await stash('detached-notes.md', 'completed while detached\n')
    const deps = { ...implementDeps(), forge: new GitHubForge() }
    const event = await done(deps, { notes })

    expect(event.type).toBe('implement.completed')
    expect(event.payload).toEqual({
      round: 1,
      commits: {
        base: implementationBase,
        head,
      },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(await remoteBranchHead(remote)).toBe(head)
    expect(textContent((await store.getArtifact(BUILD, 'implement-notes'))!)).toBe(
      'completed while detached\n',
    )
  })

  test('a detached non-fast-forward update is rejected before the terminal bundle', async () => {
    const remote = join(tmp, 'divergent-origin.git')
    await initBareOrigin(workspace, remote)
    const remoteBase = await remoteBranchHead(remote)

    await runGit(['checkout', '-q', '--detach', remoteBase], workspace)
    const completedHead = await commitFile(
      workspace,
      'completed.ts',
      'completed head\n',
      'detached completion',
    )

    await runGit(['checkout', '-q', BRANCH], workspace)
    const divergentHead = await commitFile(
      workspace,
      'remote.ts',
      'divergent remote head\n',
      'advance remote independently',
    )
    await runGit(
      ['push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`],
      workspace,
    )
    await runGit(['checkout', '-q', '--detach', completedHead], workspace)
    expect(await remoteBranchHead(remote)).toBe(divergentHead)

    const notes = await stash('non-ff-notes.md', 'must not be deposited\n')
    const deps = { ...implementDeps(), forge: new GitHubForge() }
    const error = await done(deps, { notes })
      .then(() => null)
      .catch((reason: unknown) => reason as Error)

    expect(error?.message).toContain(`HEAD:refs/heads/${BRANCH}`)
    expect(error?.message).toContain('non-fast-forward')
    expect(await remoteBranchHead(remote)).toBe(divergentHead)
    expect(await eventTypes()).not.toContain('implement.completed')
    expect(await store.getArtifact(BUILD, 'implement-notes')).toBeNull()
  })

  test('push failure leaves NO event and NO notes artifact (push happens first)', async () => {
    class ExplodingForge extends FakeForge {
      override async pushBranch(): Promise<void> {
        throw new Error('remote unreachable')
      }
    }
    const deps = implementDeps(new ExplodingForge())
    const notes = await stash('notes.md', 'notes\n')

    await expect(done(deps, { notes })).rejects.toThrow(/remote unreachable/)
    expect(await eventTypes()).not.toContain('implement.completed')
    expect(await store.getArtifact(BUILD, 'implement-notes')).toBeNull()
  })
})

// ── ab done — finalize (D7: the CLI call IS the kernel plumbing) ─────────────

describe('ab done — finalize', () => {
  let workspace: string
  const IMAGE_HOST = {
    provider: 'github-release' as const,
    repository: 'acme/review-assets',
    releaseId: 42,
  }

  async function resetStoreWithImageHost(): Promise<void> {
    await store.close()
    store = await seedStore({ imageHost: IMAGE_HOST })
  }

  beforeEach(async () => {
    workspace = join(tmp, 'ws-finalize')
    await initWorkspaceRepo(workspace)
    // A verdict history and verify results for the §7.5 summary comment.
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
      actor: agent('code-review'),
      type: 'code-review.verdict',
      payload: { round: 2, verdict: 'approve', findings: [], artifact: { kind: 'code-review', rev: 1 } },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'types', attempt: 1, pass: true },
    })
    await store.append(BUILD, {
      actor: agent('verify:e2e'),
      type: 'verify.completed',
      payload: {
        step: 'e2e',
        attempt: 1,
        outcome: 'skipped',
        reason: 'No browser-facing behavior changed',
      },
    })
  })

  async function designateAttachment(input: {
    kind: string
    filename: string
    mediaType: string
    content: string | Uint8Array
  }) {
    const meta = await store.putArtifact(BUILD, {
      kind: input.kind,
      content: input.content,
    })
    return store.append(BUILD, {
      actor: agent('verify:visual-check'),
      type: 'pr-attachment.designated',
      payload: {
        artifact: { kind: meta.kind, rev: meta.revision },
        filename: input.filename,
        mediaType: input.mediaType,
      },
    })
  }

  test('rejected without a pr-description artifact', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'finalize' }), workspacePath: workspace })
    await expect(done(deps)).rejects.toThrow(
      /requires a deposited pr-description artifact.*ab artifact put pr-description/s,
    )
    expect(deps.forge.opened).toEqual([])
  })

  test('opens the PR (title = first line sans #, body = rest), appends kernel-actor event, posts the summary', async () => {
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nCloses ENG-42.\nDetails inside.\n',
    })
    const deps = makeDeps({ store, env: makeEnv({ phase: 'finalize' }), workspacePath: workspace })

    const event = await done(deps)

    expect(deps.forge.opened).toEqual([
      {
        workspacePath: workspace,
        head: BRANCH,
        base: 'main',
        title: 'Add auth rate limiting',
        body: 'Closes ENG-42.\nDetails inside.\n',
      },
    ])
    // §15.3: finalize.completed's actor is the KERNEL — the kernel opens the
    // PR after the agent's `ab done` (D7).
    expect(event.actor).toEqual({ kind: 'kernel' })
    expect(event.type).toBe('finalize.completed')
    expect(event.payload).toEqual({
      pr: { number: 1, url: 'https://fake.forge/pr/1', headSha: 'sha-1' },
    })

    // §7.5: summary comment renders verdict history + verify results.
    expect(deps.forge.comments).toHaveLength(1)
    const comment = deps.forge.comments[0]!
    expect(comment.number).toBe(1)
    expect(comment.body).toContain('code-review r1: revise (2 findings)')
    expect(comment.body).toContain('code-review r2: approve')
    expect(comment.body).toContain('<code>types</code> (attempt 1): pass')
    expect(comment.body).toContain(
      '<code>e2e</code> (attempt 1): skipped — No browser-facing behavior changed',
    )
    expect(comment.body).toContain(`build: <code>${BUILD}</code>`)
  })

  test('detached HEAD still opens the PR from the durable build branch', async () => {
    await runGit(['checkout', '-q', '--detach', 'HEAD'], workspace)
    expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).toBe(
      'HEAD',
    )
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Detached finalize\n\nBody.\n',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
    })

    const event = await done(deps)

    expect(event.type).toBe('finalize.completed')
    expect(deps.forge.opened).toHaveLength(1)
    expect(deps.forge.opened[0]!.head).toBe(BRANCH)
  })

  test('lists image and non-image designations from an arbitrary verifier without a host', async () => {
    await designateAttachment({
      kind: 'visual:home',
      filename: 'home.png',
      mediaType: 'image/png',
      content: new Uint8Array([137, 80, 78, 71]),
    })
    await designateAttachment({
      kind: 'visual:trace',
      filename: 'trace.txt',
      mediaType: 'text/plain',
      content: 'trace evidence\n',
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Attached evidence\n\nBody.\n',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
    })

    await done(deps)

    const comment = deps.forge.comments[0]!.body
    expect(comment).toContain('### PR attachments')
    expect(comment).toContain('<code>visual:home@0</code>')
    expect(comment).toContain('<code>visual:trace@0</code>')
    expect(comment).toContain(
      "ab artifact download &#39;auth-rate-limit&#39; &#39;visual:home@0&#39; --output &#39;home.png&#39; --store &#39;/tmp/ab-store&#39;",
    )
    expect(comment).toContain(
      "ab artifact download &#39;auth-rate-limit&#39; &#39;visual:trace@0&#39; --output &#39;trace.txt&#39; --store &#39;/tmp/ab-store&#39;",
    )
    expect(comment).not.toContain('<img ')
  })

  test('configured hosting uploads images only, renders them inline, and writes nothing to Git', async () => {
    await resetStoreWithImageHost()
    const imageDesignation = await designateAttachment({
      kind: 'visual:home',
      filename: 'home.png',
      mediaType: 'image/png',
      content: new Uint8Array([137, 80, 78, 71, 1]),
    })
    await designateAttachment({
      kind: 'visual:trace',
      filename: 'trace.json',
      mediaType: 'application/json',
      content: '{}\n',
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Hosted evidence\n\nBody.\n',
    })
    const forge = new FakeForge({ prAttachments: true })
    const upload = forge.prAttachments!.upload.bind(forge.prAttachments)
    forge.prAttachments!.upload = async (request) => ({
      ...(await upload(request)),
      url: 'https://fake.forge/pr-attachments/1/home.png?a=1&b=2',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge,
    })

    const event = await done(deps)

    expect(event.type).toBe('finalize.completed')
    expect(forge.prAttachmentUploads).toHaveLength(1)
    expect(forge.prAttachmentUploads[0]!.attachment).toEqual(
      imageDesignation.payload,
    )
    expect([...forge.prAttachmentUploads[0]!.content]).toEqual([
      137, 80, 78, 71, 1,
    ])
    const events = await store.getEvents(BUILD)
    const hosted = events.find((item) => item.type === 'pr-attachment.hosted')
    expect(hosted?.actor).toEqual(KERNEL)
    expect(hosted?.payload).toMatchObject({
      designationSeq: imageDesignation.seq,
      asset: IMAGE_HOST,
    })
    expect(events.map((item) => item.type).indexOf('pr-attachment.hosted')).toBeLessThan(
      events.map((item) => item.type).indexOf('finalize.completed'),
    )

    const comment = forge.comments[0]!.body
    expect(comment).toContain(
      '<img src="https://fake.forge/pr-attachments/1/home.png?a=1&amp;b=2" alt="PR attachment home.png">',
    )
    expect(comment).toContain('<code>visual:trace@0</code>')
    expect(await runGit(['status', '--porcelain'], workspace)).toBe('')
    expect(await runGit(['ls-files', '*.png'], workspace)).toBe('')
  })

  test('a finalize store failure reuses the prior hosted fact instead of uploading again', async () => {
    await resetStoreWithImageHost()
    await designateAttachment({
      kind: 'visual:retry',
      filename: 'retry.png',
      mediaType: 'image/png',
      content: new Uint8Array([1, 2, 3]),
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Retry hosted evidence\n\nBody.\n',
    })
    const forge = new FakeForge({ prAttachments: true })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge,
    })
    const append = store.append.bind(store)
    let failFinalizeOnce = true
    store.append = (async (slug, event) => {
      if (event.type === 'finalize.completed' && failFinalizeOnce) {
        failFinalizeOnce = false
        throw new Error('store unavailable at finalize commit')
      }
      return append(slug, event)
    }) as typeof store.append

    await expect(done(deps)).rejects.toThrow('store unavailable at finalize commit')
    expect(forge.prAttachmentUploads).toHaveLength(1)
    expect(
      (await store.getEvents(BUILD)).filter(
        (event) => event.type === 'pr-attachment.hosted',
      ),
    ).toHaveLength(1)

    const event = await done(deps)
    expect(event.type).toBe('finalize.completed')
    expect(forge.opened).toHaveLength(1)
    expect(forge.prAttachmentUploads).toHaveLength(1)
    expect(forge.comments[0]!.body).toContain('<img ')
  })

  test('hosting failures record kernel follow-ups and retain complete text projection', async () => {
    await resetStoreWithImageHost()
    await designateAttachment({
      kind: 'visual:failed',
      filename: 'failed.png',
      mediaType: 'image/png',
      content: new Uint8Array([4, 5, 6]),
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Degraded evidence\n\nBody.\n',
    })
    const forge = new FakeForge({ prAttachments: true })
    forge.failNextPrAttachmentUpload('release upload unavailable')
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge,
    })

    const event = await done(deps)

    expect(event.type).toBe('finalize.completed')
    const events = await store.getEvents(BUILD)
    const observation = events.findLast(
      (item) => item.type === 'observation.recorded',
    )
    expect(observation?.actor).toEqual(KERNEL)
    expect(observation?.payload.summary).toContain('release upload unavailable')
    expect(events.some((item) => item.type === 'pr-attachment.hosted')).toBe(false)
    expect(forge.comments[0]!.body).toContain('<code>visual:failed@0</code>')
    expect(forge.comments[0]!.body).not.toContain('<img ')
  })

  test('mixed upload success is projected independently and every text command remains', async () => {
    await resetStoreWithImageHost()
    await designateAttachment({
      kind: 'visual:first',
      filename: 'first.png',
      mediaType: 'image/png',
      content: new Uint8Array([1]),
    })
    await designateAttachment({
      kind: 'visual:second',
      filename: 'second.webp',
      mediaType: 'image/webp',
      content: new Uint8Array([2]),
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Partial hosted evidence\n\nBody.\n',
    })
    const forge = new FakeForge({ prAttachments: true })
    const upload = forge.prAttachments!.upload.bind(forge.prAttachments)
    let calls = 0
    forge.prAttachments!.upload = async (request) => {
      calls += 1
      if (calls === 2) throw new Error('second image upload failed')
      return upload(request)
    }
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge,
    })

    await done(deps)

    const events = await store.getEvents(BUILD)
    expect(
      events.filter((event) => event.type === 'pr-attachment.hosted'),
    ).toHaveLength(1)
    const comment = forge.comments[0]!.body
    expect(comment).toContain('<img ')
    expect(comment).toContain('<code>visual:first@0</code>')
    expect(comment).toContain('<code>visual:second@0</code>')
  })

  test('a pre-PR auto-merge request on gated CLEAN is applied natively and acknowledged', async () => {
    class GatedCleanForge extends FakeForge {
      override async openPr(opts: Parameters<FakeForge['openPr']>[0]) {
        const pr = await super.openPr(opts)
        this.setPrState(pr.number, { state: 'open', mergeable: true })
        return pr
      }
    }
    const request = await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge: new GatedCleanForge(),
    })

    await done(deps)

    expect(deps.forge.autoMergeCalls).toEqual([
      {
        workspacePath: workspace,
        number: 1,
        enabled: true,
        changed: true,
      },
    ])
    const events = await store.getEvents(BUILD)
    const applied = events.find((event) => event.type === 'pr.auto-merge-enabled')
    expect(applied?.actor).toEqual(KERNEL)
    expect(applied?.payload).toEqual({ commandSeq: request.seq })
    expect(events.map((event) => event.type)).toContain('finalize.completed')
    expect(events.map((event) => event.type)).toContain('pr.auto-merge-enabled')
  })

  test('proved ungated CLEAN finalizes successfully but leaves intent pending for the janitor', async () => {
    class UngatedCleanForge extends FakeForge {
      constructor() {
        super({ gatePresence: 'absent' })
      }
      override async openPr(opts: Parameters<FakeForge['openPr']>[0]) {
        const pr = await super.openPr(opts)
        this.setPrState(pr.number, { state: 'open', mergeable: true })
        return pr
      }
    }
    await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    const forge = new UngatedCleanForge()

    const event = await done(
      makeDeps({
        store,
        env: makeEnv({ phase: 'finalize' }),
        workspacePath: workspace,
        forge,
      }),
    )

    expect(event.type).toBe('finalize.completed')
    expect(forge.squashMergeCalls).toEqual([])
    expect(forge.autoMergeCalls).toEqual([
      {
        workspacePath: workspace,
        number: 1,
        enabled: true,
        changed: false,
      },
    ])
    const types = (await store.getEvents(BUILD)).map((entry) => entry.type)
    expect(types).not.toContain('pr.auto-merge-enabled')
    expect(types).not.toContain('escalation.raised')
  })

  test('ungated transient state also finalizes without falsely acknowledging native state', async () => {
    const forge = new FakeForge({ gatePresence: 'absent' }) // just-opened = UNKNOWN
    await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })

    await done(
      makeDeps({
        store,
        env: makeEnv({ phase: 'finalize' }),
        workspacePath: workspace,
        forge,
      }),
    )

    const types = (await store.getEvents(BUILD)).map((entry) => entry.type)
    expect(types).toContain('finalize.completed')
    expect(types).not.toContain('pr.auto-merge-enabled')
    expect(forge.squashMergeCalls).toEqual([])
  })

  test('re-reads intent after openPr, so a command landing during finalize is not missed', async () => {
    const request = await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    class CancellingForge extends FakeForge {
      override async openPr(opts: Parameters<FakeForge['openPr']>[0]) {
        const pr = await super.openPr(opts)
        await store.append(BUILD, {
          actor: humanActor('operator'),
          type: 'build.auto-merge-cancelled',
          payload: {},
        })
        return pr
      }
    }
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    const forge = new CancellingForge()
    await done(
      makeDeps({
        store,
        env: makeEnv({ phase: 'finalize' }),
        workspacePath: workspace,
        forge,
      }),
    )

    expect(forge.autoMergeCalls).toHaveLength(1)
    expect(forge.autoMergeCalls[0]).toMatchObject({ enabled: false })
    const events = await store.getEvents(BUILD)
    const cancellation = events.find((event) => event.type === 'build.auto-merge-cancelled')
    const applied = events.find((event) => event.type === 'pr.auto-merge-disabled')
    expect(cancellation?.seq).toBeGreaterThan(request.seq)
    expect(cancellation).toBeDefined()
    expect(applied?.payload).toEqual({ commandSeq: cancellation!.seq })
  })

  test('auto-merge forge failure leaves finalize uncommitted and retryable', async () => {
    class RejectingAutoMergeForge extends FakeForge {
      override async setAutoMerge(): Promise<never> {
        throw new Error('repository policy disables auto-merge')
      }
    }
    await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    await expect(
      done(
        makeDeps({
          store,
          env: makeEnv({ phase: 'finalize' }),
          workspacePath: workspace,
          forge: new RejectingAutoMergeForge(),
        }),
      ),
    ).rejects.toThrow('repository policy disables auto-merge')
    expect(await eventTypes()).not.toContain('finalize.completed')
  })

  test('crash between openPr and the event: the retry ADOPTS the existing PR instead of wedging (§8.7)', async () => {
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    const forge = new FakeForge()
    // The crashed first attempt opened the PR, but the store append failed
    // (§8.7: store unreachable) — no finalize.completed in the log.
    const crashed = await forge.openPr({
      workspacePath: 'elsewhere',
      head: BRANCH,
      base: 'main',
      title: 'Add auth rate limiting',
      body: 'Body.\n',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge,
    })

    const event = await done(deps)

    // Adopted, not duplicated — and the event records the live PR.
    expect(forge.opened).toHaveLength(1)
    expect(event.type).toBe('finalize.completed')
    expect(event.payload).toEqual({
      pr: { number: crashed.number, url: crashed.url, headSha: crashed.headSha },
    })
  })

  test('a comment failure AFTER the terminal committed does not fail ab done (§7.5 is best-effort)', async () => {
    class NoCommentForge extends FakeForge {
      override async commentOnPr(): Promise<void> {
        throw new Error('comment API down')
      }
    }
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting\n\nBody.\n',
    })
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'finalize' }),
      workspacePath: workspace,
      forge: new NoCommentForge(),
    })

    // Were this to throw, the agent's retry would be rejected as a second
    // terminal (D5) for an event that actually committed.
    const event = await done(deps)
    expect(event.type).toBe('finalize.completed')
    expect(await eventTypes()).toContain('finalize.completed')
  })

  test('a pre-restart finalize.completed does not block the rebuilt pipeline’s finalize (§6.3)', async () => {
    // A prior pipeline pass finalized; then an escalation was answered
    // revise-spec and the build restarted from plan (§6.3). The engine
    // resets finalize across the spec.revised boundary, so the CLI must too.
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 9, url: 'https://fake.forge/pr/9', headSha: 'sha-old' } },
    })
    await store.putArtifact(BUILD, { kind: 'spec', content: '# Spec rev 1\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1 },
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Add auth rate limiting (rebuilt)\n\nBody.\n',
    })
    const deps = makeDeps({ store, env: makeEnv({ phase: 'finalize' }), workspacePath: workspace })

    const event = await done(deps)
    expect(event.type).toBe('finalize.completed')
    expect(deps.forge.opened).toHaveLength(1)
  })
})

// ── ab done — reconcile (merge commit + regular push, D1) ────────────────────

describe('ab done — reconcile', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = join(tmp, 'ws-reconcile')
    await initWorkspaceRepo(workspace)
    await commitFile(workspace, 'feature.ts', 'branch work\n', 'feature work')
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-conflict' },
    })
  })

  test('rejected when HEAD is not a merge commit', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'reconcile', round: 1 }), workspacePath: workspace })
    const notes = await stash('rec.md', 'merged base\n')
    await expect(done(deps, { notes })).rejects.toThrow(
      /HEAD to be a merge commit \(2\+ parents\).*has 1 parent/s,
    )
    expect(deps.forge.pushes).toEqual([])
  })

  test('on a real merge commit: pushes (never force) and records the merge commit', async () => {
    // Diverge main, then merge it into the branch — a genuine 2-parent HEAD.
    await runGit(['checkout', '-q', 'main'], workspace)
    await commitFile(workspace, 'base.ts', 'base moved on\n', 'base work')
    await runGit(['checkout', '-q', BRANCH], workspace)
    await runGit([
      '-c', 'user.email=ab@test.invalid', '-c', 'user.name=ab-test',
      '-c', 'commit.gpgsign=false',
      'merge', '--no-ff', '-m', 'merge main into branch', 'main',
    ], workspace)
    const mergeSha = await runGit(['rev-parse', 'HEAD'], workspace)

    const deps = makeDeps({ store, env: makeEnv({ phase: 'reconcile', round: 1 }), workspacePath: workspace })
    const notes = await stash('rec.md', 'resolved conflicts against main\n')
    const event = await done(deps, { notes })

    expect(deps.forge.pushes).toEqual([{ workspacePath: workspace, branch: BRANCH }])
    expect(event.type).toBe('reconcile.completed')
    expect(event.payload).toEqual({
      mergeCommit: mergeSha,
      artifact: { kind: 'reconcile-notes', rev: 0 },
    })
    const deposited = await store.getArtifact(BUILD, 'reconcile-notes')
    expect(textContent(deposited!)).toBe('resolved conflicts against main\n')
  })

  test('detached merge HEAD publishes to the durable branch before completion', async () => {
    const remote = join(tmp, 'reconcile-origin.git')
    await initBareOrigin(workspace, remote)
    const attachedTip = await runGit(['rev-parse', BRANCH], workspace)

    await runGit(['checkout', '-q', 'main'], workspace)
    await commitFile(workspace, 'base.ts', 'new base\n', 'advance base')
    await runGit(['checkout', '-q', '--detach', attachedTip], workspace)
    await runGit(
      [
        '-c',
        'user.email=ab@test.invalid',
        '-c',
        'user.name=ab-test',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '-m',
        'merge main while detached',
        'main',
      ],
      workspace,
    )
    const mergeSha = await runGit(['rev-parse', 'HEAD'], workspace)
    expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).toBe(
      'HEAD',
    )
    expect(await runGit(['rev-parse', BRANCH], workspace)).toBe(attachedTip)

    const notes = await stash('detached-rec.md', 'detached merge completed\n')
    const deps = {
      ...makeDeps({
        store,
        env: makeEnv({ phase: 'reconcile', round: 1 }),
        workspacePath: workspace,
      }),
      forge: new GitHubForge(),
    }
    const event = await done(deps, { notes })

    expect(event.type).toBe('reconcile.completed')
    expect(event.payload).toEqual({
      mergeCommit: mergeSha,
      artifact: { kind: 'reconcile-notes', rev: 0 },
    })
    expect(await remoteBranchHead(remote)).toBe(mergeSha)
    expect(textContent((await store.getArtifact(BUILD, 'reconcile-notes'))!)).toBe(
      'detached merge completed\n',
    )
  })

  test('push failure leaves NO reconcile event and NO notes artifact', async () => {
    await runGit(['checkout', '-q', 'main'], workspace)
    await commitFile(workspace, 'base.ts', 'new base\n', 'advance base')
    await runGit(['checkout', '-q', BRANCH], workspace)
    await runGit(
      [
        '-c',
        'user.email=ab@test.invalid',
        '-c',
        'user.name=ab-test',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '-m',
        'merge main into branch',
        'main',
      ],
      workspace,
    )
    class ExplodingForge extends FakeForge {
      override async pushBranch(): Promise<void> {
        throw new Error('remote rejected reconciliation')
      }
    }
    const deps = makeDeps({
      store,
      env: makeEnv({ phase: 'reconcile', round: 1 }),
      workspacePath: workspace,
      forge: new ExplodingForge(),
    })
    const notes = await stash('failed-rec.md', 'must not be deposited\n')

    await expect(done(deps, { notes })).rejects.toThrow(
      'remote rejected reconciliation',
    )
    expect(await eventTypes()).not.toContain('reconcile.completed')
    expect(await store.getArtifact(BUILD, 'reconcile-notes')).toBeNull()
  })
})

// ── ab verdict — vocabulary (§8.2, both directions) ──────────────────────────

describe('ab verdict — vocabulary enforcement (§8.2)', () => {
  test('a review phase rejects pass, citing the exact rule and its own vocabulary', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    await expect(verdict(deps, { verdict: 'pass' })).rejects.toThrow(
      /review phases accept approve\|revise\|escalate; agent-verify steps accept pass\|fail\|skip\. code-review accepts: approve\|revise\|escalate/,
    )
  })

  test('an agent-verify phase rejects approve, citing pass|fail|skip', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e' }) })
    await expect(verdict(deps, { verdict: 'approve' })).rejects.toThrow(
      /verify:e2e accepts: pass\|fail\|skip/,
    )
  })

  test('verdict in a producer phase is rejected naming done', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'implement' }) })
    await expect(verdict(deps, { verdict: 'approve' })).rejects.toThrow(
      /producer phase; use 'ab done'/,
    )
  })
})

// ── ab verdict — review phases (D6) ──────────────────────────────────────────

describe('ab verdict — review phases', () => {
  test('--notes is required (deposited as the phase artifact)', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    await expect(verdict(deps, { verdict: 'approve' })).rejects.toThrow(
      /requires --notes <file>.*code-review artifact/s,
    )
  })

  test('approve: empty findings, notes deposited, one atomic event', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 1 }) })
    const notes = await stash('review.md', 'LGTM — clean separation\n')
    const events = await verdict(deps, { verdict: 'approve', notes })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('code-review.verdict')
    expect(events[0]!.payload).toEqual({
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    })
    const artifact = await store.getArtifact(BUILD, 'code-review')
    expect(textContent(artifact!)).toBe('LGTM — clean separation\n')
  })

  test('revise without --findings is rejected with the schema shape', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    const notes = await stash('review.md', 'issues\n')
    await expect(verdict(deps, { verdict: 'revise', notes })).rejects.toThrow(
      /requires --findings <json file>[\s\S]*"severity": "blocking" \| "important" \| "minor"/,
    )
  })

  test('malformed findings JSON returns the schema and the parse error (D6)', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    const notes = await stash('review.md', 'issues\n')
    const findings = await stash('findings.json', '{ not json')
    await expect(verdict(deps, { verdict: 'revise', notes, findings })).rejects.toThrow(
      /is not valid JSON:[\s\S]*Expected shape \(D6\):[\s\S]*"persists"/,
    )
  })

  test('schema-invalid findings return the zod issue and the shape (D6)', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    const notes = await stash('review.md', 'issues\n')
    const findings = await stash(
      'findings.json',
      JSON.stringify([{ severity: 'catastrophic', summary: 'bad' }]),
    )
    await expect(verdict(deps, { verdict: 'revise', notes, findings })).rejects.toThrow(
      /does not match the finding schema \(D6\):[\s\S]*0\.severity[\s\S]*Expected shape/,
    )
    // Validation failed before any deposit — atomic (D6).
    expect(await store.getArtifact(BUILD, 'code-review')).toBeNull()
  })

  test('persists referencing an unknown id is rejected listing the known ids', async () => {
    await store.append(BUILD, {
      actor: agent('code-review'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_prev1'), finding('f_prev2')],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 2 }) })
    const notes = await stash('review.md', 'issues\n')
    const findings = await stash(
      'findings.json',
      JSON.stringify([
        { severity: 'blocking', summary: 'still broken', persists: ['f_bogus'] },
      ]),
    )
    await expect(verdict(deps, { verdict: 'revise', notes, findings })).rejects.toThrow(
      /persists id "f_bogus" does not exist in prior rounds' findings.*known ids: f_prev1, f_prev2/s,
    )
  })

  test('revise stamps sequential ids and honors valid persists links', async () => {
    await store.putArtifact(BUILD, { kind: 'code-review', content: 'round 1 notes\n' })
    await store.append(BUILD, {
      actor: agent('code-review'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_prev1')],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 2 }) })
    const notes = await stash('review.md', 'round 2 issues\n')
    const findings = await stash(
      'findings.json',
      JSON.stringify([
        { severity: 'blocking', summary: 'same disagreement', persists: ['f_prev1'] },
        { severity: 'minor', summary: 'new nit' },
      ]),
    )
    const events = await verdict(deps, { verdict: 'revise', notes, findings })

    expect(events).toHaveLength(1)
    const payload = events[0]!.payload as {
      findings: Finding[]
      artifact: { kind: string; rev: number }
    }
    // Ids are kernel-assigned at deposit (§15.4), in order: f_1, f_2.
    expect(payload.findings.map((f) => f.id)).toEqual(['f_1', 'f_2'])
    expect(payload.findings[0]!.persists).toEqual(['f_prev1'])
    expect(payload.artifact).toEqual({ kind: 'code-review', rev: 1 })
  })

  test('revise atomicity: a forced validation failure leaves NEITHER artifact nor event', async () => {
    // round 0 bypasses env resolution and fails the payload schema at append.
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 0 }) })
    const notes = await stash('review.md', 'notes\n')
    const findings = await stash(
      'findings.json',
      JSON.stringify([{ severity: 'minor', summary: 'nit' }]),
    )
    await expect(verdict(deps, { verdict: 'revise', notes, findings })).rejects.toThrow(
      /invalid payload for "code-review\.verdict"/,
    )
    expect(await store.getArtifact(BUILD, 'code-review')).toBeNull()
    expect(await eventTypes()).not.toContain('code-review.verdict')
  })

  test('escalate requires --reason', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'plan-review' }) })
    const notes = await stash('review.md', 'notes\n')
    await expect(verdict(deps, { verdict: 'escalate', notes })).rejects.toThrow(
      /requires --reason <text>/,
    )
  })

  test('escalate emits the verdict and escalation.raised pair (engine repairs the crash gap)', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'plan-review', round: 1 }) })
    const notes = await stash('review.md', 'cannot approve without a decision\n')
    const events = await verdict(deps, {
      verdict: 'escalate',
      notes,
      reason: 'spec is ambiguous about burst limits',
    })

    expect(events.map((event) => event.type)).toEqual([
      'plan-review.verdict',
      'escalation.raised',
    ])
    expect(events[0]!.payload).toEqual({
      round: 1,
      verdict: 'escalate',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
      reason: 'spec is ambiguous about burst limits',
    })
    expect(events[1]!.payload).toEqual({
      id: 'esc_1',
      phase: 'plan-review',
      round: 1,
      source: 'agent',
      question: 'spec is ambiguous about burst limits',
    })
  })

  test('verdict after verdict for the same round is rejected; the next round is not', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 1 }) })
    const notes = await stash('review.md', 'notes\n')
    await verdict(deps, { verdict: 'approve', notes })
    await expect(verdict(deps, { verdict: 'approve', notes })).rejects.toThrow(
      /second terminal call rejected \(D5\): code-review\.verdict for code-review@1/,
    )

    const round2 = makeDeps({
      store,
      env: makeEnv({ phase: 'code-review', round: 2, session: 's_round2' }),
    })
    const events = await verdict(round2, { verdict: 'approve', notes })
    expect(events[0]!.type).toBe('code-review.verdict')
  })
})

// ── ab verdict — agent-verify phases ─────────────────────────────────────────

describe('ab verdict — agent-verify', () => {
  test('pass emits verify.completed with attempt = round from AB_PHASE', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 2 }) })
    const events = await verdict(deps, { verdict: 'pass' })
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('verify.completed')
    expect(events[0]!.payload).toEqual({ step: 'e2e', attempt: 2, outcome: 'pass' })
    expect(events[0]!.actor).toEqual({
      kind: 'agent',
      role: 'verify:e2e',
      session: 's_test',
    })
  })

  test('pass with --notes deposits them as verify-report:<step> and refs them', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 1 }) })
    const notes = await stash('report.md', 'all flows drove clean\n')
    const events = await verdict(deps, { verdict: 'pass', notes })
    expect(events[0]!.payload).toEqual({
      step: 'e2e',
      attempt: 1,
      outcome: 'pass',
      report: { kind: 'verify-report:e2e', rev: 0 },
    })
    const artifact = await store.getArtifact(BUILD, 'verify-report:e2e')
    expect(textContent(artifact!)).toBe('all flows drove clean\n')
  })

  test('fail without --report is rejected naming the flag', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 1 }) })
    await expect(verdict(deps, { verdict: 'fail' })).rejects.toThrow(
      /'ab verdict fail' requires --report <file>.*verify-report:e2e/s,
    )
  })

  test('fail deposits the report and emits outcome:fail with attempt = round', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 3 }) })
    const report = await stash('report.md', 'login flow 500s\n')
    const events = await verdict(deps, { verdict: 'fail', report })
    expect(events[0]!.payload).toEqual({
      step: 'e2e',
      attempt: 3,
      outcome: 'fail',
      report: { kind: 'verify-report:e2e', rev: 0 },
    })
    const artifact = await store.getArtifact(BUILD, 'verify-report:e2e')
    expect(textContent(artifact!)).toBe('login flow 500s\n')
  })

  test('a verdict for the same step+attempt is a second terminal; other steps/attempts are not', async () => {
    await store.append(BUILD, {
      actor: agentActor('verify:e2e', 's_prior'),
      type: 'verify.completed',
      payload: { step: 'e2e', attempt: 1, pass: true },
    })
    const same = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 1 }) })
    await expect(verdict(same, { verdict: 'pass' })).rejects.toThrow(
      /second terminal call rejected/,
    )
    // A later attempt of the same step is a fresh terminal.
    const nextAttempt = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 2 }) })
    const events = await verdict(nextAttempt, { verdict: 'pass' })
    expect(events[0]!.payload).toEqual({ step: 'e2e', attempt: 2, outcome: 'pass' })
  })

  test('skip requires a non-blank reason before recording anything', async () => {
    for (const reason of [undefined, '', '   ']) {
      const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 1 }) })
      await expect(
        verdict(deps, { verdict: 'skip', ...(reason !== undefined ? { reason } : {}) }),
      ).rejects.toThrow(/'ab verdict skip' requires --reason <text>/)
    }
    expect(await eventTypes()).not.toContain('verify.completed')
    expect(await store.getArtifact(BUILD, 'verify-report:e2e')).toBeNull()
  })

  test('skip records its trimmed reason without requiring a report artifact', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 4 }) })
    const events = await verdict(deps, {
      verdict: 'skip',
      reason: '  No browser-facing behavior changed  ',
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toEqual({
      step: 'e2e',
      attempt: 4,
      outcome: 'skipped',
      reason: 'No browser-facing behavior changed',
    })
    expect(await store.getArtifact(BUILD, 'verify-report:e2e')).toBeNull()
  })

  test('a pre-restart verify.completed does not shadow the rebuilt pipeline’s attempt (§6.3)', async () => {
    // The engine resets verify attempts across a spec.revised restart
    // (pre-restart results are ignored, engine rule 7), so the rebuilt
    // pipeline legitimately reaches verify:e2e at attempt 1 AGAIN. The
    // second-terminal check must honor the same boundary — matching over the
    // full log wedges every agent-verify step after a restart.
    await store.append(BUILD, {
      actor: agentActor('verify:e2e', 's_prior'),
      type: 'verify.completed',
      payload: { step: 'e2e', attempt: 1, pass: true },
    })
    await store.putArtifact(BUILD, { kind: 'spec', content: '# Spec rev 1\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1 },
    })

    const deps = makeDeps({ store, env: makeEnv({ phase: 'verify:e2e', round: 1 }) })
    const events = await verdict(deps, { verdict: 'pass' })
    expect(events[0]!.payload).toEqual({ step: 'e2e', attempt: 1, outcome: 'pass' })

    // Within the SAME post-restart cycle, the duplicate is still rejected.
    const dup = makeDeps({
      store,
      env: makeEnv({ phase: 'verify:e2e', round: 1, session: 's_dup' }),
    })
    await expect(verdict(dup, { verdict: 'pass' })).rejects.toThrow(
      /second terminal call rejected/,
    )
  })
})

// ── Zombie sessions (D5: only the live retry may complete a round) ───────────

describe('terminals — zombie sessions (D5)', () => {
  test('a terminal from a session the log already ended is rejected', async () => {
    // The runner ended s_test (no-terminal failure) and started a retry; the
    // zombie's still-in-flight `ab done` must not land a terminal the runner
    // would misattribute to the retry.
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_test', role: 'plan', runner: 'fake', phase: 'plan', round: 1 },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'session.ended',
      payload: {
        session: 's_test',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      },
    })
    const deps = planDeps({ round: 1 })
    await expect(done(deps)).rejects.toThrow(
      /session "s_test" already ended.*only the live retry/s,
    )
    // The same guard covers verdict-shaped and escalate terminals.
    await expect(escalate(deps, { question: 'zombie question' })).rejects.toThrow(
      /already ended/,
    )
  })

  test('a terminal after this session’s phase round failed is rejected; the retry’s own is not', async () => {
    // s_test started, the runner recorded phase.failed for plan@1 (its
    // session.ended never landed — the transcript deposit can fail §15.6-C),
    // and retry s_retry started at the same round.
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_test', role: 'plan', runner: 'fake', phase: 'plan', round: 1 },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'phase.failed',
      payload: { phase: 'plan', round: 1, attempt: 1, error: 'no-terminal', willRetry: true },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_retry', role: 'plan', runner: 'fake', phase: 'plan', round: 1 },
    })

    const zombie = planDeps({ round: 1 })
    await expect(done(zombie)).rejects.toThrow(
      /plan@1 already failed after this session started.*retry session owns this round/s,
    )

    // The retry (started AFTER the failure) completes the round normally.
    const retry = planDeps({ round: 1, session: 's_retry' })
    const event = await done(retry)
    expect(event.type).toBe('plan.completed')
    expect(event.actor).toEqual({ kind: 'agent', role: 'plan', session: 's_retry' })
  })
})

// ── ab escalate ──────────────────────────────────────────────────────────────

describe('ab escalate', () => {
  test('parks the build: escalation.raised with stamped id, phase, round, refs', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'implement', round: 2 }) })
    const event = await escalate(deps, {
      question: 'spec conflicts with existing middleware — which wins?',
      refs: ['src/auth.ts', 'ENG-42'],
    })
    expect(event.type).toBe('escalation.raised')
    expect(event.payload).toEqual({
      id: 'esc_1',
      phase: 'implement',
      round: 2,
      source: 'agent',
      question: 'spec conflicts with existing middleware — which wins?',
      refs: ['src/auth.ts', 'ENG-42'],
    })
    expect(event.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_test' })
  })

  test('a second escalate from the same session is rejected (D5)', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'implement', round: 1 }) })
    await escalate(deps, { question: 'first question' })
    await expect(escalate(deps, { question: 'second question' })).rejects.toThrow(
      /this session already escalated/,
    )
  })

  test('an empty question is rejected', async () => {
    const deps = makeDeps({ store, env: makeEnv({ phase: 'plan' }) })
    await expect(escalate(deps, { question: '   ' })).rejects.toThrow(/requires a question/)
  })
})

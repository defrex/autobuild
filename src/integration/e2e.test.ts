/**
 * End-to-end seam tests (SPEC §15.6 walkthroughs as LIVE scenarios, §8.7,
 * §12 outer loop, §15.7 janitor): the whole system composed — Dispatcher →
 * real git worktree → real BuildRunner → scripted agents driving the REAL
 * `ab` CLI over one shared store → FakeForge journal → janitor epilogue.
 * See src/integration/harness.ts for what is real vs journaled-fake.
 *
 * Sequences are asserted as exact type lists (session brackets included);
 * payloads are spot-checked at every rule boundary.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveHarvestCliEnv } from '../cli/env'
import { runCli } from '../cli/main'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { normalizeVerifyCompletion } from '../events/payloads'
import { randomUuids } from '../ids'
import { decideNext } from '../kernel/engine'
import { reduceHarvest } from '../kernel/harvest'
import { reduceBuild } from '../kernel/reducer'
import { defaultTurnResult, ScriptedAgentRunner } from '../ports/runner/fake'
import { AGENT_BIN_DIR, sessionEnv } from '../ports/runner/session-env'
import { FileTicketSource } from '../ports/tickets/file'
import {
  Dispatcher,
  emptyTickReport,
  type LaunchRunnerResult,
} from '../processes/dispatcher'
import {
  HarvestRunner,
  type HarvestRunnerResult,
} from '../processes/harvest-runner'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'
import { textContent } from '../store/types'
import { steppingClock } from '../testing/fixed'
import {
  agentSession,
  commitAll,
  CONFIG_TOML,
  CONFORMING_BODY,
  GIT_ID,
  git,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  typesOf,
  writeFileIn,
  type E2eHarness,
} from './harness'

const SLUG = 'add-rate-limiting' // kebab('Add rate limiting')
const BRANCH = 'ab/add-rate-limiting'

const harnesses: E2eHarness[] = []
async function track(pending: Promise<E2eHarness>): Promise<E2eHarness> {
  const h = await pending
  harnesses.push(h)
  return h
}
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

/** §15.6 happy-path prefix: dispatch prelude + one clean pass of every loop
 * (session brackets included), ending parked on the open PR. */
const HAPPY_PREFIX = [
  'build.created',
  'workspace.provisioned',
  'spec.imported',
  'runner.attached',
  'plan.started',
  'session.started',
  'plan.completed',
  'session.ended',
  'plan-review.started',
  'session.started',
  'plan-review.verdict',
  'session.ended',
  'implement.started',
  'session.started',
  'observation.recorded',
  'implement.completed',
  'session.ended',
  'code-review.started',
  'session.started',
  'code-review.verdict',
  'session.ended',
  'verify.started',
  'verify.completed',
  'finalize.started',
  'session.started',
  'finalize.completed',
  'session.ended',
]

// ── a. Happy path, outer loop to merged (§15.6, §12, §15.7) ──────────────────

test('a. happy path: ready ticket → dispatch → pipeline → PR → janitor merges (§15.6)', async () => {
  const h = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )

  // Dispatch (§12): claim → build → real worktree → spec import → launch.
  const tick1 = await h.dispatcher.tick()
  expect(tick1).toEqual({ ...emptyTickReport(), dispatched: 1 })

  const afterDispatch = await h.events(SLUG)
  expect(typesOf(afterDispatch)).toEqual([
    'build.created',
    'workspace.provisioned',
    'spec.imported',
  ])
  const created = ofType(afterDispatch, 'build.created')[0]!
  expect(created.actor).toEqual({ kind: 'dispatcher' })
  expect(created.payload).toEqual({
    ticket: { source: 'fake', id: 'T-1', title: 'Add rate limiting' },
    repo: h.origin,
    baseBranch: 'main',
  })
  const provisioned = ofType(afterDispatch, 'workspace.provisioned')[0]!
  expect(provisioned.payload.provider).toBe('git-worktree')
  expect(provisioned.payload.branch).toBe(BRANCH)
  const ws = provisioned.payload.ref
  // A REAL worktree, checked out on the build branch with the config on it (D9).
  expect(existsSync(join(ws, 'autobuild.toml'))).toBe(true)
  expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], ws)).toBe(BRANCH)
  const imported = ofType(afterDispatch, 'spec.imported')[0]!
  expect(imported.payload.artifact).toEqual({ kind: 'spec', rev: 0 })
  expect(textContent((await h.store.getArtifact(SLUG, 'spec'))!)).toBe(CONFORMING_BODY)
  // Claim-before-launch (§12) + the dispatch projection (§13).
  expect(await h.tickets.claim('T-1')).toBe(false)
  expect(h.tickets.comments).toEqual([{ id: 'T-1', body: `build ${SLUG} dispatched` }])
  expect(h.launched.map((l) => l.slug)).toEqual([SLUG])

  // The launched BuildRunner runs the whole pipeline and parks on the PR.
  const state = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(state.status).toBe('running')
  expect(state.prState).toBe('open')
  expect(state.pr).toEqual({ number: 1, url: 'https://fake.forge/pr/1', headSha: 'sha-1' })

  const events = await h.events(SLUG)
  expect(typesOf(events)).toEqual(HAPPY_PREFIX)
  expect(decideNext(events, h.config)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })

  // Rule-boundary payloads.
  expect(ofType(events, 'runner.attached')[0]!.payload.resumedFromSeq).toBe(3)
  const planCompleted = ofType(events, 'plan.completed')[0]!
  expect(planCompleted.payload).toEqual({
    round: 1,
    artifact: { kind: 'plan', rev: 0 },
    verifySteps: ['unit'],
  })
  expect(agentSession(planCompleted)).toBe('s_1')
  const implemented = ofType(events, 'implement.completed')[0]!
  const head = await git(['rev-parse', 'HEAD'], ws)
  const base = await git(['rev-parse', 'main'], h.origin)
  expect(implemented.payload.commits).toEqual({ base, head })
  expect(implemented.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_3' })
  const observed = ofType(events, 'observation.recorded')[0]!
  expect(observed.payload).toEqual({
    id: 'obs_1',
    kind: 'refactor',
    summary: 'extract limiter config into settings',
  })
  expect(ofType(events, 'verify.started')[0]!.payload).toEqual({ step: 'unit', attempt: 1 })
  const verified = ofType(events, 'verify.completed')[0]!
  expect(verified.actor).toEqual({ kind: 'kernel' }) // deterministic check, no session (§8.2)
  expect(verified.payload).toEqual({ step: 'unit', attempt: 1, outcome: 'pass' })
  expect(ofType(events, 'finalize.completed')[0]!.actor).toEqual({ kind: 'kernel' }) // D7

  // FakeForge journal: the push (real branch) and the PR (title = the
  // pr-description's first line; §7.5 summary comment posted).
  expect(h.forge.pushes).toEqual([{ workspacePath: ws, branch: BRANCH }])
  expect(h.forge.opened).toEqual([
    {
      workspacePath: ws,
      head: BRANCH,
      base: 'main',
      title: 'Add login rate limiting',
      body: 'Throttles repeated failed logins per the spec.\n',
    },
  ])
  expect(h.forge.comments).toHaveLength(1)
  const summary = h.forge.comments[0]!
  expect(summary.number).toBe(1)
  expect(summary.body).toContain(`## Autobuild: ${SLUG}`)
  expect(summary.body).toContain('- plan-review r1: approve')
  expect(summary.body).toContain('- code-review r1: approve')
  expect(summary.body).toContain('- unit (attempt 1): pass')

  // Artifacts: every deposit, transcripts with §7.1 metadata.
  const artifacts = await h.store.listArtifacts(SLUG)
  expect(artifacts.map((m) => `${m.kind}@${m.revision}`)).toEqual([
    'code-review@0',
    'implement-notes@0',
    'plan@0',
    'plan-review@0',
    'pr-description@0',
    'spec@0',
    'transcript@0',
    'transcript@1',
    'transcript@2',
    'transcript@3',
    'transcript@4',
  ])
  const transcripts = await h.store.listArtifacts(SLUG, 'transcript')
  expect(transcripts.map((m) => m.metadata['phase'])).toEqual([
    'plan',
    'plan-review',
    'implement',
    'code-review',
    'finalize',
  ])
  expect(transcripts[2]!.metadata).toEqual({
    phase: 'implement',
    round: 1,
    role: 'implement',
    runner: 'scripted',
    session: 's_3',
    usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
  })

  // The real branch carries the implement commit (D3: code via the Forge/repo).
  expect(await git(['log', '--format=%s'], ws)).toBe('implement: rate limiting r1\ninitial')
  expect(await git(['rev-parse', `refs/heads/${BRANCH}`], h.origin)).toBe(head)

  // Janitor epilogue (§15.7, D1): merged → release → complete → ticket Done.
  h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })
  const tick2 = await h.dispatcher.tick()
  // claimRaces is 0, where it was 1 before the ready state gated the scan.
  // The config's required `[tickets].readyState = "Ready"` (readyCriteria,
  // src/processes/dispatcher.ts) means the scan only lists Ready tickets. The
  // just-merged ticket is in Done, so the scan skips it outright. Previously,
  // when a state gate could be absent, a ticket that had long since left Ready
  // was re-listed and re-refused on EVERY tick, and the refusal was miscounted
  // as a claim race. Not losing a race — never entering one.
  expect(tick2).toEqual({ ...emptyTickReport(), merged: 1, claimRaces: 0 })

  const final = await h.events(SLUG)
  expect(typesOf(final)).toEqual([
    ...HAPPY_PREFIX,
    'pr.merged',
    'workspace.released',
    'build.completed',
  ])
  expect(ofType(final, 'pr.merged')[0]!.payload).toEqual({ sha: 'squash-1' })
  expect(ofType(final, 'build.completed')[0]!.payload).toEqual({ outcome: 'merged' })
  expect(existsSync(ws)).toBe(false) // the worktree is actually gone
  expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Done' }])
  expect(h.tickets.comments.at(-1)).toEqual({
    id: 'T-1',
    body: `build ${SLUG} merged: https://fake.forge/pr/1`,
  })
  const reduced = reduceBuild(final)
  expect(reduced.status).toBe('done')
  expect(reduced.outcome).toBe('merged')
}, 30_000)

const PLAN_SELECTION_TOML = `
[project]
baseBranch = "main"
[commands]
mandatory = "echo mandatory >> verify-order.log"
omitted = "echo OMITTED >> verify-order.log"
selected = "echo selected >> verify-order.log"
[verify]
steps = ["mandatory", "omitted-check", "omitted-agent", "selected"]
[verify.mandatory]
kind = "check"
command = "mandatory"
always = true
[verify.omitted-check]
kind = "check"
command = "omitted"
[verify.omitted-agent]
kind = "agent"
skill = "ab-verify-never"
[verify.selected]
kind = "check"
command = "selected"
[dispatcher]
capacity = 1
[tickets]
source = "file"
readyLabels = ["autobuild"]
readyState = "Ready"
`

test('a0. approved plan selects optional verification while mandatory gates remain', async () => {
  const handlers = happyHandlers()
  handlers.plan = async (cli) => {
    await cli.run(['context'])
    const plan = await writeFileIn(
      cli.ws,
      '.ab/plan.md',
      [
        '+++',
        'verifySteps = ["selected", "mandatory"]',
        '+++',
        '# Plan',
        '',
        '1. Implement and verify the rate limiter.',
        '',
      ].join('\n'),
    )
    await cli.run(['artifact', 'put', 'plan', plan])
    await cli.run(['done'])
  }

  const h = await track(
    makeHarness({
      handlers,
      tickets: [readyTicket('T-1')],
      configToml: PLAN_SELECTION_TOML,
    }),
  )
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  await h.runLatest()
  expect(h.cliErrors).toEqual([])

  const events = await h.events(SLUG)
  expect(ofType(events, 'plan.completed')[0]!.payload).toEqual({
    round: 1,
    artifact: { kind: 'plan', rev: 0 },
    // Authored order cannot reorder execution.
    verifySteps: ['mandatory', 'selected'],
  })
  expect(ofType(events, 'verify.started').map((event) => event.payload.step)).toEqual([
    'mandatory',
    'omitted-check',
    'omitted-agent',
    'selected',
  ])
  expect(
    ofType(events, 'verify.completed').map((event) =>
      normalizeVerifyCompletion(event.payload),
    ),
  ).toEqual([
    { step: 'mandatory', attempt: 1, outcome: 'pass' },
    {
      step: 'omitted-check',
      attempt: 1,
      outcome: 'skipped',
      reason:
        'excluded by approved plan selection (plan@0): verify step "omitted-check" was not selected',
    },
    {
      step: 'omitted-agent',
      attempt: 1,
      outcome: 'skipped',
      reason:
        'excluded by approved plan selection (plan@0): verify step "omitted-agent" was not selected',
    },
    { step: 'selected', attempt: 1, outcome: 'pass' },
  ])

  const ws = ofType(events, 'workspace.provisioned')[0]!.payload.ref
  expect(await readFile(join(ws, 'verify-order.log'), 'utf8')).toBe(
    'mandatory\nselected\n',
  )
  expect(
    ofType(events, 'session.started').some(
      (event) => event.payload.phase === 'verify:omitted-agent',
    ),
  ).toBe(false)
  expect(reduceBuild(events).prState).toBe('open')
}, 30_000)

test('a1. dispatch cuts a new branch from remote main while local main is stale', async () => {
  const h = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )
  const staleLocalSha = await git(['rev-parse', 'refs/heads/main'], h.origin)
  const remoteSha = await h.advanceRemote(
    { 'remote-only.txt': 'landed before dispatch\n' },
    'base: remote-only change',
  )
  expect(remoteSha).not.toBe(staleLocalSha)
  expect(await git(['rev-parse', 'refs/heads/main'], h.origin)).toBe(staleLocalSha)

  expect(await h.dispatcher.tick()).toEqual({
    ...emptyTickReport(),
    dispatched: 1,
  })
  const events = await h.events(SLUG)
  expect(typesOf(events)).toEqual([
    'build.created',
    'workspace.provisioned',
    'spec.imported',
  ])
  const provisioned = ofType(events, 'workspace.provisioned')[0]!
  expect(provisioned.payload.base).toEqual({ source: 'remote', sha: remoteSha })
  expect(await git(['rev-parse', 'HEAD'], provisioned.payload.ref)).toBe(remoteSha)
  expect(existsSync(join(provisioned.payload.ref, 'remote-only.txt'))).toBe(true)
  // Provisioning uses a private destination ref; operator-owned local refs
  // remain exactly as stale as they were before dispatch.
  expect(await git(['rev-parse', 'refs/heads/main'], h.origin)).toBe(staleLocalSha)
  expect(await git(['rev-parse', 'refs/remotes/origin/main'], h.origin)).toBe(
    staleLocalSha,
  )
}, 30_000)

test('a1. unavailable origin still dispatches from local main and records why', async () => {
  const h = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )
  const localSha = await git(['rev-parse', 'refs/heads/main'], h.origin)
  await git(['remote', 'remove', 'origin'], h.origin)

  expect(await h.dispatcher.tick()).toEqual({
    ...emptyTickReport(),
    dispatched: 1,
  })
  const events = await h.events(SLUG)
  expect(typesOf(events)).toEqual([
    'build.created',
    'workspace.provisioned',
    'spec.imported',
  ])
  const provisioned = ofType(events, 'workspace.provisioned')[0]!
  expect(provisioned.payload.base.source).toBe('local')
  if (provisioned.payload.base.source !== 'local') {
    throw new Error('expected local fallback evidence')
  }
  expect(provisioned.payload.base.sha).toBe(localSha)
  expect(provisioned.payload.base.remoteError).toContain(
    'fetch --no-tags --no-write-fetch-head',
  )
  expect(provisioned.payload.base.remoteError).toMatch(
    /origin.*repository|repository.*origin/i,
  )
  expect(await git(['rev-parse', 'HEAD'], provisioned.payload.ref)).toBe(localSha)
}, 30_000)

test('gated CLEAN auto-merge requested before finalize remains GitHub-native', async () => {
  const h = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )

  await h.dispatcher.tick()
  const realOpen = h.forge.openPr.bind(h.forge)
  h.forge.openPr = async (opts) => {
    const pr = await realOpen(opts)
    // A satisfied required gate is CLEAN; it must not switch ownership merely
    // because all current requirements happen to pass.
    h.forge.setPrState(pr.number, { state: 'open', mergeable: true })
    return pr
  }
  const command = await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  const parked = await h.runLatest()
  expect(parked.prState).toBe('open')
  expect(h.forge.autoMergeCalls).toHaveLength(1)
  expect(h.forge.autoMergeCalls[0]).toMatchObject({
    number: 1,
    enabled: true,
    changed: true,
  })
  expect(h.forge.autoMergeCalls[0]!.workspacePath).toContain(
    `/worktrees/${BRANCH.replace('/', '-')}`,
  )
  expect(h.forge.isAutoMergeEnabled(1)).toBe(true)

  const applied = ofType(await h.events(SLUG), 'pr.auto-merge-enabled')[0]!
  expect(applied.actor).toEqual({ kind: 'kernel' })
  expect(applied.payload).toEqual({ commandSeq: command.seq })

  // Native auto-merge never produces completion facts directly. GitHub's
  // result is observed through the ordinary janitor path on the next poll.
  h.forge.setPrState(1, { state: 'merged', sha: 'native-squash' })
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
  const final = await h.events(SLUG)
  expect(typesOf(final).slice(-3)).toEqual([
    'pr.merged',
    'workspace.released',
    'build.completed',
  ])
  expect(reduceBuild(final).outcome).toBe('merged')
}, 30_000)

test('ungated auto-merge intent finalizes, guarded-squashes in janitor, and completes without escalation', async () => {
  const h = await track(
    makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-1')],
      gatePresence: 'absent',
    }),
  )

  await h.dispatcher.tick()
  const realOpen = h.forge.openPr.bind(h.forge)
  h.forge.openPr = async (opts) => {
    const pr = await realOpen(opts)
    h.forge.setPrState(pr.number, { state: 'open', mergeable: true })
    return pr
  }
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })

  const parked = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(parked.prState).toBe('open')
  let events = await h.events(SLUG)
  expect(typesOf(events)).toContain('finalize.completed')
  expect(typesOf(events)).not.toContain('pr.auto-merge-enabled')
  expect(typesOf(events)).not.toContain('escalation.raised')
  expect(h.forge.squashMergeCalls).toEqual([]) // finalize never lands the PR

  // First janitor poll owns the fallback. It writes no speculative merge fact;
  // the guarded command itself moves only the fake forge's external state.
  expect(await h.dispatcher.tick()).toEqual({
    ...emptyTickReport(),
    claimRaces: 1,
  })
  expect(h.forge.squashMergeCalls).toHaveLength(1)
  expect(h.forge.squashMergeCalls[0]).toMatchObject({
    number: 1,
    expectedHeadSha: 'sha-1',
  })
  events = await h.events(SLUG)
  expect(typesOf(events)).not.toContain('pr.merged')
  expect(typesOf(events)).not.toContain('pr.auto-merge-enabled')

  // The next ordinary observation settles the existing lifecycle vocabulary.
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
  const final = await h.events(SLUG)
  expect(typesOf(final).slice(-3)).toEqual([
    'pr.merged',
    'workspace.released',
    'build.completed',
  ])
  expect(reduceBuild(final).status).toBe('done')
  expect(reduceBuild(final).outcome).toBe('merged')
  expect(typesOf(final)).not.toContain('escalation.raised')
}, 30_000)

// ── a2. Reconcile refreshes a moved base at execution time (§15.7) ──────────

test('a2. reconcile merges the current base when main advances after conflict detection', async () => {
  let suppliedBase: string | undefined
  let mergeCommit: string | undefined
  const handlers = happyHandlers()
  handlers['reconcile'] = async (cli) => {
    await cli.run(['context'])
    const context = JSON.parse(
      await readFile(join(cli.ws, '.ab', 'context.json'), 'utf8'),
    ) as { conflict?: { baseSha: string } }
    suppliedBase = context.conflict?.baseSha
    if (suppliedBase === undefined) {
      throw new Error('reconcile context omitted conflict.baseSha')
    }

    // The advanced base and feature both added rate-limit.txt, so real Git
    // must stop for a resolution. The scripted agent preserves both sides and
    // finishes through the real `ab done` reconcile terminal.
    const merge = await spawnExec(
      ['git', ...GIT_ID, 'merge', '--no-edit', suppliedBase],
      { cwd: cli.ws },
    )
    expect(merge.exitCode).not.toBe(0)
    expect(`${merge.stdout}\n${merge.stderr}`).toContain('CONFLICT')
    await writeFileIn(
      cli.ws,
      'rate-limit.txt',
      'base audit behavior preserved\nfeature throttle after 5 preserved\n',
    )
    mergeCommit = await commitAll(cli.ws, 'reconcile: merge current main')
    const notes = await writeFileIn(
      cli.ws,
      '.ab/reconcile-notes.md',
      'Resolved the add/add rate-limit.txt conflict by preserving both behaviors.\n',
    )
    await cli.run(['done', '--notes', notes])
  }

  const h = await track(
    makeHarness({ handlers, tickets: [readyTicket('T-1')] }),
  )
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  expect((await h.runLatest()).prState).toBe('open')

  const initialEvents = await h.events(SLUG)
  const ws = ofType(initialEvents, 'workspace.provisioned')[0]!.payload.ref
  const detectedBase = await git(['rev-parse', 'main'], h.origin)
  const featureBeforeReconcile = await git(['rev-parse', 'HEAD'], ws)
  // This is the original failure shape: the SHA captured at detection is
  // already in the feature branch, so merging that snapshot would be a no-op.
  expect(
    await git(['merge-base', '--is-ancestor', detectedBase, featureBeforeReconcile], ws),
  ).toBe('')

  // Let the parked runner lease expire, then have the janitor observe a
  // conflict while main is still at the old (already-merged) SHA.
  h.clock.advance(3_600_001)
  h.forge.setPrState(1, { state: 'open', mergeable: false })
  expect(await h.dispatcher.tick()).toEqual({
    ...emptyTickReport(),
    conflicted: 1,
    // FakeTicketSource keeps its claimed ticket in Ready until completion;
    // the second claim is correctly refused while janitor work continues.
    claimRaces: 1,
  })
  const detected = ofType(await h.events(SLUG), 'pr.conflicted')[0]!
  expect(detected.payload.baseSha).toBe(detectedBase)
  expect(h.launched).toHaveLength(2)

  // Main advances only after conflict detection and before the launched
  // reconcile runner executes. Push it to the real bare origin: phase startup
  // must fetch this remote-only tip rather than forwarding the old fact.
  await writeFileIn(h.origin, 'rate-limit.txt', 'base audit behavior\n')
  const currentBase = await commitAll(h.origin, 'base: add audit behavior')
  await git(['push', '-q', 'origin', 'main'], h.origin)
  expect(currentBase).not.toBe(detectedBase)

  const reconciled = await h.runLatest()
  expect(reconciled.status).toBe('running')
  expect(reconciled.prState).toBe('open')
  expect(suppliedBase).toBe(currentBase)

  const events = await h.events(SLUG)
  expect(ofType(events, 'pr.conflicted')[0]!.payload.baseSha).toBe(detectedBase)
  expect(ofType(events, 'reconcile.started')[0]!.payload).toEqual({
    attempt: 1,
    baseSha: currentBase,
  })
  expect(ofType(events, 'escalation.raised')).toEqual([])
  expect(ofType(events, 'verify.completed').map((event) => event.payload)).toEqual([
    { step: 'unit', attempt: 1, outcome: 'pass' },
    { step: 'unit', attempt: 2, outcome: 'pass' },
  ])

  if (mergeCommit === undefined) {
    throw new Error('reconcile handler did not create a merge commit')
  }
  const parents = (
    await git(['rev-list', '--parents', '-n', '1', 'HEAD'], ws)
  ).split(/\s+/)
  expect(parents).toEqual([mergeCommit, featureBeforeReconcile, currentBase])
  expect(ofType(events, 'reconcile.completed')[0]!.payload.mergeCommit).toBe(mergeCommit)
  expect(h.forge.pushes.at(-1)).toEqual({ workspacePath: ws, branch: BRANCH })
  expect(h.cliErrors).toEqual([])

  // With the stale-base obstacle gone, the ordinary janitor can observe the
  // PR merged and finish the build without any human intervention.
  h.forge.setPrState(1, { state: 'merged', sha: 'reconciled-squash' })
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
  const final = await h.events(SLUG)
  expect(reduceBuild(final).outcome).toBe('merged')
  expect(ofType(final, 'escalation.raised')).toEqual([])
}, 30_000)

// ── a3. Conditional verify uses each cycle's live tree diff ──────────────────

test('a3. conditional verify skips initially, then re-evaluates after reconcile against the refreshed base', async () => {
  const conditionalConfig = `
[project]
baseBranch = "main"
[commands]
conditional = "true"
[verify]
steps = ["dashboard", "base-only"]
[verify.dashboard]
kind = "agent"
skill = "ab-verify-dashboard"
paths = ["src/cli/dashboard/**"]
[verify.base-only]
kind = "check"
command = "conditional"
paths = ["base-only/**"]
[tickets]
source = "file"
readyLabels = ["autobuild"]
readyState = "Ready"
`

  const handlers = happyHandlers()
  let dashboardSessions = 0
  handlers['ab-verify-dashboard'] = async (cli) => {
    dashboardSessions += 1
    await cli.run(['context'])
    await cli.run(['verdict', 'pass'])
  }
  handlers['reconcile'] = async (cli) => {
    await cli.run(['context'])
    const context = JSON.parse(
      await readFile(join(cli.ws, '.ab', 'context.json'), 'utf8'),
    ) as { conflict?: { baseSha: string } }
    const baseSha = context.conflict?.baseSha
    if (baseSha === undefined) throw new Error('reconcile context omitted baseSha')

    const merge = await spawnExec(
      ['git', ...GIT_ID, 'merge', '--no-ff', '--no-commit', baseSha],
      { cwd: cli.ws },
    )
    expect(merge.exitCode).toBe(0)
    // This build-owned reconciliation change brings dashboard verification
    // into scope. The upstream-only base-only/ file must remain excluded.
    await writeFileIn(
      cli.ws,
      'src/cli/dashboard/reconciled.ts',
      'export const reconciled = true\n',
    )
    await commitAll(cli.ws, 'reconcile: add dashboard resolution')
    const notes = await writeFileIn(
      cli.ws,
      '.ab/reconcile-notes.md',
      'Merged the refreshed base and added the dashboard-side resolution.\n',
    )
    await cli.run(['done', '--notes', notes])
  }

  const h = await track(
    makeHarness({
      handlers,
      tickets: [readyTicket('T-1')],
      configToml: conditionalConfig,
    }),
  )
  await h.dispatcher.tick()
  expect((await h.runLatest()).prState).toBe('open')

  let results = ofType(await h.events(SLUG), 'verify.completed').map((event) =>
    normalizeVerifyCompletion(event.payload),
  )
  expect(results.map(({ step, attempt, outcome }) => ({ step, attempt, outcome }))).toEqual([
    { step: 'dashboard', attempt: 1, outcome: 'skipped' },
    { step: 'base-only', attempt: 1, outcome: 'skipped' },
  ])
  // The kernel-authored skip starts no dashboard agent and consumes no
  // failure attempt; the first actual session appears only after a path match.
  expect(dashboardSessions).toBe(0)
  expect(
    [...h.agents.sessions.values()].some(
      (session) => session.opts.skill === 'ab-verify-dashboard',
    ),
  ).toBe(false)

  // Advance only the remote base with a path covered by base-only's selector.
  // The post-reconcile anchor must subtract it from the build-owned diff.
  await h.advanceRemote(
    { 'base-only/upstream.ts': 'export const upstream = true\n' },
    'base: add upstream-only file',
  )
  h.clock.advance(3_600_001)
  h.forge.setPrState(1, { state: 'open', mergeable: false })
  await h.dispatcher.tick()
  expect(h.launched).toHaveLength(2)
  expect((await h.runLatest()).prState).toBe('open')

  const events = await h.events(SLUG)
  results = ofType(events, 'verify.completed').map((event) =>
    normalizeVerifyCompletion(event.payload),
  )
  expect(results.map(({ step, attempt, outcome }) => ({ step, attempt, outcome }))).toEqual([
    { step: 'dashboard', attempt: 1, outcome: 'skipped' },
    { step: 'base-only', attempt: 1, outcome: 'skipped' },
    { step: 'dashboard', attempt: 2, outcome: 'pass' },
    { step: 'base-only', attempt: 2, outcome: 'skipped' },
  ])
  expect(results[2]?.outcome).toBe('pass')
  expect(dashboardSessions).toBe(1)
  expect(
    [...h.agents.sessions.values()].filter(
      (session) => session.opts.skill === 'ab-verify-dashboard',
    ),
  ).toHaveLength(1)
  expect(results[3]).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('[verify.base-only].paths'),
  })
  expect(ofType(events, 'reconcile.completed')).toHaveLength(1)
  expect(ofType(events, 'finalize.completed')).toHaveLength(1)
  expect(h.cliErrors).toEqual([])
}, 30_000)

// ── b. Verify failure round-trip (§15.6-A) ───────────────────────────────────

test('b. verify failure routes back to implement with the report, then re-verifies (§15.6-A)', async () => {
  const roundsWithReport: number[] = []
  const handlers = happyHandlers()
  // r1 does NOT create ok.marker (the check fails); r2 keys off the
  // materialized .ab/verify/ report and fixes it.
  handlers['implement'] = async (cli) => {
    await cli.run(['context'])
    const routed = existsSync(join(cli.ws, '.ab', 'verify', 'unit.md'))
    if (routed) {
      roundsWithReport.push(cli.round)
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
    }
    await writeFileIn(cli.ws, 'rate-limit.txt', `attempt r${cli.round}\n`)
    await commitAll(cli.ws, `implement r${cli.round}`)
    const notes = await writeFileIn(
      cli.ws,
      '.ab/implement-notes.md',
      routed ? 'fixed per the routed verify report\n' : 'first cut (marker missing)\n',
    )
    await cli.run(['done', '--notes', notes])
  }
  const h = await track(makeHarness({ handlers, tickets: [readyTicket('T-1')] }))

  await h.dispatcher.tick()
  const state = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(state.status).toBe('running')
  expect(state.prState).toBe('open')

  const events = await h.events(SLUG)
  expect(typesOf(events)).toEqual([
    'build.created',
    'workspace.provisioned',
    'spec.imported',
    'runner.attached',
    'plan.started',
    'session.started',
    'plan.completed',
    'session.ended',
    'plan-review.started',
    'session.started',
    'plan-review.verdict',
    'session.ended',
    'implement.started', // r1
    'session.started',
    'implement.completed',
    'session.ended',
    'code-review.started', // r1
    'session.started',
    'code-review.verdict',
    'session.ended',
    'verify.started', // attempt 1: fail + report (D6 atomic bundle)
    'verify.completed',
    'implement.started', // r2, carrying the verify feedback
    'session.started',
    'implement.completed',
    'session.ended',
    'code-review.started', // one more review round
    'session.started',
    'code-review.verdict',
    'session.ended',
    'verify.started', // attempt 2, from the first step
    'verify.completed',
    'finalize.started',
    'session.started',
    'finalize.completed',
    'session.ended',
  ])

  // The failed check: verify.completed{outcome:fail} with the report artifact.
  const [fail, pass] = ofType(events, 'verify.completed')
  expect(fail!.payload).toEqual({
    step: 'unit',
    attempt: 1,
    outcome: 'fail',
    report: { kind: 'verify-report:unit', rev: 0 },
  })
  expect(fail!.actor).toEqual({ kind: 'kernel' })
  const report = (await h.store.getArtifact(SLUG, 'verify-report:unit', 0))!
  expect(textContent(report)).toBe('(no output)') // `test -f` is silent
  expect(report.meta.metadata).toEqual({
    step: 'unit',
    attempt: 1,
    command: 'test -f ok.marker',
    exitCode: 1,
  })

  // implement.started r2 carries the verify feedback (§15.6-A) and the
  // script saw the materialized .ab/verify/ report exactly once, in r2.
  const starts = ofType(events, 'implement.started')
  expect(starts.map((e) => e.payload.round)).toEqual([1, 2])
  expect(starts[0]!.payload.feedback).toBeUndefined()
  expect(starts[1]!.payload.feedback).toEqual({
    verify: { step: 'unit', report: { kind: 'verify-report:unit', rev: 0 } },
  })
  expect(roundsWithReport).toEqual([2])

  // Verify re-ran from the first step at attempt 2 and passed.
  expect(ofType(events, 'verify.started').map((e) => e.payload)).toEqual([
    { step: 'unit', attempt: 1 },
    { step: 'unit', attempt: 2 },
  ])
  expect(pass!.payload).toEqual({ step: 'unit', attempt: 2, outcome: 'pass' })

  // One more code-review round; the reviewer is a FRESH session each round.
  const verdicts = ofType(events, 'code-review.verdict')
  expect(verdicts.map((e) => e.payload.round)).toEqual([1, 2])
  expect(verdicts.map((e) => e.payload.verdict)).toEqual(['approve', 'approve'])
  expect(agentSession(verdicts[0]!)).not.toBe(agentSession(verdicts[1]!))

  // Producer session memory (§10): the runner CONTINUES round 1's runner
  // session but re-issues ambient auth per turn (D8) — each round's terminal
  // is stamped with its OWN bracket's AB_SESSION (§15.3), which is exactly
  // what lets the real CLI accept the continued round's `ab done` (§8.4 D5).
  const implSessions = ofType(events, 'session.started')
    .filter((e) => e.payload.phase === 'implement')
    .map((e) => e.payload.session)
  expect(implSessions).toEqual(['s_3', 's_5'])
  expect(ofType(events, 'implement.completed').map(agentSession)).toEqual(implSessions)
  const implJournals = [...h.agents.sessions.values()].filter(
    (j) => j.opts.skill === 'ab-implement',
  )
  expect(implJournals).toHaveLength(1) // ONE continued runner session…
  expect(implJournals[0]!.turns).toHaveLength(2) // …with a turn per round
  expect(implJournals[0]!.messages[0]).toContain('verify:unit failed')
  // …and round 2's bracket still deposited its own transcript (§7.1).
  const transcripts = await h.store.listArtifacts(SLUG, 'transcript')
  expect(transcripts).toHaveLength(7)
  expect(transcripts[4]!.metadata['phase']).toBe('implement')
  expect(transcripts[4]!.metadata['round']).toBe(2)
  expect(transcripts[4]!.metadata['session']).toBe('s_5')

  // Both implement rounds pushed the branch (D7 plumbing on each `ab done`).
  const ws = ofType(events, 'workspace.provisioned')[0]!.payload.ref
  expect(h.forge.pushes).toEqual([
    { workspacePath: ws, branch: BRANCH },
    { workspacePath: ws, branch: BRANCH },
  ])
}, 30_000)

// ── c. Review stall → escalation → guidance (§15.6-B, §15.4) ─────────────────

const GUIDANCE_ANSWER = 'A fixed 5-minute window is correct; approve unless it regresses.'

test('c. persists chain stalls, human guidance unblocks, loop converges (§15.6-B)', async () => {
  const guidanceSeen: Array<{ round: number; escalation: string; answer: string }> = []
  const handlers = happyHandlers()
  handlers['implement'] = async (cli) => {
    await cli.run(['context'])
    const guidancePath = join(cli.ws, '.ab', 'guidance.json')
    if (existsSync(guidancePath)) {
      const guidance = JSON.parse(await Bun.file(guidancePath).text()) as {
        escalation: string
        answer: string
      }
      guidanceSeen.push({ round: cli.round, ...guidance })
      await writeFileIn(cli.ws, 'guidance.txt', `${guidance.answer}\n`)
    }
    await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
    await writeFileIn(cli.ws, 'limiter.txt', `window r${cli.round}\n`)
    await commitAll(cli.ws, `implement r${cli.round}`)
    const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', `r${cli.round}\n`)
    await cli.run(['done', '--notes', notes])
  }
  // The reviewer re-raises the same disagreement each round, learning prior
  // finding ids from the materialized .ab/history/ (§15.4: the CLI stamps
  // ids; `persists` may only cite prior rounds). Guidance in the diff
  // (guidance.txt) is what finally satisfies it.
  handlers['code-review'] = async (cli) => {
    await cli.run(['context'])
    const notes = await writeFileIn(cli.ws, '.ab/code-review.md', `review r${cli.round}\n`)
    if (existsSync(join(cli.ws, 'guidance.txt'))) {
      await cli.run(['verdict', 'approve', '--notes', notes])
      return
    }
    const persists: string[] = []
    if (cli.round > 1) {
      const prior = JSON.parse(
        await Bun.file(
          join(cli.ws, '.ab', 'history', `findings-r${cli.round - 1}.json`),
        ).text(),
      ) as Array<{ id: string }>
      persists.push(prior[0]!.id)
    }
    const draft = [
      {
        severity: 'blocking',
        summary: 'window semantics disagree with the spec reading',
        persists,
      },
    ]
    const findings = await writeFileIn(cli.ws, '.ab/findings-draft.json', JSON.stringify(draft))
    await cli.run(['verdict', 'revise', '--findings', findings, '--notes', notes])
  }
  const h = await track(makeHarness({ handlers, tickets: [readyTicket('T-1')] }))

  await h.dispatcher.tick()
  const blocked = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(blocked.status).toBe('blocked') // runner exited parked (§11)

  let events = await h.events(SLUG)
  const codeRound = ['session.started', 'implement.completed', 'session.ended',
    'code-review.started', 'session.started', 'code-review.verdict', 'session.ended']
  expect(typesOf(events)).toEqual([
    'build.created',
    'workspace.provisioned',
    'spec.imported',
    'runner.attached',
    'plan.started',
    'session.started',
    'plan.completed',
    'session.ended',
    'plan-review.started',
    'session.started',
    'plan-review.verdict',
    'session.ended',
    'implement.started', ...codeRound, // r1
    'implement.started', ...codeRound, // r2
    'implement.started', ...codeRound, // r3
    'escalation.raised', // stall threshold hit (§15.4)
  ])

  // The chain: CLI-stamped ids, each round persisting the last (§15.4).
  const verdicts = ofType(events, 'code-review.verdict')
  expect(verdicts.map((e) => e.payload.verdict)).toEqual(['revise', 'revise', 'revise'])
  expect(verdicts.map((e) => e.payload.findings[0]!.id)).toEqual(['f_1', 'f_2', 'f_3'])
  expect(verdicts.map((e) => e.payload.findings[0]!.persists)).toEqual([[], ['f_1'], ['f_2']])
  expect(new Set(verdicts.map(agentSession)).size).toBe(3) // fresh skeptic each round
  // Findings feedback rode each next producer round.
  expect(ofType(events, 'implement.started').map((e) => e.payload.feedback)).toEqual([
    undefined,
    { findings: ['f_1'] },
    { findings: ['f_2'] },
  ])
  // The stall raise is the KERNEL applying the threshold (§15.4 split).
  const raised = ofType(events, 'escalation.raised')[0]!
  expect(raised.actor).toEqual({ kind: 'kernel' })
  expect(raised.payload).toEqual({
    id: 'esc_1',
    phase: 'code-review',
    round: 3,
    source: 'stall',
    question: 'finding chain persisted 3 rounds: f_1 -> f_2 -> f_3',
    refs: ['f_1', 'f_2', 'f_3'],
  })

  // A blocked build is NOT swept, even with an expired lease (§15.6-C).
  h.clock.advance(4 * 3_600_000)
  const tickBlocked = await h.dispatcher.tick()
  expect(tickBlocked).toEqual({ ...emptyTickReport(), claimRaces: 1 })
  expect(h.launched).toHaveLength(1)

  // A human answers with guidance (§11: an event, from any UI).
  await h.store.append(SLUG, {
    actor: humanActor('aron@example.test'),
    type: 'escalation.answered',
    payload: { id: 'esc_1', answer: GUIDANCE_ANSWER, resolution: 'guidance' },
  })

  // Now actionable: the sweep re-attaches a runner (cron path, §15.6-C).
  const tickSwept = await h.dispatcher.tick()
  expect(tickSwept).toEqual({ ...emptyTickReport(), swept: 1, claimRaces: 1 })
  expect(h.launched).toHaveLength(2)
  const resumedFrom = (await h.events(SLUG)).length

  const state = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(state.status).toBe('running')
  expect(state.prState).toBe('open')

  events = await h.events(SLUG)
  expect(typesOf(events).slice(resumedFrom)).toEqual([
    'runner.attached',
    'implement.started', // r4, guidance as authoritative feedback
    'session.started',
    'implement.completed',
    'session.ended',
    'code-review.started', // r4 → approve
    'session.started',
    'code-review.verdict',
    'session.ended',
    'verify.started',
    'verify.completed',
    'finalize.started',
    'session.started',
    'finalize.completed',
    'session.ended',
  ])
  const attached2 = ofType(events, 'runner.attached')[1]!
  expect(attached2.payload.instance).toBe('runner-2')
  expect(attached2.payload.resumedFromSeq).toBe(resumedFrom)

  // implement.started r4 carries the guidance feedback (§15.6-B)…
  expect(ofType(events, 'implement.started')[3]!.payload).toEqual({
    round: 4,
    feedback: { guidance: { escalation: 'esc_1', answer: GUIDANCE_ANSWER } },
  })
  // …and the script actually read it from the materialized .ab/guidance.json.
  expect(guidanceSeen).toEqual([{ round: 4, escalation: 'esc_1', answer: GUIDANCE_ANSWER }])

  // Each bracket's re-issued AB_SESSION (D8) stamps its own terminal (§15.3)…
  expect(ofType(events, 'implement.completed').map(agentSession)).toEqual([
    's_3',
    's_5',
    's_7',
    's_9',
  ])
  // …while the RUNNER sessions show the §10/§7.4 memory model: rounds 1–3
  // are turns of ONE continued session; the relaunched sandbox's r4 is a
  // fresh start (a new sandbox has no producer memory).
  const implJournals = [...h.agents.sessions.values()].filter(
    (j) => j.opts.skill === 'ab-implement',
  )
  expect(implJournals.map((j) => j.turns.length)).toEqual([3, 1])
  const finalVerdict = ofType(events, 'code-review.verdict')[3]!
  expect(finalVerdict.payload.round).toBe(4)
  expect(finalVerdict.payload.verdict).toBe('approve')
  expect(ofType(events, 'verify.completed')[0]!.payload).toEqual({
    step: 'unit',
    attempt: 1,
    outcome: 'pass',
  })
  expect(decideNext(events, h.config)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
}, 30_000)

// ── d. Bounce (§6.3): dispatch quality gate ──────────────────────────────────

test('d. nonconforming ticket bounces back to Triage citing the standard (§6.3)', async () => {
  const h = await track(
    makeHarness({
      handlers: {},
      tickets: [readyTicket('T-9', { title: 'Vague idea', body: 'Make login better somehow.\n' })],
    }),
  )
  const tick = await h.dispatcher.tick()
  expect(tick).toEqual({ ...emptyTickReport(), bounced: 1 })

  // No build, no workspace, no runner — failure at the cheapest point.
  expect(await h.store.listBuilds()).toEqual([])
  expect(h.launched).toEqual([])
  expect(h.tickets.transitions).toEqual([{ id: 'T-9', state: 'Triage' }])
  expect(h.tickets.comments).toHaveLength(1)
  const comment = h.tickets.comments[0]!
  expect(comment.id).toBe('T-9')
  expect(comment.body).toContain('docs/spec-standard.md')
  expect(comment.body).toContain("an '## Acceptance criteria' heading")
  expect(comment.body).toContain("an '## Out of scope' heading")
  // Claim-before-launch happened even for the bounce (§12).
  expect(await h.tickets.claim('T-9')).toBe(false)
}, 30_000)

// ── d2. Ticket dependencies through the REAL file source (§13) ───────────────

/**
 * The dependency gate end-to-end with no fake in the dependency path: a real
 * FileTicketSource over real TOML files on a real filesystem. This is what
 * proves the pieces compose — frontmatter round-trip, the source's native
 * "complete" (state `Done`), the dispatcher's gate — rather than each unit
 * agreeing with its own mock.
 *
 * The blocker moves to Done by the file source's ordinary `transition`, and
 * the dependent ticket becomes eligible on the next tick with no manual
 * synchronization step in between.
 */
test('d2. a file-source ticket blocked by another dispatches only once its blocker is Done (§13)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-e2e-file-tickets-'))
  try {
    const source = new FileTicketSource({ dir, createState: 'Ready' })

    // The blocker: groomed and picked up, but not finished. `Doing` is the
    // file source's in-flight state — its states are its directories, so this
    // is a real `mv` into `doing/`, not a frontmatter field.
    const blocker = await source.create({
      title: 'Blocker work',
      body: CONFORMING_BODY,
      labels: ['autobuild'],
    })
    await source.transition(blocker.ref.id, 'Doing')

    // The dependent: filed with --blocked-by, exactly as `ab ticket create`
    // would record it — a native TOML `blockedBy` array.
    const dependent = await source.create({
      title: 'Dependent work',
      body: CONFORMING_BODY,
      labels: ['autobuild'],
      blockedBy: [blocker.ref.id],
    })
    expect(await readFile(join(dir, 'ready', `${dependent.ref.id}.md`), 'utf8')).toContain(
      `blockedBy = [ "${blocker.ref.id}" ]`,
    )

    const h = await track(makeHarness({ handlers: {}, ticketSource: source }))

    // Tick 1: the dependent is held, and nothing builds — the blocker is in
    // Doing, which readyCriteria's `Ready` gate excludes on its own.
    const first = await h.dispatcher.tick()
    expect(first.dependencyBlocked).toBe(1)
    expect(first.dependencyDiagnostics).toEqual([
      `ticket ${dependent.ref.id} blocked by ${blocker.ref.id} (not complete)`,
    ])
    expect(await h.store.listBuilds()).toEqual([])
    // Held means untouched — and since this source's claim IS a rename into
    // doing/, "not claimed" is checkable by where the file still sits.
    expect((await source.get(dependent.ref.id))?.state).toBe('Ready')
    expect(await readdir(join(dir, 'doing'))).toEqual([`${blocker.ref.id}.md`])

    // The blocker completes by the source's OWN lifecycle — nothing else.
    await source.transition(blocker.ref.id, 'Done')

    // Tick 2: eligible now, with no intervening manual synchronization.
    const second = await h.dispatcher.tick()
    expect(second.dependencyBlocked).toBe(0)
    expect(second.dispatched).toBe(1)
    expect((await h.store.listBuilds()).map((b) => b.ticket?.id)).toContain(
      dependent.ref.id,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

/** Relationships added after creation flow through the same native file
 * projection and dispatcher gate, and removing one makes the next tick
 * eligible even while the former blocker remains unresolved. */
test('d3. post-create blocker writes immediately govern file-source dispatch (§13)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-e2e-file-ticket-edits-'))
  try {
    const source = new FileTicketSource({ dir, createState: 'Ready' })
    const blocker = await source.create({
      title: 'Still unresolved',
      body: CONFORMING_BODY,
      labels: ['autobuild'],
    })
    await source.transition(blocker.ref.id, 'Doing')
    const dependent = await source.create({
      title: 'Initially independent',
      body: CONFORMING_BODY,
      labels: ['autobuild'],
    })

    await source.addBlocker(dependent.ref.id, blocker.ref.id)
    expect(
      await readFile(join(dir, 'ready', `${dependent.ref.id}.md`), 'utf8'),
    ).toContain(`blockedBy = [ "${blocker.ref.id}" ]`)

    const h = await track(makeHarness({ handlers: {}, ticketSource: source }))
    const held = await h.dispatcher.tick()
    expect(held.dependencyBlocked).toBe(1)
    expect(held.dispatched).toBe(0)
    expect((await source.get(dependent.ref.id))?.state).toBe('Ready')

    await source.removeBlocker(dependent.ref.id, blocker.ref.id)
    const unblockedFile = await readFile(
      join(dir, 'ready', `${dependent.ref.id}.md`),
      'utf8',
    )
    expect(unblockedFile).not.toContain('blockedBy')
    expect((await source.get(blocker.ref.id))?.state).toBe('Doing')

    const released = await h.dispatcher.tick()
    expect(released.dependencyBlocked).toBe(0)
    expect(released.dispatched).toBe(1)
    expect((await h.store.listBuilds()).map((build) => build.ticket?.id)).toContain(
      dependent.ref.id,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

// ── e. The real binary over the real local store (§7.2.1, §8.1) ──────────────

test('e. runner PATH uses the real `ab` for context through a validated terminal', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-e2e-bin-'))
  try {
    const root = join(tmp, 'store')
    const ws = join(tmp, 'ws')
    const conflictBin = join(tmp, 'host-bin')
    await mkdir(ws, { recursive: true })
    await mkdir(conflictBin, { recursive: true })
    // `ab done` validates the exact plan against the provisioned workspace's
    // normal config and records the effective default selection.
    await writeFile(join(ws, 'autobuild.toml'), CONFIG_TOML)
    await writeFile(
      join(conflictBin, 'ab'),
      '#!/bin/sh\necho host-conflicting-ab\nexit 91\n',
    )
    await chmod(join(conflictBin, 'ab'), 0o755)
    const slug = 'local-e2e'
    const ticket = { source: 'fake', id: 'T-local', title: 'Local e2e' }

    // Seed a real plan session through the store API.
    const seed = openLocalStore(root, { clock: steppingClock() })
    await seed.createBuild({ slug, repo: '/repo/e2e', ticket })
    await seed.putArtifact(slug, { kind: 'spec', content: '# Spec: local e2e\n' })
    await seed.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: '/repo/e2e', baseBranch: 'main' },
    })
    await seed.append(slug, {
      actor: DISPATCHER,
      type: 'spec.imported',
      payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
    })
    await seed.append(slug, {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })
    await seed.append(slug, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_e2e',
        role: 'plan',
        runner: 'pi',
        phase: 'plan',
        round: 1,
      },
    })
    await seed.close()

    // The inherited host path resolves a hostile `ab` first. The runner's
    // shared environment builder must override that ordering, after all
    // scoped values are merged, without requiring a global Autobuild install.
    const inheritedPath = [conflictBin, process.env['PATH'] ?? '']
      .filter((entry) => entry !== '')
      .join(delimiter)
    const env = sessionEnv(
      {
        AB_STORE: root,
        AB_BUILD: slug,
        AB_PHASE: 'plan@1',
        AB_SESSION: 's_e2e',
        AB_TOKEN: '',
      },
      { ...process.env, PATH: inheritedPath },
    )
    expect(env['PATH']!.split(delimiter).slice(0, 2)).toEqual([
      AGENT_BIN_DIR,
      conflictBin,
    ])

    // Invoke by the documented spelling — no process.execPath or repository
    // path escape hatch. This also executes the checked-in launcher's mode.
    const ab = async (
      argv: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      const proc = Bun.spawn(['ab', ...argv], {
        cwd: ws,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    }

    const context = await ab(['context'])
    expect(context).toMatchObject({ code: 0, stderr: '' })
    expect(context.stdout).toContain(`context materialized for ${slug} — plan@1`)
    expect(await readFile(join(ws, '.ab', 'spec.md'), 'utf8')).toBe(
      '# Spec: local e2e\n',
    )

    const got = await ab(['artifact', 'get', 'spec'])
    expect(got).toEqual({
      code: 0,
      stderr: '',
      stdout: '# Spec: local e2e\n\n',
    })

    await writeFile(join(ws, 'plan.md'), '# Plan via the managed ab\n')
    const put = await ab(['artifact', 'put', 'plan', join(ws, 'plan.md')])
    expect(put).toEqual({ code: 0, stderr: '', stdout: '0\n' })

    const obs = await ab(['observe', '--kind', 'followup', 'tighten the retry-after copy'])
    expect(obs).toMatchObject({ code: 0, stderr: '' })
    expect(obs.stdout).toMatch(/^observation recorded: obs_[0-9a-f]{8}\n$/)

    const done = await ab(['done'])
    expect(done).toEqual({
      code: 0,
      stderr: '',
      stdout: 'plan.completed recorded (seq 6)\n',
    })

    // Round-trip through SQLite proves this was the typed Autobuild terminal,
    // attributed to the active session, rather than a same-named shim.
    const store = openLocalStore(root)
    try {
      const plan = (await store.getArtifact(slug, 'plan'))!
      expect(textContent(plan)).toBe('# Plan via the managed ab\n')
      expect(plan.meta.revision).toBe(0)
      const events = await store.getEvents(slug)
      expect(events.map((event) => event.type)).toEqual([
        'build.created',
        'spec.imported',
        'plan.started',
        'session.started',
        'observation.recorded',
        'plan.completed',
      ])
      const observed = events[4]!
      expect(observed.actor).toEqual({ kind: 'agent', role: 'plan', session: 's_e2e' })
      expect(observed.type).toBe('observation.recorded')
      if (observed.type === 'observation.recorded') {
        expect(observed.payload.kind).toBe('followup')
        expect(observed.payload.summary).toBe('tighten the retry-after copy')
        expect(observed.payload.id).toMatch(/^obs_[0-9a-f]{8}$/)
      }
      const completed = events[5]!
      expect(completed.actor).toEqual({ kind: 'agent', role: 'plan', session: 's_e2e' })
      expect(completed.type).toBe('plan.completed')
      if (completed.type === 'plan.completed') {
        expect(completed.payload).toEqual({
          round: 1,
          artifact: { kind: 'plan', rev: 0 },
          verifySteps: ['unit'],
        })
      }
    } finally {
      await store.close()
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}, 30_000)

// ── g. Two-axis runtime/model routing (§9, AC "an integration scenario") ─────
//
// The config sets the repo-wide default runtime (`[roles.default]`) and routes
// ONE agent phase (code-review) to a second runtime with a model
// (`{ runtime = "pi", model = "kimi-k3" }`). The build runs to PR, and its
// stored `session.started` events + transcripts show code-review on pi×kimi-k3
// while every other phase stays on the default runtime. Both runtimes are
// backed by the same scripted runner in the harness, so the session numbering
// the other scenarios rely on is unchanged.

const TWO_AXIS_TOML = `${CONFIG_TOML}
[roles.default]
runtime = "scripted"

[roles.code-review]
runtime = "pi"
model = "kimi-k3"
`

test('g. two-axis routing: one phase on pi×kimi-k3, the rest on the default runtime (§9)', async () => {
  const h = await track(
    makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-1')],
      configToml: TWO_AXIS_TOML,
    }),
  )

  const tick1 = await h.dispatcher.tick()
  expect(tick1).toEqual({ ...emptyTickReport(), dispatched: 1 })
  const state = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')

  const events = await h.events(SLUG)
  const started = ofType(events, 'session.started')

  // The routed phase: code-review resolves to runtime "pi" with model "kimi-k3".
  const codeReview = started.find((e) => e.payload.role === 'code-review')!
  expect(codeReview.payload.runner).toBe('pi')
  expect(codeReview.payload.model).toBe('kimi-k3')

  // Every other phase stays on the default runtime with no model.
  for (const role of ['plan', 'plan-review', 'implement', 'finalize']) {
    const s = started.find((e) => e.payload.role === role)!
    expect(s.payload.runner).toBe('scripted')
    expect(s.payload.model).toBeUndefined()
  }

  // The stored transcripts record the resolved runtime + model, so any
  // experiment's outcome is attributable to the config that produced it.
  const transcripts = await h.store.listArtifacts(SLUG, 'transcript')
  const crTranscript = transcripts.find((m) => m.metadata['phase'] === 'code-review')!
  expect(crTranscript.metadata['runner']).toBe('pi')
  expect(crTranscript.metadata['model']).toBe('kimi-k3')
  const planTranscript = transcripts.find((m) => m.metadata['phase'] === 'plan')!
  expect(planTranscript.metadata['runner']).toBe('scripted')
  expect(planTranscript.metadata['model']).toBeUndefined()
}, 30_000)

// ── h. Observation harvest through dispatcher + real CLI (§12) ──────────────

test('h. harvest e2e: threshold → revise → file once → wait for K new observations', async () => {
  const h = await track(
    makeHarness({
      handlers: {},
      tickets: [],
      configToml: `${CONFIG_TOML}\n[harvest]\nthreshold = 2\n`,
    }),
  )
  const cliErrors: string[] = []
  let reviewTurns = 0

  const harvestAgents = new ScriptedAgentRunner({
    script: async (ctx) => {
      const harvestEnv = resolveHarvestCliEnv(ctx.opts.env)
      const run = async (argv: string[]): Promise<string[]> => {
        const out: string[] = []
        const err: string[] = []
        const code = await runCli(argv, {
          store: h.store,
          harvestEnv,
          workspacePath: h.origin,
          ids: h.ids,
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        })
        if (code !== 0) {
          const message = `ab ${argv.join(' ')} exited ${code}: ${err.join('\n')}`
          cliErrors.push(message)
          throw new Error(message)
        }
        return out
      }

      await run(['harvest', 'context'])
      if (ctx.opts.skill === 'ab-harvest') {
        const observations = JSON.parse(
          await readFile(join(h.origin, '.ab', 'observations.json'), 'utf8'),
        ) as Array<{ occurrence: { build: string; seq: number } }>
        if (ctx.turn === 2) {
          const findings = JSON.parse(
            await readFile(join(h.origin, '.ab', 'findings.json'), 'utf8'),
          ) as unknown[]
          expect(findings).toHaveLength(1)
        }
        const file = join(h.origin, '.ab', `e2e-proposals-${harvestEnv.run}-${ctx.turn}.json`)
        await writeFile(
          file,
          JSON.stringify({
            proposals: [
              {
                action: 'create',
                title: `Harvest ${observations[0]!.occurrence.build}`,
                whatWhy: 'The clustered observations expose one actionable defect.',
                acceptanceCriteria: ['The clustered defect no longer occurs.'],
                outOfScope: ['Unrelated cleanup.'],
                observations: observations.map((item) => item.occurrence),
              },
            ],
          }),
        )
        await run(['harvest', 'submit', file])
      } else {
        reviewTurns += 1
        const notes = join(h.origin, '.ab', `e2e-review-${reviewTurns}.md`)
        await writeFile(notes, reviewTurns === 1 ? 'revise once\n' : 'approved\n')
        if (reviewTurns === 1) {
          const findings = join(h.origin, '.ab', 'e2e-findings.json')
          await writeFile(
            findings,
            JSON.stringify([
              { severity: 'important', summary: 'Make the proposal more specific' },
            ]),
          )
          await run([
            'harvest',
            'verdict',
            'revise',
            '--notes',
            notes,
            '--findings',
            findings,
          ])
        } else {
          await run(['harvest', 'verdict', 'approve', '--notes', notes])
        }
      }
      return defaultTurnResult('harvest CLI terminal deposited')
    },
  })

  let instances = 0
  let harvestActive: Promise<void> | undefined
  const harvestRuns = new Set<Promise<void>>()
  const harvestOutcomes: HarvestRunnerResult[] = []
  const startHarvest = (): void => {
    if (harvestActive !== undefined) return
    instances += 1
    let tracked: Promise<void>
    tracked = new HarvestRunner({
      store: h.store,
      tickets: h.tickets,
      config: h.config,
      runtimes: { scripted: { runner: harvestAgents, servesModels: [] } },
      defaultRuntime: 'scripted',
      repo: h.origin,
      workspacePath: h.origin,
      ids: h.ids,
      uuids: randomUuids(),
      clock: h.clock,
      instance: `harvest-e2e-${instances}`,
      sessionEnv: { AB_STORE: 'memory' },
      opts: { heartbeatMs: 3_600_000, leaseTtlMs: 3_600_000 },
    })
      .run()
      .then((result) => {
        harvestOutcomes.push(result)
      })
      .finally(() => {
        harvestRuns.delete(tracked)
        if (harvestActive === tracked) harvestActive = undefined
      })
    harvestActive = tracked
    harvestRuns.add(tracked)
  }
  const drainHarvest = async (): Promise<HarvestRunnerResult> => {
    while (harvestRuns.size > 0) await Promise.all([...harvestRuns])
    const result = harvestOutcomes.shift()
    if (result === undefined) throw new Error('harvest launch produced no outcome')
    return result
  }
  const dispatcher = new Dispatcher({
    store: h.store,
    tickets: h.tickets,
    workspaces: h.workspaces,
    forge: h.forge,
    config: h.config,
    repo: h.origin,
    exec: spawnExec,
    launchRunner: async (slug): Promise<LaunchRunnerResult> => {
      throw new Error(`unexpected build launch for ${slug}`)
    },
    startHarvest,
    ids: h.ids,
    clock: h.clock,
  })

  const seed = async (slug: string, summary: string): Promise<void> => {
    const ticket = { source: 'fake', id: `source-${slug}`, title: slug }
    await h.store.createBuild({ slug, repo: h.origin, ticket })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: h.origin, baseBranch: 'main' },
    })
    await h.store.append(slug, {
      actor: agentActor('implement', `source-session-${slug}`),
      type: 'observation.recorded',
      payload: { id: `obs-${slug}`, kind: 'latent-bug', summary },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }

  await seed('harvest-a', 'same defect in path A')
  expect(await dispatcher.tick()).toEqual(emptyTickReport())
  expect(await drainHarvest()).toEqual({ outcome: 'idle' })

  await seed('harvest-b', 'same defect in path B')
  expect(await dispatcher.tick()).toEqual(emptyTickReport())
  expect(await drainHarvest()).toMatchObject({
    outcome: 'completed',
    launch: 'started',
  })
  expect(cliErrors).toEqual([])
  expect(reviewTurns).toBe(2)
  expect((await h.tickets.get('fake-1'))?.state).toBe('Triage')
  const firstRepoEvents = await h.store.getRepoEvents(h.origin)
  expect(reduceHarvest(firstRepoEvents)).toMatchObject({
    latest: {
      status: 'completed',
      reservations: [expect.objectContaining({ proposalKey: expect.any(String) })],
    },
    ledger: [{ action: 'filed' }, { action: 'filed' }],
  })
  const reserved = firstRepoEvents.find(
    (event) => event.type === 'harvest.proposal.id-reserved',
  )
  const filed = firstRepoEvents.find(
    (event) =>
      event.type === 'harvest.proposal.filed' &&
      event.payload.proposalKey === reserved?.payload.proposalKey,
  )
  expect(reserved).toBeDefined()
  expect(filed?.seq).toBeGreaterThan(reserved!.seq)

  const repoEventsAfterFirst = firstRepoEvents.length
  expect(await dispatcher.tick()).toEqual(emptyTickReport())
  expect(await drainHarvest()).toEqual({ outcome: 'idle' })
  expect(await h.store.getRepoEvents(h.origin)).toHaveLength(repoEventsAfterFirst)
  expect(await h.tickets.get('fake-2')).toBeNull()

  await seed('harvest-c', 'new defect occurrence C')
  expect(await dispatcher.tick()).toEqual(emptyTickReport())
  expect(await drainHarvest()).toEqual({ outcome: 'idle' })
  expect(await h.tickets.get('fake-2')).toBeNull()

  await seed('harvest-d', 'new defect occurrence D')
  expect(await dispatcher.tick()).toEqual(emptyTickReport())
  expect(await drainHarvest()).toMatchObject({
    outcome: 'completed',
    launch: 'started',
  })
  expect((await h.tickets.get('fake-2'))?.state).toBe('Triage')
  expect(cliErrors).toEqual([])

  const sessions = [...harvestAgents.sessions.values()]
  expect(sessions.filter((entry) => entry.opts.skill === 'ab-harvest')).toHaveLength(2)
  expect(
    sessions.filter((entry) => entry.opts.skill === 'ab-harvest-review'),
  ).toHaveLength(3)
}, 30_000)

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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { humanActor } from '../events/envelope'
import { decideNext } from '../kernel/engine'
import { reduceBuild } from '../kernel/reducer'
import { FileTicketSource } from '../ports/tickets/file'
import { emptyTickReport } from '../processes/dispatcher'
import { openLocalStore } from '../store/local/store'
import { textContent } from '../store/types'
import { steppingClock } from '../testing/fixed'
import {
  agentSession,
  commitAll,
  CONFIG_TOML,
  CONFORMING_BODY,
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
  expect(planCompleted.payload).toEqual({ round: 1, artifact: { kind: 'plan', rev: 0 } })
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
  expect(verified.payload).toEqual({ step: 'unit', attempt: 1, pass: true })
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
  // The config's required `readyState = "Ready"` (readyCriteria,
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

test('auto-merge requested before finalize is applied as native squash and completes on the next poll', async () => {
  const h = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )

  await h.dispatcher.tick()
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

  // The failed check: verify.completed{pass:false} with the report artifact.
  const [fail, pass] = ofType(events, 'verify.completed')
  expect(fail!.payload).toEqual({
    step: 'unit',
    attempt: 1,
    pass: false,
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
  expect(pass!.payload).toEqual({ step: 'unit', attempt: 2, pass: true })

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
    pass: true,
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

// ── e. The real binary over the real local store (§7.2.1, §8.1) ──────────────

test('e. `bun bin/ab.ts` round-trips artifacts and observations through the sqlite store', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-e2e-bin-'))
  try {
    const root = join(tmp, 'store')
    const ws = join(tmp, 'ws')
    await mkdir(ws, { recursive: true })
    const slug = 'local-e2e'

    // Seed through the API…
    const seed = openLocalStore(root, { clock: steppingClock() })
    await seed.createBuild({ slug, repo: '/repo/e2e' })
    await seed.putArtifact(slug, { kind: 'spec', content: '# Spec: local e2e\n' })
    await seed.close()

    // …then drive the REAL binary with ambient auth (D8). Non-terminal
    // commands only — no forge in this env.
    const env = {
      ...process.env,
      AB_STORE: root,
      AB_BUILD: slug,
      AB_PHASE: 'implement@1',
      AB_SESSION: 's_e2e',
      AB_TOKEN: '',
    }
    const bin = fileURLToPath(new URL('../../bin/ab.ts', import.meta.url))
    const ab = async (
      argv: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      const proc = Bun.spawn([process.execPath, bin, ...argv], {
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

    const got = await ab(['artifact', 'get', 'spec'])
    expect(got.stderr).toBe('')
    expect(got.code).toBe(0)
    expect(got.stdout).toBe('# Spec: local e2e\n\n') // content + console.log newline

    await writeFile(join(ws, 'plan.md'), '# Plan via the binary\n')
    const put = await ab(['artifact', 'put', 'plan', join(ws, 'plan.md')])
    expect(put.stderr).toBe('')
    expect(put.code).toBe(0)
    expect(put.stdout).toBe('0\n') // the assigned rev is the one output (§8.2)

    const obs = await ab(['observe', '--kind', 'followup', 'tighten the retry-after copy'])
    expect(obs.stderr).toBe('')
    expect(obs.code).toBe(0)
    expect(obs.stdout).toMatch(/^observation recorded: obs_[0-9a-f]{8}\n$/)

    // Round-trip through the sqlite store (§7.2.1).
    const store = openLocalStore(root)
    try {
      const plan = (await store.getArtifact(slug, 'plan'))!
      expect(textContent(plan)).toBe('# Plan via the binary\n')
      expect(plan.meta.revision).toBe(0)
      const events = await store.getEvents(slug)
      expect(events).toHaveLength(1)
      const event = events[0]!
      expect(event.seq).toBe(1)
      // The observation's actor is the ambient session (D8, §8.1).
      expect(event.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_e2e' })
      expect(event.type).toBe('observation.recorded')
      if (event.type === 'observation.recorded') {
        expect(event.payload.kind).toBe('followup')
        expect(event.payload.summary).toBe('tighten the retry-after copy')
        expect(event.payload.id).toMatch(/^obs_[0-9a-f]{8}$/)
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
// The config sets the repo-wide default runtime (`[agent]`) and routes ONE
// agent phase (code-review) to a second runtime with a model
// (`{ runtime = "pi", model = "kimi-k3" }`). The build runs to PR, and its
// stored `session.started` events + transcripts show code-review on pi×kimi-k3
// while every other phase stays on the default runtime. Both runtimes are
// backed by the same scripted runner in the harness, so the session numbering
// the other scenarios rely on is unchanged.

const TWO_AXIS_TOML = `${CONFIG_TOML}
[agent]
runtime = "scripted"

[roles]
code-review = { runtime = "pi", model = "kimi-k3" }
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

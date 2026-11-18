/**
 * A build resuming from a ticket wait restacks onto its target's current head
 * before the declaring phase resumes (SPEC §11 "Ticket waits"), so the resumed
 * session sees the merged blockers. Implement publishes its commits before
 * the wait; a clean replay resumes implement directly, a conflicting one
 * reconciles first, and an unchanged target resumes without a restack. A
 * reconcile session that waits has its frozen replay superseded when the
 * target moved, and keeps it when the target did not. An agent verifier that
 * waits re-verifies every step on the cleanly restacked base before finalize.
 * In-memory store, scripted agents, fake forge, real git worktrees.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { controlBuild } from '../cli/build-control'
import { normalizeVerifyCompletion } from '../events/payloads'
import {
  CONFIG_TOML,
  GIT_ID,
  commitAll,
  git,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  writeFileIn,
  type Cli,
  type E2eHarness,
  type SkillHandlers,
} from './harness'

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

const hasGuidance = (cli: Cli) => existsSync(join(cli.ws, cli.env.contextDir!, 'guidance.json'))
const head = async (cli: Cli) => (await git(['rev-parse', 'HEAD'], cli.ws)).trim()
const contains = async (ws: string, commit: string) =>
  git(['merge-base', '--is-ancestor', commit, 'HEAD'], ws).then(
    () => true,
    () => false,
  )

async function onlyBuild(h: E2eHarness): Promise<string> {
  const [record] = await h.store.listBuilds()
  if (record === undefined) throw new Error('no build')
  return record.slug
}

/** Accept the pending wait, answer it, and run the resumed build. */
async function answerAndResume(h: E2eHarness, slug: string, before?: () => Promise<void>) {
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  expect(ofType(await h.events(slug), 'wait.entered')).toHaveLength(1)
  await before?.()
  await controlBuild({
    store: h.store,
    repo: h.origin,
    slug,
    env: { USER: 'operator' },
    action: { kind: 'answer', text: 'T-B landed; continue' },
  })
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  return h.runLatest()
}

/** Implement writes `shared.txt`, commits, and waits on T-B; once resumed it
 * records its HEAD and finishes normally. */
function implementWaits(resumedHeads: string[]): SkillHandlers {
  const handlers = happyHandlers()
  const implement = handlers.implement!
  handlers.implement = async (cli) => {
    await cli.run(['context'])
    if (!hasGuidance(cli)) {
      await writeFileIn(cli.ws, 'shared.txt', 'limit = build\n')
      await commitAll(cli.ws, 'implement: shared limit')
      await cli.run(['wait-on', 'T-B', '--reason', 'needs the T-B schema'])
      return
    }
    resumedHeads.push(await head(cli))
    await implement(cli)
  }
  return handlers
}

test('implement publishes before waiting and resumes on a clean wait-resume restack', async () => {
  const heads: string[] = []
  const h = await makeHarness({
    handlers: implementWaits(heads),
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  expect(h.cliErrors).toEqual([])
  const [requested] = ofType(await h.events(slug), 'wait.requested')
  expect(requested?.payload.publication).toMatchObject({ settlement: 'published' })
  let blocker = ''
  const state = await answerAndResume(h, slug, async () => {
    blocker = await h.advanceRemote({ 'blocker.txt': 'T-B schema\n' }, 'Land T-B')
  })
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')
  const events = await h.events(slug)
  const completed = ofType(events, 'restack.completed')
  expect(completed[0]?.payload).toMatchObject({ trigger: 'wait-resume', targetBase: blocker })
  expect(ofType(events, 'reconcile.started')).toEqual([])
  expect(ofType(events, 'implement.started').map((e) => e.payload.round)).toEqual([1, 1])
  expect(heads).toHaveLength(1)
  expect(heads[0]).toBe(completed[0]!.payload.headSha)
}, 120_000)

test('a conflicting wait-resume restack reconciles before implement resumes', async () => {
  const heads: string[] = []
  const handlers = implementWaits(heads)
  const reconciled: boolean[] = []
  let blocker = ''
  handlers.reconcile = async (cli) => {
    await cli.run(['context'])
    reconciled.push(await contains(cli.ws, blocker))
    await writeFileIn(cli.ws, 'shared.txt', 'limit = build and target\n')
    await git(['add', 'shared.txt'], cli.ws)
    await git([...GIT_ID, '-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
    const notes = await writeFileIn(cli.ws, '.ab/reconcile-notes.md', 'Kept both limits.\n')
    await cli.run(['done', '--notes', notes])
  }
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  const state = await answerAndResume(h, slug, async () => {
    blocker = await h.advanceRemote({ 'shared.txt': 'limit = target\n' }, 'Land T-B')
  })
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')
  const events = await h.events(slug)
  expect(ofType(events, 'restack.prepared')[0]?.payload.trigger).toBe('wait-resume')
  expect(ofType(events, 'restack.replayed')[0]?.payload.conflicted).toBe(true)
  expect(reconciled).toEqual([true])
  const completed = ofType(events, 'restack.completed')[0]
  expect(completed?.payload).toMatchObject({ trigger: 'wait-resume', targetBase: blocker })
  // Implement resumes after the reconcile publishes, on the reconciled head.
  const reconcileDone = ofType(events, 'reconcile.completed')[0]!
  const resumedStart = ofType(events, 'implement.started').at(-1)!
  expect(resumedStart.seq).toBeGreaterThan(reconcileDone.seq)
  expect(heads).toEqual([completed!.payload.headSha])
}, 120_000)

test('an unchanged target resumes the declaring phase without a restack', async () => {
  const heads: string[] = []
  const h = await makeHarness({
    handlers: implementWaits(heads),
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  const published = ofType(await h.events(slug), 'wait.requested')[0]!.payload.publication!.sha
  const firstVerify = async () =>
    ofType(await h.events(slug), 'restack.prepared').filter(
      (e) => e.payload.trigger === 'wait-resume',
    )
  await answerAndResume(h, slug)
  expect(h.cliErrors).toEqual([])
  expect(await firstVerify()).toEqual([])
  expect(ofType(await h.events(slug), 'restack.advanced')).toEqual([])
  expect(heads).toEqual([published])
}, 120_000)

/** Implement moves the target under itself so verify entry conflicts; the
 * first reconcile session waits on T-B, later ones resolve. */
function reconcileWaits(h: () => E2eHarness, seen: { picks: string[]; blocker?: string }) {
  const handlers = happyHandlers()
  handlers.implement = async (cli) => {
    await cli.run(['context'])
    await writeFileIn(cli.ws, 'shared.txt', 'limit = build\n')
    await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
    await commitAll(cli.ws, 'implement: shared limit')
    await h().advanceRemote({ 'shared.txt': 'limit = target one\n' }, 'Target one')
    const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', 'Shared limit.\n')
    await cli.run(['done', '--notes', notes])
  }
  handlers.reconcile = async (cli) => {
    await cli.run(['context'])
    const pick = await git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], cli.ws).then(
      (out) => out.trim(),
      () => '',
    )
    seen.picks.push(pick)
    if (!hasGuidance(cli)) {
      await cli.run(['wait-on', 'T-B', '--reason', 'resolution needs the T-B schema'])
      return
    }
    if (seen.blocker !== undefined) expect(await contains(cli.ws, seen.blocker)).toBe(true)
    await writeFileIn(cli.ws, 'shared.txt', 'limit = build and target\n')
    await git(['add', 'shared.txt'], cli.ws)
    await git([...GIT_ID, '-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
    const notes = await writeFileIn(cli.ws, '.ab/reconcile-notes.md', 'Kept both limits.\n')
    await cli.run(['done', '--notes', notes])
  }
  return handlers
}

test('a reconcile wait is superseded when the target moved and replays onto it', async () => {
  const seen: { picks: string[]; blocker?: string } = { picks: [] }
  let harness: E2eHarness | undefined
  const h = await makeHarness({
    handlers: reconcileWaits(() => harness!, seen),
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harness = h
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  expect(h.cliErrors).toEqual([])
  const first = ofType(await h.events(slug), 'reconcile.started')
  expect(first.map((e) => e.payload.attempt)).toEqual([1])
  const state = await answerAndResume(h, slug, async () => {
    seen.blocker = await h.advanceRemote(
      { 'shared.txt': 'limit = target two\n', 'blocker.txt': 'T-B schema\n' },
      'Land T-B',
    )
  })
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')
  const events = await h.events(slug)
  expect(ofType(events, 'reconcile.superseded').map((e) => e.payload)).toEqual([
    expect.objectContaining({ attempt: 1, cause: 'wait-resume' }),
  ])
  const resumed = ofType(events, 'restack.prepared').at(-1)!
  expect(resumed.payload).toMatchObject({ trigger: 'wait-resume', targetBase: seen.blocker })
  expect(ofType(events, 'reconcile.started').map((e) => e.payload.attempt)).toEqual([1, 2])
  expect(ofType(events, 'restack.completed').at(-1)?.payload.targetBase).toBe(seen.blocker)
  expect(seen.picks).toHaveLength(2)
  // Initial verification runs every configured step after the replay.
  const reconciledAt = ofType(events, 'reconcile.completed').at(-1)!.seq
  const verified = ofType(events, 'verify.completed').filter((e) => e.seq > reconciledAt)
  expect(verified.map((e) => normalizeVerifyCompletion(e.payload).outcome)).not.toContain('skipped')
  expect(verified.length).toBeGreaterThan(0)
}, 120_000)

test('a reconcile wait with an unchanged target resumes the same replay', async () => {
  const seen: { picks: string[]; blocker?: string } = { picks: [] }
  let harness: E2eHarness | undefined
  const h = await makeHarness({
    handlers: reconcileWaits(() => harness!, seen),
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harness = h
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  const state = await answerAndResume(h, slug)
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')
  const events = await h.events(slug)
  expect(ofType(events, 'reconcile.superseded')).toEqual([])
  expect(ofType(events, 'reconcile.started').map((e) => e.payload.attempt)).toEqual([1])
  expect(seen.picks).toHaveLength(2)
  expect(seen.picks[1]).toBe(seen.picks[0])
  expect(seen.picks[0]).not.toBe('')
}, 120_000)

const AGENT_VERIFY_TOML = CONFIG_TOML.replace(
  'steps = ["unit"]',
  'steps = ["unit", "e2e"]\n\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"',
)

test('a verifier wait re-verifies every step on the cleanly restacked base before finalize', async () => {
  const handlers = happyHandlers()
  const verifierHeads: string[] = []
  handlers['ab-verify-e2e'] = async (cli) => {
    await cli.run(['context'])
    if (!hasGuidance(cli)) {
      await cli.run(['wait-on', 'T-B', '--reason', 'e2e needs the T-B fixture'])
      return
    }
    verifierHeads.push(await head(cli))
    await cli.run(['verdict', 'pass'])
  }
  const h = await makeHarness({
    handlers,
    configToml: AGENT_VERIFY_TOML,
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
  })
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(ofType(await h.events(slug), 'wait.requested')[0]?.payload.phase).toBe('verify:e2e')
  let blocker = ''
  const state = await answerAndResume(h, slug, async () => {
    blocker = await h.advanceRemote({ 'blocker.txt': 'T-B fixture\n' }, 'Land T-B')
  })
  expect(h.cliErrors).toEqual([])
  expect(state.prState).toBe('open')
  const events = await h.events(slug)
  const completed = ofType(events, 'restack.completed').filter(
    (e) => e.payload.trigger === 'wait-resume',
  )
  expect(completed).toHaveLength(1)
  const resumedAt = completed[0]!.seq
  expect(completed[0]!.payload.targetBase).toBe(blocker)
  expect(ofType(events, 'reconcile.started')).toEqual([])
  // The harness runner captures no verify configuration, so the kernel
  // boundary alone opens the resumed cycle.
  expect(ofType(events, 'verify.config-captured')).toEqual([])
  // Every configured step re-runs at a new attempt on the restacked base and head.
  const before = ofType(events, 'verify.started').filter((e) => e.seq < resumedAt)
  const resumed = ofType(events, 'verify.started').filter((e) => e.seq > resumedAt)
  const priorAttempt = Math.max(...before.map((e) => e.payload.attempt))
  expect(resumed.map((e) => e.payload.step)).toEqual(['unit', 'e2e'])
  for (const start of resumed) {
    expect(start.payload.attempt).toBeGreaterThan(priorAttempt)
    expect(start.payload).toMatchObject({
      baseSha: blocker,
      headSha: completed[0]!.payload.headSha,
    })
  }
  const results = ofType(events, 'verify.completed')
    .filter((e) => e.seq > resumedAt)
    .map((e) => normalizeVerifyCompletion(e.payload))
  expect(results.map(({ step, outcome }) => ({ step, outcome }))).toEqual([
    { step: 'unit', outcome: 'pass' },
    { step: 'e2e', outcome: 'pass' },
  ])
  for (const result of results)
    expect(result).toMatchObject({ baseSha: blocker, headSha: completed[0]!.payload.headSha })
  expect(verifierHeads).toEqual([completed[0]!.payload.headSha])
  // Finalize starts once, only after the resumed cycle passes.
  const finalized = ofType(events, 'finalize.started')
  expect(finalized).toHaveLength(1)
  expect(finalized[0]!.seq).toBeGreaterThan(ofType(events, 'verify.completed').at(-1)!.seq)
}, 120_000)

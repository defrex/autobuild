/**
 * Ticket waits end to end (SPEC §11 "Ticket waits"): an implement session
 * declares with `ab wait-on` that its build waits on another ticket. The
 * dispatcher records the blocker on the build's ticket and parks the build
 * without a slot, so a ready ticket takes it at once with capacity 1. An
 * operator answer ends the wait; the build is admitted ahead of new claims
 * and implement re-runs the same round, told what it waited on. A refused
 * wait re-runs the phase with the refusal and writes nothing to the ticket.
 * In-memory store, scripted agents, fake forge, real git worktrees.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { controlBuild } from '../cli/build-control'
import { detail, renderDetail } from '../cli/status'
import { reduceBuild } from '../kernel/reducer'
import {
  CONFIG_TOML,
  git,
  happyHandlers,
  makeHarness,
  ofType,
  openWorkspacePath,
  readyTicket,
  type E2eHarness,
} from './harness'

const ONE_SLOT = CONFIG_TOML.replace('capacity = 2', 'capacity = 1')

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

async function slugFor(h: E2eHarness, ticket: string): Promise<string> {
  for (const record of await h.store.listBuilds())
    if (record.ticket?.id === ticket) return record.slug
  throw new Error(`no build for ticket ${ticket}`)
}

function runnersFor(h: E2eHarness, slug: string) {
  return h.launched.filter((entry) => entry.slug === slug)
}

type Guidance = {
  escalation: string
  answer: string
  wait?: { tickets: string[]; outcome: string; cause?: string; message: string }
}

/** Implement declares a wait on `tickets` when it has no guidance yet, and
 * records every guidance.json it is given and the HEAD it resumed on. */
function waitingHandlers(tickets: string[], seen: Guidance[], heads: string[] = []) {
  const handlers = happyHandlers()
  const implement = handlers.implement!
  handlers.implement = async (cli) => {
    await cli.run(['context'])
    const path = join(cli.ws, cli.env.contextDir!, 'guidance.json')
    if (!existsSync(path)) {
      await cli.run(['wait-on', ...tickets, '--reason', 'needs the B schema to land first'])
      return
    }
    seen.push(JSON.parse(await Bun.file(path).text()) as Guidance)
    heads.push((await git(['rev-parse', 'HEAD'], cli.ws)).trim())
    await implement(cli)
  }
  return handlers
}

test('a waiting build frees its slot, keeps its work, and resumes ahead of new claims', async () => {
  const seen: Guidance[] = []
  const heads: string[] = []
  const h = await makeHarness({
    handlers: waitingHandlers(['T-B'], seen, heads),
    tickets: [
      readyTicket('T-A'),
      readyTicket('T-B', { state: 'Backlog' }),
      readyTicket('T-C', { title: 'Add audit logging' }),
    ],
    configToml: ONE_SLOT,
  })
  harnesses.push(h)

  expect((await h.dispatcher.tick()).dispatched).toBe(1)
  const a = await slugFor(h, 'T-A')
  await runnersFor(h, a)[0]!.runner.run()
  expect(h.cliErrors).toEqual([])
  let events = await h.events(a)
  expect(ofType(events, 'phase.failed')).toEqual([])
  expect(ofType(events, 'wait.requested')).toHaveLength(1)
  const workspace = openWorkspacePath(events)!
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim()

  // The dispatcher accepts the wait and the freed slot goes to T-C at once.
  h.clock.advance(3_600_001)
  expect((await h.dispatcher.tick()).dispatched).toBe(1)
  events = await h.events(a)
  expect(ofType(events, 'wait.entered')).toHaveLength(1)
  expect((await h.tickets.get('T-A'))?.blockedBy).toEqual(['T-B'])
  const c = await slugFor(h, 'T-C')
  expect(reduceBuild(events).status).toBe('blocked')
  expect(existsSync(workspace)).toBe(true)
  expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim()).toBe(branch)
  const status = renderDetail(
    detail((await h.store.getBuild(a))!, events, h.clock()),
    h.clock(),
  ).join('\n')
  expect(status).toContain('waiting on: T-B — needs the B schema to land first')

  // T-B's change lands on the target while T-A waits.
  const blocker = await h.advanceRemote({ 'blocker.txt': 'T-B schema\n' }, 'Land T-B')

  // An operator ends the wait early through the shared answer path.
  await controlBuild({
    store: h.store,
    repo: h.origin,
    slug: a,
    env: { USER: 'operator' },
    action: { kind: 'answer', text: 'T-B landed; continue' },
  })
  h.tickets.add(readyTicket('T-D', { title: 'Add metrics' }))
  // T-C still holds the only slot: T-A waits for it and T-D is not claimed.
  h.clock.advance(3_600_001)
  expect((await h.dispatcher.tick()).dispatched).toBe(0)
  expect(runnersFor(h, a)).toHaveLength(1)

  // T-C finishes its pipeline and parks for its merge decision. The tick that
  // settles it reserves the freed slot for T-A, and the next admits T-A.
  await runnersFor(h, c)[0]!.runner.run()
  for (let tick = 0; tick < 2; tick++) {
    h.clock.advance(3_600_001)
    expect((await h.dispatcher.tick()).dispatched).toBe(0)
  }
  expect(h.tickets.claims).not.toContain('T-D')
  expect(runnersFor(h, a)).toHaveLength(2)

  const resumed = await runnersFor(h, a)[1]!.runner.run()
  expect(h.cliErrors).toEqual([])
  expect(resumed.prState).toBe('open')
  const implementStarts = ofType(await h.events(a), 'implement.started')
  expect(implementStarts.map((event) => event.payload.round)).toEqual([1, 1])
  // T-A had published nothing, so the resume fast-forwarded it onto the
  // target, and the resumed implement session's checkout holds T-B's commit.
  const advanced = ofType(await h.events(a), 'restack.advanced')
  expect(advanced.map((event) => [event.payload.trigger, event.payload.to])).toEqual([
    ['wait-resume', blocker],
  ])
  expect(heads).toEqual([blocker])
  const completed = ofType(await h.events(a), 'implement.completed')
  expect(completed.at(-1)?.payload.commits.base).toBe(blocker)
  expect(seen).toEqual([
    expect.objectContaining({
      answer: 'T-B landed; continue',
      wait: expect.objectContaining({ tickets: ['T-B'], outcome: 'ended', cause: 'operator' }),
    }),
  ])
}, 120_000)

test('a refused wait re-runs implement with the reason and writes nothing to the ticket', async () => {
  const seen: Guidance[] = []
  const h = await makeHarness({
    handlers: waitingHandlers(['T-DONE'], seen),
    tickets: [readyTicket('T-A'), readyTicket('T-DONE', { state: 'Done' })],
    configToml: ONE_SLOT,
  })
  harnesses.push(h)
  await h.tickets.transition('T-DONE', 'Done')

  expect((await h.dispatcher.tick()).dispatched).toBe(1)
  const a = await slugFor(h, 'T-A')
  await runnersFor(h, a)[0]!.runner.run()
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  const refused = ofType(await h.events(a), 'wait.refused')
  expect(refused.map((event) => event.payload.cause)).toEqual(['completed'])
  expect((await h.tickets.get('T-A'))?.blockedBy).toBeUndefined()

  const relaunched = runnersFor(h, a).at(-1)!
  expect(runnersFor(h, a)).toHaveLength(2)
  expect((await relaunched.runner.run()).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  expect(seen).toEqual([
    expect.objectContaining({
      answer: 'already completed: T-DONE; continue without waiting on them',
      wait: expect.objectContaining({ tickets: ['T-DONE'], outcome: 'refused' }),
    }),
  ])
}, 120_000)

test('the registry answer tool ends a wait; a bare retry still names what it waited on', async () => {
  const seen: Guidance[] = []
  const h = await makeHarness({
    handlers: waitingHandlers(['T-B'], seen),
    tickets: [readyTicket('T-A'), readyTicket('T-B', { state: 'Backlog' })],
    configToml: ONE_SLOT,
  })
  harnesses.push(h)

  await h.dispatcher.tick()
  const a = await slugFor(h, 'T-A')
  await runnersFor(h, a)[0]!.runner.run()
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  expect(reduceBuild(await h.events(a)).status).toBe('blocked')

  const { buildRegistry } = await import('../operator/registry')
  expect(
    await buildRegistry({ store: h.store }).call(
      'builds.answer',
      { repo: h.origin, slug: a, resolution: 'retry' },
      { identity: 'operator' },
    ),
  ).toMatchObject({ kind: 'answered', count: 1, resolution: 'retry' })
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  expect(runnersFor(h, a)).toHaveLength(2)
  expect((await runnersFor(h, a)[1]!.runner.run()).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  expect(seen).toEqual([
    {
      escalation: expect.stringMatching(/^esc_/),
      answer: expect.stringContaining('Your wait on T-B ended (operator)'),
      wait: expect.objectContaining({ tickets: ['T-B'], outcome: 'ended', cause: 'operator' }),
    },
  ])
}, 120_000)

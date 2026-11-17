/**
 * Ticket hand-back as an operator sees it: `ab abort` (or a spec bounce)
 * through the CLI, a repository-wide `ab watch` on its default filter, and the
 * MCP `repository.events` tool. A watcher that moves the ticket as soon as the
 * `ticket.handed-back` record arrives is never overridden by a later
 * dispatcher write for the same hand-back.
 */
import { expect, test } from 'bun:test'
import { runCli } from '../cli/main'
import { abWatch } from '../cli/watch'
import { parseConfig } from '../config/load'
import { DISPATCHER } from '../events/envelope'
import { sequentialIds } from '../ids'
import { buildRegistry } from '../operator/registry'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket } from '../ports/types'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { Dispatcher } from '../processes/dispatcher'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { CONFORMING_BODY } from './harness'

const REPO = '/handback/repo'
const SLUG = 'waiting-build'

const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : { stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`, stderr: '', exitCode: 0 }

function ticket(state: string, body = CONFORMING_BODY, blockedBy = ['T-2']): Ticket {
  return {
    revision: 'fixture',
    ref: { source: 'fake', id: 'T-1', title: 'Waiting work' },
    title: 'Waiting work',
    body,
    state,
    resolved: false,
    labels: ['autobuild'],
    blockedBy,
  }
}

async function world(seed: Ticket) {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  const tickets = new FakeTicketSource([seed])
  const forge = new FakeForge()
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces: new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' }),
    forge,
    config: parseConfig('[tickets]\nsource = "file"\nreadyState = "Ready"\n'),
    repo: REPO,
    exec: fakeExec,
    launchRunner: async () => 'scheduled',
    ids: sequentialIds(),
    clock,
  })
  const cliErrors: string[] = []
  const cli = async (argv: string[]) => {
    const out: string[] = []
    const code = await runCli(argv, {
      workspacePath: REPO,
      processEnv: { USER: 'operator' },
      exec: fakeExec,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => cliErrors.push(line),
      openStore: () => store,
    })
    expect(code).toBe(0)
    return out
  }
  const registry = buildRegistry({ store, clock })
  const baseline = (await registry.call('repository.events', { repo: REPO })) as {
    cursor: number
  }
  /** Watch the repository on its default filter while ticking the dispatcher
   * at every poll boundary; resolve with the first delivered record. */
  const watchOne = async (tick: () => Promise<unknown>) => {
    const out: string[] = []
    await abWatch({
      targetRepo: REPO,
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      stderr: (line) => cliErrors.push(line),
      openStore: () => store,
      now: clock,
      delay: async () => {
        await tick()
        clock.advance(1000)
      },
      json: true,
      count: 1,
      timeout: '60',
    })
    // One record, then the closing cursor line.
    const records = out
      .map(
        (line) =>
          JSON.parse(line) as { event?: { type: string; payload: Record<string, unknown> } },
      )
      .filter((record) => record.event !== undefined)
    expect(records).toHaveLength(1)
    return records[0] as { event: { type: string; payload: Record<string, unknown> } }
  }
  /** After the watcher moved the ticket, later ticks must leave it alone. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(120_000)
      await dispatcher.tick({ acceptNewWork: false })
    }
  }
  return { clock, store, tickets, dispatcher, cli, cliErrors, registry, baseline, watchOne, settle }
}

async function seedBuild(store: MemoryBuildStore) {
  const ref = { source: 'fake', id: 'T-1', title: 'Waiting work' }
  await store.createBuild({
    slug: SLUG,
    repo: REPO,
    ticket: ref,
    branch: `ab/${SLUG}`,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: ref, repo: REPO, baseBranch: 'main' },
    },
  })
}

for (const destination of ['ready', 'triage'] as const) {
  test(`a watcher acting on an abort --to ${destination} hand-back is never overridden`, async () => {
    const w = await world(ticket('Doing'))
    await seedBuild(w.store)
    const argv = destination === 'ready' ? ['--to', 'ready', '--reason', 'waiting on T-2'] : []
    expect(await w.cli(['abort', SLUG, ...argv])).toEqual([
      `build ${SLUG}: abort requested; ticket returns to ${destination}`,
    ])

    const record = await w.watchOne(() => w.dispatcher.tick({ acceptNewWork: false }))
    expect(record.event.type).toBe('ticket.handed-back')
    expect(record.event.payload).toMatchObject({
      build: SLUG,
      cause: 'abort',
      role: destination,
      state: destination === 'ready' ? 'Ready' : 'Triage',
      ...(destination === 'ready' ? { reason: 'waiting on T-2' } : {}),
    })
    // The watcher moves the ticket the moment the record arrives.
    await w.tickets.transition('T-1', 'Backlog')
    await w.settle()

    expect((await w.tickets.get('T-1'))?.state).toBe('Backlog')
    expect((await w.tickets.get('T-1'))?.blockedBy).toEqual(['T-2'])
    expect(w.tickets.transitions).toEqual([
      { id: 'T-1', state: destination === 'ready' ? 'Ready' : 'Triage' },
      { id: 'T-1', state: 'Backlog' },
    ])
    expect(w.cliErrors).toEqual([])

    // MCP parity: the same single record through repository.events.
    const page = (await w.registry.call('repository.events', {
      repo: REPO,
      cursor: w.baseline.cursor,
    })) as { events: { type: string; seq: number }[] }
    expect(page.events.map((event) => event.type)).toEqual(['ticket.handed-back'])
  })
}

test('a watcher acting on a spec-bounce hand-back is never overridden', async () => {
  const w = await world(ticket('Ready', 'make it faster', []))
  const record = await w.watchOne(() => w.dispatcher.tick())
  expect(record.event.type).toBe('ticket.handed-back')
  expect(record.event.payload).toMatchObject({
    cause: 'spec-bounce',
    role: 'triage',
    state: 'Triage',
    missing: expect.arrayContaining(["an '## Out of scope' heading"]),
  })
  await w.tickets.transition('T-1', 'Backlog')
  await w.settle()
  expect((await w.tickets.get('T-1'))?.state).toBe('Backlog')
  expect(w.tickets.transitions).toEqual([
    { id: 'T-1', state: 'Triage' },
    { id: 'T-1', state: 'Backlog' },
  ])
  expect(w.cliErrors).toEqual([])
  const page = (await w.registry.call('repository.events', {
    repo: REPO,
    cursor: w.baseline.cursor,
  })) as { events: { type: string }[] }
  expect(page.events.map((event) => event.type)).toEqual(['ticket.handed-back'])
})

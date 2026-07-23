/**
 * The minimal file-source setup, end to end (SPEC §3.3, §13): a real
 * Dispatcher tick driving a REAL FileTicketSource over a real directory — no
 * fake ticket source. The required `[tickets].readyState = "ready"` is explicit
 * while `dir` is omitted, so this also covers the default
 * `.autobuild/tickets` location. The file source canonicalizes the configured
 * state to the `ready/` directory, keeping the gate "the directory a ticket
 * sits in."
 *
 * The pieces are unit-tested apart (file.test.ts owns the adapter, the
 * readyCriteria block in dispatcher.test.ts owns resolution); what only this
 * file can show is that they AGREE — that the directory readyCriteria says to
 * scan is the one claim() will take from. A tightening of either side that
 * silently stalls the dispatcher fails here and nowhere else.
 *
 * This does not go through `ab dispatch`: it is the focused agreement test at
 * the Dispatcher/TicketSource seam. CLI dispatch wiring has separate coverage
 * over temporary repositories, whose default state roots are isolated beneath
 * those repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { sequentialIds } from '../ids'
import { FakeForge } from '../ports/forge/fake'
import { createTicketSource } from '../ports/tickets/create'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { Dispatcher, emptyTickReport } from './dispatcher'

const REPO = '/repos/origin'
const BASE_SHA = 'base-sha-42'

const CONFORMING_BODY = [
  'Login attempts are currently unlimited; throttle repeated failures.',
  '',
  '## Acceptance criteria',
  '',
  '- a sixth failed login within five minutes returns 429',
  '',
  '## Out of scope',
  '',
  '- captcha',
  '',
].join('\n')

let repoDir: string

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'ab-file-dispatch-'))
})

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true })
})

/** The default tracker path selected when [tickets].dir is absent. */
const trackerDir = () => join(repoDir, '.autobuild', 'tickets')

/**
 * The file tracker's ready gate is the `ready/` directory. Fixtures receive
 * `[tickets].readyState = "ready"` inside an existing tickets table or in a
 * minimal file-source table when none exists.
 */
function withReadyState(toml: string): string {
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[tickets\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[tickets\][^\n]*\n)/, `$1$2readyState = "ready"\n`)
  }
  return `[tickets]\nsource = "file"\nreadyState = "ready"\n${toml}`
}

async function harness(toml = '') {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const config = parseConfig(withReadyState(toml))
  // The real seam: config → factory → adapter, exactly as defaultWire does it.
  const tickets = await createTicketSource(config.tickets, {}, repoDir)
  const launches: string[] = []
  const exec: Exec = async () => ({
    stdout: `${BASE_SHA}\trefs/heads/main\n`,
    stderr: '',
    exitCode: 0,
  })
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces: new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' }),
    forge: new FakeForge(),
    config,
    repo: REPO,
    exec,
    launchRunner: async (slug) => {
      launches.push(slug)
      return 'scheduled'
    },
    ids: sequentialIds(),
    clock,
  })
  return { dispatcher, tickets, launches, store }
}

const ls = (state: string) => readdir(join(trackerDir(), state))

describe('minimal config dispatch over the real file tracker', () => {
  test('default dir and no labels: mv into ready/ is sufficient to dispatch', async () => {
    const h = await harness()

    // Create files to triage/, then groom it exactly the way a human or the
    // ab-tickets skill would: one mv. No label, no frontmatter edit.
    const created = await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })
    expect(await ls('triage')).toEqual([`${created.ref.id}.md`])
    await h.tickets.transition(created.ref.id, 'Ready')

    await h.dispatcher.tick()

    expect(h.launches).toHaveLength(1)
    // Claiming visibly removes it from ready/ — the move IS the claim record.
    expect(await ls('ready')).toEqual([])
    expect(await ls('doing')).toEqual([`${created.ref.id}.md`])
  })

  test('malformed terminal content is reported while valid ready work dispatches', async () => {
    const h = await harness()
    const valid = await h.tickets.create({
      title: 'Add rate limiting',
      body: CONFORMING_BODY,
    })
    await h.tickets.transition(valid.ref.id, 'Ready')
    const malformedPath = join(trackerDir(), 'done', 'notes.md')
    const malformed = '+++\nid = "notes"\n+++\nold operator notes\n'
    await Bun.write(malformedPath, malformed)

    const report = await h.dispatcher.tick()

    expect(report).toEqual({
      ...emptyTickReport(),
      dispatched: 1,
      invalidTickets: 1,
      ticketDiagnostics: [expect.stringContaining(malformedPath)],
    })
    expect(report.ticketDiagnostics[0]).toMatch(/invalid frontmatter.*title/s)
    expect(h.launches).toEqual(['add-rate-limiting'])
    expect(await ls('doing')).toEqual([`${valid.ref.id}.md`])
    expect(await Bun.file(malformedPath).text()).toBe(malformed)
  })

  test('malformed ready content stays unclaimed while another ready ticket dispatches', async () => {
    const h = await harness()
    const valid = await h.tickets.create({
      title: 'Add rate limiting',
      body: CONFORMING_BODY,
    })
    await h.tickets.transition(valid.ref.id, 'Ready')
    const malformedPath = join(trackerDir(), 'ready', 'broken.md')
    const malformed = '# not a ticket record\n'
    await Bun.write(malformedPath, malformed)

    const report = await h.dispatcher.tick()

    expect(report).toEqual({
      ...emptyTickReport(),
      dispatched: 1,
      invalidTickets: 1,
      ticketDiagnostics: [
        `${malformedPath}: malformed ticket file — missing opening "+++" fence`,
      ],
    })
    expect(h.launches).toEqual(['add-rate-limiting'])
    expect(await ls('doing')).toEqual([`${valid.ref.id}.md`])
    expect(await ls('ready')).toEqual(['broken.md'])
    expect(await Bun.file(malformedPath).text()).toBe(malformed)
  })

  test('a second tick does not dispatch the same ticket a second time', async () => {
    const h = await harness()
    const created = await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })
    await h.tickets.transition(created.ref.id, 'Ready')

    await h.dispatcher.tick()
    await h.dispatcher.tick()

    // ONE build, not one launch: the second tick's lease sweep (§15.6-C)
    // legitimately re-launches the same slug, because this harness's fake
    // launchRunner never appends runner.attached. What must not happen is a
    // SECOND build off the same ticket — the ticket is in doing/, so
    // listReady no longer sees it.
    expect(await h.store.listBuilds()).toHaveLength(1)
    expect(new Set(h.launches)).toEqual(new Set(['add-rate-limiting']))
    expect(await ls('doing')).toEqual([`${created.ref.id}.md`])
  })

  test('a ticket left in triage/ is not dispatched', async () => {
    const h = await harness()
    await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })

    await h.dispatcher.tick()

    expect(h.launches).toEqual([])
    expect(await ls('triage')).toHaveLength(1)
    expect(await ls('doing')).toEqual([])
  })

  test('the default tracker gitignores itself — git never sees the local backlog', async () => {
    const h = await harness()
    await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })

    expect(await Bun.file(join(trackerDir(), '.gitignore')).text()).toBe('*\n')
  })

  test('a non-conforming spec bounces back to triage/, not into doing/', async () => {
    const h = await harness()
    const created = await h.tickets.create({ title: 'Vague idea', body: 'make auth better' })
    await h.tickets.transition(created.ref.id, 'Ready')

    await h.dispatcher.tick()

    expect(h.launches).toEqual([])
    // Bounce lands in triage/ because the dispatcher's triageState default
    // ('Triage') and the canonical directories are the same names.
    expect(await ls('triage')).toEqual([`${created.ref.id}.md`])
    expect(await ls('ready')).toEqual([])
  })

  test('a cp instead of an mv is a loud error, never a double dispatch', async () => {
    const h = await harness()
    const created = await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })
    const file = `${created.ref.id}.md`
    // The mistake the AC names: copy, don't move.
    await Bun.write(join(trackerDir(), 'ready', file), Bun.file(join(trackerDir(), 'triage', file)))

    await expect(h.dispatcher.tick()).rejects.toThrow('more than one state directory')
    expect(h.launches).toEqual([])
  })

  test('explicit [tickets] dir + readyLabels still gate the way they always did', async () => {
    const h = await harness(
      '[tickets]\nsource = "file"\ndir = "tickets"\nreadyLabels = ["autobuild"]\n',
    )
    const plain = await h.tickets.create({ title: 'Unlabelled', body: CONFORMING_BODY })
    const labelled = await h.tickets.create({
      title: 'Labelled',
      body: CONFORMING_BODY,
      labels: ['autobuild'],
    })
    await h.tickets.transition(plain.ref.id, 'Ready')
    await h.tickets.transition(labelled.ref.id, 'Ready')

    await h.dispatcher.tick()

    // An explicit readyLabels is honored, so ready/ alone is no longer enough.
    expect(h.launches).toHaveLength(1)
    expect(await readdir(join(repoDir, 'tickets', 'doing'))).toEqual([`${labelled.ref.id}.md`])
    expect(await readdir(join(repoDir, 'tickets', 'ready'))).toEqual([`${plain.ref.id}.md`])
    // ...and the user's own directory is never gitignored by ab.
    expect(await readdir(join(repoDir, 'tickets'))).not.toContain('.gitignore')
  })
})

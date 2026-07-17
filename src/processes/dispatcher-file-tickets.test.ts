/**
 * The zero-config claim, end to end (SPEC §3.3, §13): a real Dispatcher tick
 * driving a REAL FileTicketSource over a real directory — no fake ticket
 * source — with a config that has no [tickets] table. The only required
 * dispatcher key is `readyState` (AUT-11), which the harness injects as
 * `"ready"`; the file source canonicalizes it to the `ready/` directory, so the
 * gate stays "the directory a ticket sits in."
 *
 * This is the spec's headline: `mv` a ticket into `ready/` and the next tick
 * dispatches it. The pieces are unit-tested apart (file.test.ts owns the
 * adapter, the readyCriteria block in dispatcher.test.ts owns resolution);
 * what only this file can show is that they AGREE — that the directory
 * readyCriteria says to scan is the one claim() will take from. A tightening
 * of either side that silently stalls the dispatcher fails here and nowhere
 * else.
 *
 * Note it does NOT go through `ab dispatch`, and that is permanent, not a
 * workaround: abDispatch's defaultWire opens a real SQLite store and a real
 * worktree provider under DEFAULT_LOCAL_ROOT (~/.autobuild), so driving the
 * CLI entry point from a test would write into the developer's actual autobuild
 * home. cli/dispatch.test.ts:202 carries that reasoning in full and stops at
 * the `wire` seam for the same reason. This file covers the seam by
 * construction instead: MemoryBuildStore + fakes, exactly as dispatcher.test.ts
 * wires them.
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
import { Dispatcher } from './dispatcher'

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
  repoDir = await mkdtemp(join(tmpdir(), 'ab-zero-config-'))
})

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true })
})

/** The tracker the factory picks when autobuild.toml says nothing about tickets. */
const trackerDir = () => join(repoDir, '.autobuild', 'tickets')

/**
 * `[dispatcher].readyState` is required now (AUT-11). The file tracker's ready
 * gate IS the `ready/` directory, and `stateDir` canonicalizes `"ready"` to it,
 * so every fixture here gets `readyState = "ready"` unless it sets its own —
 * appended into an existing `[dispatcher]` header (TOML forbids the table
 * twice) or prepended as its own table.
 */
function withReadyState(toml: string): string {
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[dispatcher\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[dispatcher\][^\n]*\n)/, `$1$2readyState = "ready"\n`)
  }
  return `[dispatcher]\nreadyState = "ready"\n${toml}`
}

function harness(toml = '') {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const config = parseConfig(withReadyState(toml))
  // The real seam: config → factory → adapter, exactly as defaultWire does it.
  const tickets = createTicketSource(config.tickets, {}, repoDir)
  const launches: string[] = []
  const exec: Exec = async () => ({
    stdout: `${BASE_SHA}\trefs/heads/main\n`,
    stderr: '',
    exitCode: 0,
  })
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces: new FakeWorkspaceProvider({ root: '/ws' }),
    forge: new FakeForge(),
    config,
    repo: REPO,
    exec,
    launchRunner: async (slug) => {
      launches.push(slug)
    },
    ids: sequentialIds(),
    clock,
  })
  return { dispatcher, tickets, launches, store }
}

const ls = (state: string) => readdir(join(trackerDir(), state))

describe('zero-config dispatch over the real file tracker', () => {
  test('no [tickets] table, no labels: mv into ready/ is sufficient to dispatch', async () => {
    const h = harness()

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

  test('a second tick does not dispatch the same ticket a second time', async () => {
    const h = harness()
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
    const h = harness()
    await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })

    await h.dispatcher.tick()

    expect(h.launches).toEqual([])
    expect(await ls('triage')).toHaveLength(1)
    expect(await ls('doing')).toEqual([])
  })

  test('the default tracker gitignores itself — git never sees the local backlog', async () => {
    const h = harness()
    await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })

    expect(await Bun.file(join(trackerDir(), '.gitignore')).text()).toBe('*\n')
  })

  test('a non-conforming spec bounces back to triage/, not into doing/', async () => {
    const h = harness()
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
    const h = harness()
    const created = await h.tickets.create({ title: 'Add rate limiting', body: CONFORMING_BODY })
    const file = `${created.ref.id}.md`
    // The mistake the AC names: copy, don't move.
    await Bun.write(join(trackerDir(), 'ready', file), Bun.file(join(trackerDir(), 'triage', file)))

    await expect(h.dispatcher.tick()).rejects.toThrow('more than one state directory')
    expect(h.launches).toEqual([])
  })

  test('explicit [tickets] dir + readyLabels still gate the way they always did', async () => {
    const h = harness(
      '[tickets]\nsource = "file"\ndir = "tickets"\n[dispatcher]\nreadyLabels = ["autobuild"]\n',
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

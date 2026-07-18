import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manualClock } from '../../testing/fixed'
import { FileTicketSource } from './file'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ab-file-tickets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function source(opts: Partial<ConstructorParameters<typeof FileTicketSource>[0]> = {}) {
  return new FileTicketSource({
    dir,
    clock: manualClock('2026-07-15T12:00:00.000Z'),
    ...opts,
  })
}

const SPEC_BODY = [
  '# Rate-limit auth endpoints',
  '',
  '## What',
  'Add a token bucket to /auth/*.',
  '',
  '## Acceptance criteria',
  '- 429 after N attempts',
  '',
].join('\n')

/** Seed `<state>/<id>.md` — the state is the directory, so it's a param of the path. */
async function seedTicket(
  id: string,
  over: { state?: string; labels?: string[]; body?: string; blockedBy?: string[] } = {},
): Promise<string> {
  const state = (over.state ?? 'ready').toLowerCase()
  const lines = ['+++', `id = ${JSON.stringify(id)}`, `title = "Ticket ${id}"`]
  if (over.labels !== undefined) {
    lines.push(`labels = [ ${over.labels.map((l) => JSON.stringify(l)).join(', ')} ]`)
  }
  if (over.blockedBy !== undefined) {
    lines.push(`blockedBy = [ ${over.blockedBy.map((b) => JSON.stringify(b)).join(', ')} ]`)
  }
  lines.push('+++')
  const content = `${lines.join('\n')}\n${over.body ?? SPEC_BODY}`
  await mkdir(join(dir, state), { recursive: true })
  await writeFile(join(dir, state, `${id}.md`), content)
  return content
}

const path = (state: string, id: string) => join(dir, state, `${id}.md`)

describe('FileTicketSource', () => {
  test('full CRUD round-trip: create → get → listReady → claim → transition → comment', async () => {
    const tickets = source({ createState: 'Ready' })

    const created = await tickets.create({
      title: 'Rate-limit auth',
      body: SPEC_BODY,
      labels: ['autobuild'],
    })
    expect(created.ref).toEqual({ source: 'file', id: 'file-1', title: 'Rate-limit auth' })
    expect(created.state).toBe('Ready')

    const got = await tickets.get('file-1')
    expect(got).toEqual(created)

    expect(
      (await tickets.listReady({ labels: ['autobuild'], state: 'Ready' })).map(
        (t) => t.ref.id,
      ),
    ).toEqual(['file-1'])

    expect(await tickets.claim('file-1')).toBe(true)
    expect((await tickets.get('file-1'))?.state).toBe('Doing')

    await tickets.transition('file-1', 'Done')
    expect((await tickets.get('file-1'))?.state).toBe('Done')

    await tickets.comment('file-1', 'Build started.')
    const after = await tickets.get('file-1')
    expect(after?.body).toContain('## Comment (2026-07-15T12:00:00.000Z)')
    expect(after?.body).toContain('Build started.')
  })

  // ── The state is the directory ─────────────────────────────────────────────

  test('create adopts an idempotency key across adapter restarts and state moves', async () => {
    const first = await source().create(
      { title: 'Harvested', body: SPEC_BODY },
      { state: 'Triage', idempotencyKey: 'harvest-cluster-1' },
    )
    expect(first.ref.id).toBe('file-1')
    await source().transition(first.ref.id, 'Done')

    const adopted = await source().create(
      { title: 'Changed retry prose', body: 'different' },
      { state: 'Triage', idempotencyKey: 'harvest-cluster-1' },
    )
    expect(adopted.ref.id).toBe('file-1')
    expect(adopted.state).toBe('Done')
    expect(await readdir(join(dir, 'triage'))).toEqual([])
    expect(await readFile(path('done', 'file-1'), 'utf8')).toContain(
      'idempotencyKey = "harvest-cluster-1"',
    )
  })

  test('create state override wins over the adapter default', async () => {
    const created = await source({ createState: 'Ready' }).create(
      { title: 'Harvested', body: SPEC_BODY },
      { state: 'Triage' },
    )
    expect(created.state).toBe('Triage')
    expect(await readdir(join(dir, 'triage'))).toContain('file-1.md')
  })

  test('create lands the ticket in triage/ (§12) and round-trips labels and body', async () => {
    const tickets = source()
    const created = await tickets.create({
      title: 'Proposal',
      body: 'evidence…',
      labels: ['ingest:sentry'],
    })

    expect(created.state).toBe('Triage')
    expect(await readdir(join(dir, 'triage'))).toEqual([`${created.ref.id}.md`])
    expect(await readdir(join(dir, 'ready'))).toEqual([])

    const got = await tickets.get(created.ref.id)
    expect(got?.labels).toEqual(['ingest:sentry'])
    expect(got?.body).toBe('evidence…')
  })

  test('a ticket moved into ready/ by hand is what listReady returns', async () => {
    await seedTicket('file-1', { state: 'ready' })
    await seedTicket('file-2', { state: 'triage' })

    // No label on either: `mv` into ready/ is sufficient — the headline claim.
    expect((await source().listReady({ state: 'Ready' })).map((t) => t.ref.id)).toEqual([
      'file-1',
    ])
  })

  test('transition moves the file and leaves the bytes identical', async () => {
    const seeded = await seedTicket('file-1', { state: 'ready', body: SPEC_BODY })
    const tickets = source()

    await tickets.transition('file-1', 'Done')

    expect(await readFile(path('done', 'file-1'), 'utf8')).toBe(seeded)
    expect(await readdir(join(dir, 'ready'))).toEqual([])
    expect((await tickets.get('file-1'))?.state).toBe('Done')
  })

  // Idempotency, not the early-return at file.ts:208. This test CANNOT
  // distinguish that guard from its absence: rename(2) on two paths resolving
  // to the same file is defined to "return successfully and perform no other
  // action", so ino/mtime/ctime are all untouched either way and there is
  // nothing to observe. Do not try to give it teeth via stat() — only a spy on
  // rename could tell the two apart, and that tests the implementation.
  //
  // What it does pin is a contract the dispatcher depends on for crash
  // resumption (§3.3): dispatcher.ts:378 transitions a merged ticket to Done
  // BEFORE appending build.completed. A crash between the two leaves the build
  // un-completed, so the next janitor tick re-enters that branch and transitions
  // an already-Done ticket again. If that threw, the janitor would wedge on the
  // build forever. Same shape for the bounce/abort paths to Triage.
  test('transition to the current state succeeds and leaves the ticket untouched', async () => {
    const seeded = await seedTicket('file-1', { state: 'ready', body: SPEC_BODY })
    const tickets = source()

    await tickets.transition('file-1', 'Ready')
    await tickets.transition('file-1', 'Ready') // retried after a crash

    expect((await tickets.get('file-1'))?.state).toBe('Ready')
    expect(await readFile(path('ready', 'file-1'), 'utf8')).toBe(seeded)
    expect(await readdir(join(dir, 'ready'))).toEqual(['file-1.md'])
  })

  test('transition on an unknown ticket throws', async () => {
    await expect(source().transition('nope', 'Done')).rejects.toThrow('unknown ticket')
  })

  test('state names are case-insensitive in, canonical out', async () => {
    await seedTicket('file-1', { state: 'triage' })
    const tickets = source()

    // `[tickets] readyState = "ready"` must mean the ready/ directory.
    await tickets.transition('file-1', 'ready')
    expect((await tickets.get('file-1'))?.state).toBe('Ready')
    expect((await tickets.listReady({ state: 'READY' })).map((t) => t.ref.id)).toEqual([
      'file-1',
    ])
  })

  test('an unknown state name is an error listing the four directories', async () => {
    await seedTicket('file-1')
    await expect(source().transition('file-1', 'Shipped')).rejects.toThrow(
      /unknown state "Shipped".*Triage, Ready, Doing, Done/s,
    )
    await expect(source().listReady({ state: 'Backlog' })).rejects.toThrow(
      'unknown state "Backlog"',
    )
  })

  // ── Claim ──────────────────────────────────────────────────────────────────

  test('claim moves ready/ → doing/ once; a second claim is false and listReady is empty', async () => {
    await seedTicket('file-1', { state: 'ready' })
    const tickets = source()

    expect(await tickets.claim('file-1')).toBe(true)
    // The relocation IS the claim record — the ticket visibly leaves ready/.
    expect(await readdir(join(dir, 'ready'))).toEqual([])
    expect(await readdir(join(dir, 'doing'))).toEqual(['file-1.md'])

    expect(await tickets.claim('file-1')).toBe(false)
    expect(await tickets.listReady({ state: 'Ready' })).toEqual([])
  })

  test('claim succeeds on a ticket in triage/ — readyState = "Triage" must not stall', async () => {
    // Regression guard, not an arbitrary edge case: claim refuses tickets
    // ALREADY in Doing/Done rather than requiring Ready. Tighten it back to
    // "must be Ready" and a legal `[tickets] readyState = "Triage"` silently
    // stalls forever — listReady yields triage/ tickets and every claim refuses.
    await seedTicket('file-1', { state: 'triage' })
    const tickets = source()

    expect(await tickets.claim('file-1')).toBe(true)
    expect(await readdir(join(dir, 'doing'))).toEqual(['file-1.md'])
  })

  test('claim is false for a ticket already in doing/ or done/, and for unknown ids', async () => {
    await seedTicket('file-1', { state: 'doing' })
    await seedTicket('file-2', { state: 'done' })
    const tickets = source()

    expect(await tickets.claim('file-1')).toBe(false)
    expect(await tickets.claim('file-2')).toBe(false)
    expect(await tickets.claim('nope')).toBe(false)
  })

  test('claim preserves the body', async () => {
    await seedTicket('file-1', { state: 'ready', body: SPEC_BODY })
    const tickets = source()

    await tickets.claim('file-1')
    expect((await tickets.get('file-1'))?.body).toBe(SPEC_BODY)
  })

  // ── Duplicates: the failure that would be silent double-dispatch ───────────

  test('the same id in two state dirs is an error naming both paths', async () => {
    await seedTicket('file-1', { state: 'ready' })
    await seedTicket('file-1', { state: 'triage' })
    const tickets = source()

    for (const op of [
      () => tickets.get('file-1'),
      () => tickets.listReady({ state: 'Ready' }),
      () => tickets.claim('file-1'),
    ]) {
      const rejects = expect(op()).rejects
      await rejects.toThrow(path('ready', 'file-1'))
      await rejects.toThrow(path('triage', 'file-1'))
      await rejects.toThrow('use mv, not cp')
    }
  })

  test('a .md at the tracker root is an error naming the path and the state dirs', async () => {
    await seedTicket('file-1', { state: 'ready' })
    await writeFile(join(dir, 'loose.md'), '+++\nid = "loose"\ntitle = "x"\n+++\nbody\n')

    await expect(source().listReady({})).rejects.toThrow(
      /loose\.md.*outside a state directory.*triage\/, ready\/, doing\/, done\//s,
    )
  })

  // ── Layout and the self-excluding .gitignore ───────────────────────────────

  test('selfIgnore writes <dir>/.gitignore = * and is idempotent', async () => {
    const tickets = source({ selfIgnore: true })

    await tickets.create({ title: 'A', body: 'a' })
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n')

    await tickets.create({ title: 'B', body: 'b' })
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
  })

  test('without selfIgnore no .gitignore is written — an explicit dir is the user’s', async () => {
    await source().create({ title: 'A', body: 'a' })
    expect(await readdir(dir)).not.toContain('.gitignore')
  })

  test('the four state dirs are created on first write', async () => {
    await source().create({ title: 'A', body: 'a' })
    expect((await readdir(dir)).sort()).toEqual(['doing', 'done', 'ready', 'triage'])
  })

  test('listReady on a tracker that does not exist yet returns []', async () => {
    const tickets = new FileTicketSource({ dir: join(dir, 'missing') })
    expect(await tickets.listReady({})).toEqual([])
  })

  // ── listReady filtering ────────────────────────────────────────────────────

  test('listReady requires every requested label and matches state', async () => {
    await seedTicket('file-1', { state: 'ready', labels: ['autobuild', 'bug'] })
    await seedTicket('file-2', { state: 'ready', labels: ['autobuild'] })
    await seedTicket('file-3', { state: 'triage', labels: ['autobuild', 'bug'] })
    const tickets = source()

    const ready = await tickets.listReady({ labels: ['autobuild', 'bug'], state: 'Ready' })
    expect(ready.map((t) => t.ref.id)).toEqual(['file-1'])
    expect(await tickets.listReady({})).toHaveLength(3)
  })

  // ── Comments ───────────────────────────────────────────────────────────────

  test('the spec in the body survives a comment append byte-exactly (§6.3, §13)', async () => {
    await seedTicket('file-1', { body: SPEC_BODY })
    const tickets = source()

    const before = await readFile(path('ready', 'file-1'), 'utf8')
    await tickets.comment('file-1', 'Spec imported as rev 0.')
    const after = await readFile(path('ready', 'file-1'), 'utf8')

    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(
      '\n## Comment (2026-07-15T12:00:00.000Z)\n\nSpec imported as rev 0.\n',
    )
    expect((await tickets.get('file-1'))?.body).toBe(
      `${SPEC_BODY}\n## Comment (2026-07-15T12:00:00.000Z)\n\nSpec imported as rev 0.\n`,
    )
  })

  test('two comments stack below the spec, each stamped by the injected clock', async () => {
    await seedTicket('file-1')
    const clock = manualClock('2026-07-15T12:00:00.000Z')
    const tickets = source({ clock })

    await tickets.comment('file-1', 'first')
    clock.advance(60_000)
    await tickets.comment('file-1', 'second')

    const body = (await tickets.get('file-1'))?.body ?? ''
    const firstAt = body.indexOf('## Comment (2026-07-15T12:00:00.000Z)')
    const secondAt = body.indexOf('## Comment (2026-07-15T12:01:00.000Z)')
    expect(firstAt).toBeGreaterThan(-1)
    expect(secondAt).toBeGreaterThan(firstAt)
    expect(body.startsWith(SPEC_BODY)).toBe(true)
  })

  test('a comment survives a later transition byte-exactly', async () => {
    await seedTicket('file-1', { state: 'ready' })
    const tickets = source()

    await tickets.comment('file-1', 'Build started.')
    const before = await readFile(path('ready', 'file-1'), 'utf8')
    await tickets.transition('file-1', 'Done')

    expect(await readFile(path('done', 'file-1'), 'utf8')).toBe(before)
  })

  test('comment on an unknown ticket throws', async () => {
    await expect(source().comment('nope', 'hi')).rejects.toThrow('unknown ticket')
  })

  // ── Frontmatter ────────────────────────────────────────────────────────────

  test('labels are optional: id + title alone parses', async () => {
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(path('ready', 'file-1'), '+++\nid = "file-1"\ntitle = "x"\n+++\nbody\n')

    const got = await source().get('file-1')
    expect(got?.labels).toEqual([])
    expect(got?.title).toBe('x')
  })

  test('create omits labels from the frontmatter when there are none', async () => {
    const created = await source().create({ title: 'A', body: 'a' })
    expect(await readFile(path('triage', created.ref.id), 'utf8')).not.toContain('labels')
  })

  test('a stray state key in frontmatter is an error naming the file', async () => {
    // Migration is out of scope (pre-release): an old flat-format file fails
    // loudly and names itself rather than being silently misread.
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(
      path('ready', 'file-1'),
      '+++\nid = "file-1"\ntitle = "x"\nstate = "Ready"\nlabels = [ ]\n+++\nbody\n',
    )
    await expect(source().get('file-1')).rejects.toThrow(path('ready', 'file-1'))
  })

  test('malformed TOML frontmatter throws an error naming the file', async () => {
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(path('ready', 'broken'), '+++\nid = broken oops\n+++\nbody\n')
    const tickets = source()

    await expect(tickets.get('broken')).rejects.toThrow(path('ready', 'broken'))
    await expect(tickets.listReady({})).rejects.toThrow(path('ready', 'broken'))
  })

  test('missing fences and missing required fields also name the file', async () => {
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(path('ready', 'no-fence'), '# just markdown\n')
    await expect(source().get('no-fence')).rejects.toThrow(path('ready', 'no-fence'))

    await writeFile(path('ready', 'missing-field'), '+++\nid = "missing-field"\n+++\nbody\n')
    await expect(source().get('missing-field')).rejects.toThrow(
      path('ready', 'missing-field'),
    )
  })

  test('a frontmatter id that disagrees with the filename is an error naming the file', async () => {
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(path('ready', 'file-1'), '+++\nid = "file-9"\ntitle = "x"\n+++\nbody\n')
    await expect(source().get('file-1')).rejects.toThrow(path('ready', 'file-1'))
  })

  // ── Ids ────────────────────────────────────────────────────────────────────

  test('create allocates the next free n across every state dir', async () => {
    await seedTicket('file-1', { state: 'done' })
    await seedTicket('file-3', { state: 'ready' })
    const tickets = source()

    // Gaps are reused, but an id taken in ANY state is taken.
    expect((await tickets.create({ title: 'A', body: 'a' })).ref.id).toBe('file-2')
    expect((await tickets.create({ title: 'B', body: 'b' })).ref.id).toBe('file-4')
  })

  test('ids that escape the ticket directory are rejected', async () => {
    await expect(source().get('../escape')).rejects.toThrow('invalid ticket id')
  })

  // ── Dependencies (§13) ─────────────────────────────────────────────────────

  test('blockedBy round-trips through TOML frontmatter', async () => {
    await seedTicket('file-1', { blockedBy: ['file-2', 'file-3'] })
    const tickets = source()

    expect((await tickets.get('file-1'))?.blockedBy).toEqual(['file-2', 'file-3'])
  })

  test('create records blockedBy in the frontmatter and reports it back', async () => {
    const tickets = source()

    const created = await tickets.create({
      title: 'Dependent',
      body: 'body',
      blockedBy: ['file-9'],
    })

    expect(created.blockedBy).toEqual(['file-9'])
    const written = await readFile(path('triage', created.ref.id), 'utf8')
    expect(written).toContain('blockedBy = [ "file-9" ]')
  })

  test('a ticket without blockedBy is valid and reports no dependencies', async () => {
    await seedTicket('file-1')
    const tickets = source()

    const ticket = await tickets.get('file-1')

    expect(ticket?.blockedBy).toBeUndefined()
    expect(await tickets.dependencyStates(['file-1'])).toEqual([
      { id: 'file-1', exists: true, resolved: false, blockedBy: [] },
    ])
  })

  /** The churn guard: a file that never declared blockers must not sprout
   * `blockedBy = []`, or every existing ticket rewrites. A transition is a
   * rename, so the content must arrive at the new state byte-identically —
   * this pins that the dependency field added no rewrite path of its own. */
  test('a file without blockedBy survives a transition byte-identically', async () => {
    const original = await seedTicket('file-1', { state: 'Ready', labels: ['autobuild'] })
    const tickets = source()

    await tickets.transition('file-1', 'Doing')
    const after = await readFile(path('doing', 'file-1'), 'utf8')

    expect(after).toBe(original)
    expect(after).not.toContain('blockedBy')
  })

  test('create without blockedBy writes no blockedBy key', async () => {
    const tickets = source()
    const created = await tickets.create({ title: 'Plain', body: 'body' })

    const written = await readFile(path('triage', created.ref.id), 'utf8')
    expect(written).not.toContain('blockedBy')
  })

  test('dependencyStates: only the done state resolves; every other state blocks', async () => {
    await seedTicket('file-1', { state: 'Done' })
    await seedTicket('file-2', { state: 'Ready' })
    await seedTicket('file-3', { state: 'Doing' })
    await seedTicket('file-4', { state: 'Triage' })
    const tickets = source()

    const states = await tickets.dependencyStates([
      'file-1',
      'file-2',
      'file-3',
      'file-4',
    ])

    expect(states.map((s) => s.resolved)).toEqual([true, false, false, false])
  })

  /** The done state is configurable, but only within the closed set of state
   * directories — `doneState` is canonicalized like every other state name,
   * so it can rename which directory means complete, never invent a fifth. */
  test('dependencyStates honors a custom doneState', async () => {
    await seedTicket('file-1', { state: 'Doing' })
    const tickets = source({ doneState: 'Doing' })

    expect((await tickets.dependencyStates(['file-1']))[0]?.resolved).toBe(true)
    // …and the default no longer resolves it.
    expect((await source().dependencyStates(['file-1']))[0]?.resolved).toBe(false)
  })

  test('an unknown doneState is a loud error, not a silently dead gate', async () => {
    expect(() => source({ doneState: 'Shipped' })).toThrow(/unknown state "Shipped"/)
  })

  test('dependencyStates covers every requested id, in request order', async () => {
    await seedTicket('file-2', { state: 'Done', blockedBy: ['file-7'] })
    const tickets = source()

    const states = await tickets.dependencyStates(['file-404', 'file-2'])

    expect(states).toEqual([
      { id: 'file-404', exists: false, resolved: false, blockedBy: [] },
      { id: 'file-2', exists: true, resolved: true, blockedBy: ['file-7'] },
    ])
  })

  /** A bad reference is a missing dependency, not a crashed tick. */
  test('dependencyStates reports an unusable id as missing rather than throwing', async () => {
    const tickets = source()

    expect(await tickets.dependencyStates(['../escape'])).toEqual([
      { id: '../escape', exists: false, resolved: false, blockedBy: [] },
    ])
  })

  /** …but a malformed file IS operator error about a real ticket: it throws,
   * and the dispatcher confines the damage to the ticket that referenced it. */
  test('dependencyStates throws on a malformed blocker file', async () => {
    await mkdir(join(dir, 'ready'), { recursive: true })
    await writeFile(path('ready', 'file-1'), '+++\nnot toml =\n+++\nbody\n')
    const tickets = source()

    await expect(tickets.dependencyStates(['file-1'])).rejects.toThrow(
      /file-1\.md: malformed TOML frontmatter/,
    )
  })
})

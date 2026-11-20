import { afterEach, expect, test as bunTest } from 'bun:test'
import { readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreWriteTooLargeError } from '../store/remote/errors'
import { humanActor } from '../events/envelope'
import { requestNodeRestack } from '../operator/restack'
import { reduceBuild } from '../kernel/reducer'
import {
  CONFIG_TOML,
  commitAll,
  git,
  happyHandlers,
  ofType,
  readyTicket,
  scenarioScope,
  writeFileIn,
} from './harness'

// Real git worktrees, subprocesses and kernel ticks: an explicit budget, as
// in integration-node-dispatch.
const test = scenarioScope({ test: bunTest, afterEach })

/** gen.txt is generated: one line joining every src/*.txt in name order, so
 * any two diverging generations conflict textually. */
const COMMAND = `printf '%s\\n' "$(cat src/*.txt | tr -d '\\n')" > gen.txt`
const generatedToml = (command: string) => `${CONFIG_TOML}
[[generated]]
paths = ["gen.txt"]
command = ${JSON.stringify(command)}
`
type Mode = 'generated' | 'mixed' | 'failing' | 'undeclared' | 'interrupted'
/** The declared command per mode: the real one, or one that fails after
 * writing an undeclared file, or one that succeeds but writes one. */
const DECLARED: Record<Mode, string> = {
  generated: COMMAND,
  mixed: COMMAND,
  failing: 'printf junk > junk.txt; exit 3',
  undeclared: `printf junk > junk.txt; ${COMMAND}`,
  interrupted: COMMAND,
}

async function generate(ws: string): Promise<string> {
  const names = (await readdir(join(ws, 'src'))).filter((name) => name.endsWith('.txt')).sort()
  let text = ''
  for (const name of names) text += (await readFile(join(ws, 'src', name), 'utf8')).trim()
  return `${text}\n`
}

/**
 * A node with two merged children. Each child adds its own src/<ticket>.txt
 * and regenerates gen.txt, so every replay of a child onto a moved root
 * conflicts in gen.txt. With `mixed`, the root also edits the first child's
 * hand-written file; `failing` and `undeclared` declare a broken command.
 */
async function nodeRestack(makeHarness: Parameters<Parameters<typeof test>[1]>[0], mode: Mode) {
  const mixed = mode === 'mixed'
  const broken = mode === 'failing' || mode === 'undeclared'
  const names = new Map<string, string>()
  const counter = join(tmpdir(), `ab-generated-runs-${crypto.randomUUID()}`)
  const reconciled: number[] = []
  const handlers = happyHandlers()
  const h = await makeHarness({
    localGitForge: true,
    configToml: generatedToml(`echo run >> ${counter}; ${DECLARED[mode]}`),
    handlers: {
      ...handlers,
      implement: async (cli) => {
        await cli.run(['context'])
        const name = names.get(cli.env.build)!
        await writeFileIn(cli.ws, `src/${name}.txt`, `${name}\n`)
        await writeFileIn(cli.ws, 'gen.txt', await generate(cli.ws))
        await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
        await commitAll(cli.ws, `implement ${name}`)
        const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', `Added ${name}.\n`)
        await cli.run(['done', '--notes', notes])
      },
      reconcile: async (cli) => {
        await cli.run(['context'])
        const manifest = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
        reconciled.push(manifest.nodeChange.index)
        expect(manifest.generated).toEqual([
          { command: `echo run >> ${counter}; ${DECLARED[mode]}`, files: ['gen.txt'] },
        ])
        const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'], cli.ws)).split('\n')
        if (broken) {
          // The agent sees the original conflict, never the failed attempt.
          expect(manifest.regeneration.reason).toContain(
            mode === 'failing' ? 'exited 3' : 'undeclared path(s): junk.txt',
          )
          expect(unmerged).toEqual(['gen.txt'])
          expect(await git(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], cli.ws)).toMatch(
            /^[0-9a-f]{40}$/,
          )
          expect(await git(['status', '--porcelain', '--', 'junk.txt'], cli.ws)).toBe('')
          expect(await git(['diff', '--cached', '--name-only'], cli.ws)).toContain(
            `src/C${manifest.nodeChange.index + 1}.txt`,
          )
        } else expect(manifest.regeneration).toBeUndefined()
        // Resolve the hand-written side, then rebuild the generated file
        // with its declared command, never by hand.
        for (const file of unmerged.filter((path) => path !== 'gen.txt')) {
          await writeFileIn(cli.ws, file, 'merged\n')
          await git(['add', file], cli.ws)
        }
        await git(['checkout', '--ours', '--', 'gen.txt'], cli.ws)
        await Bun.$`sh -c ${COMMAND}`.cwd(cli.ws).quiet()
        await git(['add', 'gen.txt'], cli.ws)
        await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
        await writeFileIn(cli.ws, '.ab/reconcile-notes.md', 'Merged and regenerated.\n')
        await cli.run(['done', '--notes', join(cli.ws, '.ab/reconcile-notes.md')])
      },
    },
    tickets: [
      { ...readyTicket('NODE', { title: 'Node owner' }), kind: 'node' },
      {
        ...readyTicket('OPEN', { title: 'Keep node collecting' }),
        state: 'Backlog',
        target: 'NODE',
      },
    ],
  })
  const child = async (id: string) => {
    h.tickets.add({ ...readyTicket(id, { title: `Child ${id}` }), target: 'NODE' })
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.dispatcher.drainProvisioning()
    const record = (await h.store.listBuilds()).find((r) => r.ticket?.id === id)!
    names.set(record.slug, id)
    await h.runLatest()
    const state = reduceBuild(await h.events(record.slug))
    await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, state.pr!.headSha, {
      buildSlug: record.slug,
    })
    await h.dispatcher.tick()
    return record
  }
  try {
    await h.dispatcher.tick()
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const owner = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
    await child('C1')
    await child('C2')
    expect(await git(['show', `${owner.branch}:gen.txt`], h.origin)).toBe('C1C2')

    await writeFileIn(h.origin, 'src/R.txt', 'R\n')
    await writeFileIn(h.origin, 'gen.txt', 'R\n')
    if (mixed) await writeFileIn(h.origin, 'src/C1.txt', 'root\n')
    await commitAll(h.origin, 'Root moves generated and hand-written files')
    if (mode === 'interrupted') {
      // The process stops between the resolved fact and the item's receipt.
      const append = h.store.append.bind(h.store)
      let interrupt = true
      h.store.append = (async (slug, write) => {
        if (interrupt && write.type === 'node.item-replayed' && write.actor.kind === 'kernel') {
          interrupt = false
          throw new StoreWriteTooLargeError('POST', `/builds/${slug}/events`, 1, 'interrupted')
        }
        return append(slug, write)
      }) as typeof h.store.append
    }
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: owner.slug, user: 'operator' })
    let runs = h.launched.length
    for (let i = 0; i < 12; i++) {
      const settled = ofType(await h.events(owner.slug), 'node.writer-settled').at(-1)
      if (settled?.payload.outcome === 'completed') break
      const open = reduceBuild(await h.events(owner.slug)).openEscalations[0]
      if (mode === 'interrupted' && open !== undefined)
        await h.store.append(owner.slug, {
          actor: humanActor('operator'),
          type: 'escalation.answered',
          payload: { id: open.id, answer: 'retry', resolution: 'retry' },
        })
      h.clock.advance(30_000)
      await h.dispatcher.tick()
      await h.dispatcher.drainProvisioning()
      if (h.launched.length > runs && h.launched.at(-1)?.slug === owner.slug) {
        runs = h.launched.length
        await h.runLatest()
      }
    }
    const events = await h.events(owner.slug)
    expect(ofType(events, 'node.writer-settled').at(-1)?.payload.outcome).toBe('completed')
    const regenerations = ofType(events, 'node.item-regenerated').map((event) => event.payload)
    const sessions = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'reconcile',
    )
    // Child edits that applied cleanly survive in the node head.
    const head = owner.branch!
    if (mixed) {
      expect(regenerations.map((r) => [r.index, r.outcome])).toEqual([
        [0, 'skipped'],
        [1, 'resolved'],
      ])
      expect(reconciled).toEqual([0])
      expect(sessions).toHaveLength(1)
      expect(await git(['show', `${head}:src/C1.txt`], h.origin)).toBe('merged')
      expect(await git(['show', `${head}:gen.txt`], h.origin)).toBe('mergedC2R')
    } else if (broken) {
      expect(regenerations.map((r) => [r.index, r.outcome])).toEqual([
        [0, 'failed'],
        [1, 'failed'],
      ])
      expect(ofType(events, 'escalation.raised')).toHaveLength(0)
      expect(reconciled).toEqual([0, 1])
      expect(sessions).toHaveLength(2)
      expect(await git(['show', `${head}:src/C1.txt`], h.origin)).toBe('C1')
      expect(await git(['show', `${head}:gen.txt`], h.origin)).toBe('C1C2R')
    } else {
      expect(regenerations.map((r) => [r.index, r.outcome])).toEqual([
        [0, 'resolved'],
        [1, 'resolved'],
      ])
      // An interrupted item's receipt names exactly its retained regenerated head.
      const receipts = ofType(events, 'node.item-replayed')
      for (const regeneration of regenerations)
        expect(
          receipts.filter(
            (receipt) =>
              receipt.payload.id === regeneration.id &&
              receipt.payload.index === regeneration.index,
          )[0]?.payload.head,
        ).toBe(regeneration.head)
      expect(reconciled).toEqual([])
      expect(sessions).toHaveLength(0)
      expect(ofType(events, 'reconcile.started')).toHaveLength(0)
      expect(await git(['show', `${head}:src/C1.txt`], h.origin)).toBe('C1')
      expect(await git(['show', `${head}:gen.txt`], h.origin)).toBe('C1C2R')
    }
    expect(await git(['show', `${head}:src/C2.txt`], h.origin)).toBe('C2')
    const commandRuns = (await readFile(counter, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
    expect(commandRuns).toHaveLength(broken || !mixed ? 2 : 1)
    await rm(counter, { force: true })
    expect(reduceBuild(events).nodeRestack?.regenerated).toEqual(
      broken ? undefined : mixed ? [1] : [0, 1],
    )
  } finally {
    await h.cleanup()
  }
}

test(
  'a node restack whose items conflict only in a generated file completes with no reconcile session',
  (makeHarness) => nodeRestack(makeHarness, 'generated'),
  60_000,
)

test(
  'a mixed conflict gets one agent session and the next generated-only item is regenerated',
  (makeHarness) => nodeRestack(makeHarness, 'mixed'),
  60_000,
)

test(
  'a node item whose resolved regeneration lost its receipt is adopted without rerunning',
  (makeHarness) => nodeRestack(makeHarness, 'interrupted'),
  60_000,
)

for (const mode of ['failing', 'undeclared'] as const)
  test(
    `a ${mode} regeneration command falls back to one agent session per item on the original conflict`,
    (makeHarness) => nodeRestack(makeHarness, mode),
    60_000,
  )

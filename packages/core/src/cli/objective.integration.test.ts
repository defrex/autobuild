/** `ab objective` and `ab ticket show` over a local store (SPEC §13.1.1). */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPATCHER } from '../events/envelope'
import { commandObjective } from '../kernel/generators/optimization-log'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket } from '../ports/types'
import { openLocalStore } from '../store/local/store'
import { runCli } from './main'
import { abTicketShow } from './ticket'

let tmp: string
let storeRef: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-objective-'))
  storeRef = join(tmp, 'store')
  await writeFile(
    join(tmp, 'autobuild.toml'),
    '[tickets]\nsource = "file"\nreadyState = "ready"\nrejectedState = "rejected"\n',
  )
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const BLOCK = [
  '```autobuild-objective',
  'purpose = "p95 latency of the catalog search query"',
  '[metric]',
  'kind = "command"',
  'command = "bun bench/search.ts"',
  'direction = "minimize"',
  'samples = 7',
  'harness = ["bench/search/**"]',
  '[target]',
  'threshold = 40',
  'epsilon = { relative = 0.03 }',
  '[budget]',
  'maxAttempts = 60',
  'maxHours = 24',
  '[stop]',
  'plateau = { attempts = 12 }',
  '[proposer]',
  'concurrency = 4',
  '```',
].join('\n')

async function seed(opts: { optimization: boolean; slug?: string; terminal?: boolean }) {
  const slug = opts.slug ?? 'opt-node'
  const local = openLocalStore(storeRef)
  await local.createBuild({
    slug,
    repo: tmp,
    branch: `ab-node/${slug}`,
    ticket: { source: 'fake', id: 'OPT-1' },
  })
  await local.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: tmp,
      ticket: { source: 'fake', id: 'OPT-1' },
      baseBranch: 'main',
      kind: 'node',
    },
  })
  if (opts.optimization)
    await local.append(slug, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: {
        objective: commandObjective({ stop: { plateau: { attempts: 12 }, mode: 'abort' } }),
        revision: 1,
        harnessPin: 'a'.repeat(40),
        specRev: 0,
      },
    })
  await local.append(slug, {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'a'.repeat(40) },
  })
  if (opts.terminal)
    await local.append(slug, { actor: DISPATCHER, type: 'build.aborted', payload: {} })
  await local.close()
  return slug
}

function deps(env: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  return {
    workspacePath: tmp,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    exec: async () => ({ stdout: '', stderr: 'not a git repo', exitCode: 128 }),
    processEnv: { AB_STORE: storeRef, USER: 'cli-op', ...env },
    out,
    err,
  }
}

test('ab objective shows the effective objective and progress', async () => {
  const slug = await seed({ optimization: true })
  const d = deps()
  expect(await runCli(['objective', slug], d)).toBe(0)
  expect(d.err).toEqual([])
  const text = d.out.join('\n')
  expect(text).toContain(`optimization node ${slug} — objective revision 1`)
  expect(text).toContain('  threshold: 40')
  expect(text).toContain('  attempts: 0 filed, 0 accepted, 0 rejected, 0 running')
  expect(text).toContain('  starting: not measured')
  expect(text).not.toContain('(revised)')
})

test('ab objective flags record one revision, leave running attempts alone and mark revised fields', async () => {
  const slug = await seed({ optimization: true })
  const d = deps()
  expect(
    await runCli(
      [
        'objective',
        slug,
        '--threshold',
        '35',
        '--epsilon',
        '3%',
        '--plateau',
        '8',
        '--stop-mode',
        'drain',
        '--json',
      ],
      d,
    ),
  ).toBe(0)
  const view = JSON.parse(d.out.join('\n'))
  expect(view).toMatchObject({
    slug,
    revision: 2,
    revisedFields: ['threshold', 'epsilon', 'plateau', 'stopMode'],
    objective: { target: { threshold: 35, epsilon: { relative: 0.03 } }, stop: { mode: 'drain' } },
    progress: { attempts: { running: 0, filed: 0 } },
  })
  const local = openLocalStore(storeRef)
  const last = (await local.getEvents(slug)).at(-1)!
  await local.close()
  expect(last).toMatchObject({
    type: 'optimization.objective-revised',
    actor: { kind: 'human', user: 'cli-op' },
    payload: {
      revision: 2,
      changes: { threshold: 35, epsilon: { relative: 0.03 }, plateau: 8, stopMode: 'drain' },
    },
  })
  const shown = deps()
  expect(await runCli(['objective', slug], shown)).toBe(0)
  expect(shown.out.join('\n')).toContain('  threshold: 35 (revised)')
})

test('ab objective refuses plain nodes, invalid values, terminal nodes and its own phase session', async () => {
  const plain = await seed({ optimization: false, slug: 'plain-node' })
  const d = deps()
  expect(await runCli(['objective', plain], d)).toBe(1)
  expect(d.err.join('\n')).toContain('not an optimization node')

  const slug = await seed({ optimization: true })
  const invalid = deps()
  expect(await runCli(['objective', slug, '--plateau', '0'], invalid)).toBe(1)
  expect(invalid.err.join('\n')).toContain('plateau')
  const unknownMode = deps()
  expect(await runCli(['objective', slug, '--stop-mode', 'pause'], unknownMode)).toBe(1)

  const own = deps({ AB_SESSION: 'phase', AB_BUILD: slug })
  expect(await runCli(['objective', slug, '--threshold', '1'], own)).toBe(1)
  expect(own.err.join('\n')).toContain('own phase session')

  const ended = await seed({ optimization: true, slug: 'ended-node', terminal: true })
  const terminal = deps()
  expect(await runCli(['objective', ended, '--threshold', '1'], terminal)).toBe(1)
  expect(terminal.err.join('\n')).toContain('terminal')

  const local = openLocalStore(storeRef)
  expect((await local.getEvents(slug)).map((event) => event.type)).not.toContain(
    'optimization.objective-revised',
  )
  await local.close()
})

test('ab ticket show prints the effective objective and marks fields revised since the ticket block', async () => {
  const slug = await seed({ optimization: true })
  expect(await runCli(['objective', slug, '--threshold', '35'], deps())).toBe(0)
  const ticket: Ticket = {
    revision: 'fixture',
    ref: { source: 'fake', id: 'OPT-1' },
    title: 'Faster search',
    body: `## What and why\n\nFaster.\n\n${BLOCK}\n`,
    state: 'Ready',
    resolved: false,
    labels: [],
    kind: 'node',
  }
  for (const json of [false, true]) {
    const out: string[] = []
    await abTicketShow({
      targetRepo: tmp,
      id: 'OPT-1',
      env: { AB_STORE: storeRef },
      exec: async () => ({ stdout: '', stderr: 'not a git repo', exitCode: 128 }),
      json,
      stdout: (line) => out.push(line),
      sourceFactory: () => new FakeTicketSource([ticket]),
    })
    if (json)
      expect(JSON.parse(out[0]!).objective).toMatchObject({
        revision: 2,
        revised: ['threshold'],
        effective: { target: { threshold: 35 } },
      })
    else {
      const text = out.join('\n')
      expect(text).toContain(`Objective (effective, revision 2, node ${slug}):`)
      expect(text).toContain('  threshold: 35 (revised)')
      expect(text).toContain('  max attempts: 60')
      expect(text).not.toContain('max attempts: 60 (revised)')
    }
  }
})

import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { validateEventWrite, type AbEvent, type EventWrite } from '../events/catalog'
import { eventPayloadSchemas } from '../events/payloads'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { sampleBuildInput } from '../store/contract'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { checkIncremental } from './incremental-contract'
import {
  candidateHeadPaths,
  computeChangedPaths,
  computeResolutionPaths,
  foldHeadPaths,
  HEAD_PATHS_PREVIEW,
  HEAD_PATHS_RECORDS,
  headPathsFor,
  HeadPathsReadError,
  headPathsWrite,
  mechanicalTree,
  parseNulChangedPaths,
  readHeadPaths,
  recordHeadPaths,
  type HeadPathsPayload,
  type HeadPathsSummary,
} from './head-paths'
import { buildReducer, reduceBuild, type BuildState } from './reducer'

const sha = (c: string) => c.repeat(40)
const HEAD = sha('a')
const DEST = sha('b')
const BASE = sha('c')
const TREE = sha('d')

/** Worktree housekeeping succeeds unless a test scripts otherwise. */
const always: Array<[RegExp, Partial<ExecResult>]> = [
  [/^git worktree (add|remove|prune)/, {}],
  [/^git add -A$/, {}],
]

/** A scripted git: the first matching rule answers; every argv is recorded. */
function fakeExec(rules: Array<[RegExp, Partial<ExecResult> | (() => Partial<ExecResult>)]>) {
  const calls: Array<{ argv: string; cwd?: string }> = []
  const exec: Exec = async (cmd, opts) => {
    const argv = cmd.join(' ')
    calls.push({ argv, cwd: opts.cwd })
    for (const [pattern, result] of [...rules, ...always])
      if (pattern.test(argv)) {
        const r = typeof result === 'function' ? result() : result
        return { stdout: '', stderr: '', exitCode: 0, ...r }
      }
    return { stdout: '', stderr: `unscripted: ${argv}`, exitCode: 128 }
  }
  return { exec, calls }
}

function payload(over: Partial<HeadPathsPayload> = {}): HeadPathsPayload {
  return {
    source: 'finalize',
    head: HEAD,
    destination: DEST,
    mergeBase: BASE,
    total: 2,
    preview: ['a.ts', 'b.ts'],
    artifact: { kind: 'head-paths', rev: 0 },
    ...over,
  }
}

describe('head.paths-recorded payload', () => {
  const schema = eventPayloadSchemas['head.paths-recorded']
  test('accepts a bounded sorted summary, including recorded-empty', () => {
    expect(schema.safeParse(payload()).success).toBe(true)
    expect(schema.safeParse(payload({ total: 0, preview: [] })).success).toBe(true)
    const many = Array.from(
      { length: HEAD_PATHS_PREVIEW },
      (_, i) => `f${String(i).padStart(4, '0')}`,
    )
    expect(schema.safeParse(payload({ total: 1500, preview: many })).success).toBe(true)
    expect(schema.safeParse(payload({ resolution: { total: 1, preview: ['a.ts'] } })).success).toBe(
      true,
    )
  })
  test('rejects unsorted, duplicate, oversized and miscounted previews', () => {
    expect(schema.safeParse(payload({ preview: ['b.ts', 'a.ts'] })).success).toBe(false)
    expect(schema.safeParse(payload({ preview: ['a.ts', 'a.ts'] })).success).toBe(false)
    expect(schema.safeParse(payload({ total: 3 })).success).toBe(false)
    const over = Array.from({ length: HEAD_PATHS_PREVIEW + 1 }, (_, i) => `f${i}`).sort()
    expect(schema.safeParse(payload({ total: over.length, preview: over })).success).toBe(false)
    expect(schema.safeParse(payload({ resolution: { total: 2, preview: ['a.ts'] } })).success).toBe(
      false,
    )
    expect(schema.safeParse(payload({ artifact: { kind: 'plan', rev: 0 } as never })).success).toBe(
      false,
    )
  })
})

describe('changed paths', () => {
  test('diffs the head against its merge base, without renames, sorted and unique', async () => {
    const { exec, calls } = fakeExec([
      [/cat-file -e/, {}],
      [/merge-base/, { stdout: `${BASE}\n` }],
      [/diff --no-renames/, { stdout: 'z.ts\0new.ts\0old.ts\0z.ts\0' }],
    ])
    const result = await computeChangedPaths(exec, '/repo', { head: HEAD, destination: DEST })
    expect(result).toEqual({ mergeBase: BASE, paths: ['new.ts', 'old.ts', 'z.ts'] })
    expect(calls.map((c) => c.argv)).toEqual([
      `git cat-file -e ${HEAD}^{commit}`,
      `git cat-file -e ${DEST}^{commit}`,
      `git merge-base ${DEST} ${HEAD}`,
      `git diff --no-renames --name-only -z ${BASE} ${HEAD} --`,
    ])
    expect(calls.every((c) => c.cwd === '/repo')).toBe(true)
  })
  test('no merge base fails closed', async () => {
    const { exec } = fakeExec([
      [/cat-file -e/, {}],
      [/merge-base/, { exitCode: 1 }],
    ])
    await expect(
      computeChangedPaths(exec, '/repo', { head: HEAD, destination: DEST }),
    ).rejects.toThrow('no merge base')
  })
  test('NUL parsing preserves whitespace and newlines and fails closed', () => {
    expect(parseNulChangedPaths('old name.ts\0new\nname.ts\0')).toEqual([
      'old name.ts',
      'new\nname.ts',
    ])
    expect(parseNulChangedPaths('')).toEqual([])
    expect(() => parseNulChangedPaths('a.ts\n')).toThrow('non-NUL-terminated')
    expect(() => parseNulChangedPaths('a.ts\0\0')).toThrow('empty path entry')
  })
})

describe('mechanical tree', () => {
  const item = { change: sha('e'), parent: sha('f'), onto: DEST }
  test('merge-tree with an explicit merge base, clean or conflicted', async () => {
    for (const exitCode of [0, 1]) {
      const { exec, calls } = fakeExec([
        [/rev-parse --verify/, { stdout: `${item.parent}\n` }],
        [/merge-tree/, { exitCode, stdout: `${TREE}\n100644 x 1\ta.ts\n` }],
      ])
      expect(await mechanicalTree(exec, '/repo', item)).toBe(TREE)
      expect(calls[1]!.argv).toBe(
        `git merge-tree --write-tree --no-messages --merge-base=${item.parent} ${DEST} ${item.change}`,
      )
    }
  })
  test('other merge-tree failures throw', async () => {
    const { exec } = fakeExec([
      [/rev-parse --verify/, { stdout: `${item.parent}\n` }],
      [/merge-tree/, { exitCode: 128, stderr: 'fatal: bad object' }],
    ])
    await expect(mechanicalTree(exec, '/repo', item)).rejects.toThrow('bad object')
  })
  test('older git replays exactly in a temporary detached worktree', async () => {
    const { exec, calls } = fakeExec([
      [/rev-parse --verify/, { stdout: `${item.parent}\n` }],
      [/merge-tree/, { exitCode: 129, stderr: "error: unknown option `merge-base'" }],
      [/cherry-pick/, { exitCode: 1, stderr: 'CONFLICT' }],
      [/diff --name-only --diff-filter=U/, { stdout: 'a.ts\0' }],
      [/write-tree/, { stdout: `${TREE}\n` }],
    ])
    expect(await mechanicalTree(exec, '/repo', { ...item, mainline: 1 })).toBe(TREE)
    const argv = calls.map((c) => c.argv)
    const add = argv.find((a) => a.startsWith('git worktree add'))!
    const path = add.split(' ')[4]!
    expect(add).toBe(`git worktree add --detach ${path} ${DEST}`)
    expect(path).not.toStartWith('/repo')
    expect(argv.slice(2)).toEqual([
      add,
      `git -c core.hooksPath=/dev/null -c rerere.enabled=false cherry-pick --no-commit -m 1 ${item.change}`,
      'git diff --name-only --diff-filter=U -z',
      'git add -A',
      'git write-tree',
      `git worktree remove --force ${path}`,
      'git worktree prune',
    ])
    expect(calls.filter((c) => c.cwd === path).map((c) => c.argv)).toHaveLength(4)
  })
  test('the fallback cleans up when the replay fails', async () => {
    const { exec, calls } = fakeExec([
      [/rev-parse --verify/, { stdout: `${item.parent}\n` }],
      [/cherry-pick/, { exitCode: 128, stderr: 'fatal: bad revision' }],
      [/diff --name-only --diff-filter=U/, { stdout: '' }],
    ])
    await expect(mechanicalTree(exec, '/repo', item, { mergeBaseOption: false })).rejects.toThrow(
      'bad revision',
    )
    const argv = calls.map((c) => c.argv)
    expect(argv.some((a) => a.includes('merge-tree'))).toBe(false)
    expect(argv.at(-2)).toStartWith('git worktree remove --force ')
    expect(argv.at(-1)).toBe('git worktree prune')
  })
  test('resolution is the union of each head against its mechanical tree', async () => {
    const { exec } = fakeExec([
      [/rev-parse --verify/, { stdout: `${item.parent}\n` }],
      [/merge-tree/, { stdout: `${TREE}\n` }],
      [new RegExp(`diff --no-renames --name-only -z ${TREE} ${sha('1')}`), { stdout: 'c\0a\0' }],
      [new RegExp(`diff --no-renames --name-only -z ${TREE} ${sha('2')}`), { stdout: 'b\0a\0' }],
    ])
    expect(
      await computeResolutionPaths(exec, '/repo', [
        { ...item, head: sha('1') },
        { ...item, head: sha('2') },
      ]),
    ).toEqual(['a', 'b', 'c'])
    expect(await computeResolutionPaths(exec, '/repo', [])).toEqual([])
  })
})

function summary(head: string, seq: number, over: Partial<HeadPathsPayload> = {}) {
  return { ...payload({ head, ...over }), seq } satisfies HeadPathsSummary
}

describe('selectors and fold', () => {
  const leaf = (headPaths?: HeadPathsSummary[], pr?: string) =>
    ({
      kind: 'work',
      pr: pr === undefined ? undefined : { number: 1, url: 'u', headSha: pr },
      ...(headPaths ? { headPaths } : {}),
    }) as Pick<BuildState, 'kind' | 'integration' | 'pr' | 'headPaths'>
  test('leaf candidate head: none, not recorded, recorded, recorded-empty, stale', () => {
    expect(candidateHeadPaths(leaf([summary(HEAD, 1)]))).toEqual({ recorded: false })
    expect(candidateHeadPaths(leaf(undefined, HEAD))).toEqual({ recorded: false })
    expect(candidateHeadPaths(leaf([summary(HEAD, 1)], HEAD))).toEqual({
      recorded: true,
      record: summary(HEAD, 1),
    })
    const empty = summary(HEAD, 2, { total: 0, preview: [] })
    expect(candidateHeadPaths(leaf([empty], HEAD))).toEqual({ recorded: true, record: empty })
    expect(candidateHeadPaths(leaf([summary(sha('9'), 1)], HEAD))).toEqual({ recorded: false })
  })
  test('node candidate head is the integration cycle head, not the PR head', () => {
    const state = {
      kind: 'node',
      pr: { number: 1, url: 'u', headSha: sha('9') },
      integration: { cycle: { head: HEAD } },
      headPaths: [summary(HEAD, 1, { source: 'integration' })],
    } as unknown as BuildState
    expect(candidateHeadPaths(state).recorded).toBe(true)
    expect(candidateHeadPaths({ ...state, integration: {} } as BuildState)).toEqual({
      recorded: false,
    })
  })
  test('first summary per head wins and only the newest records are kept', () => {
    let records: HeadPathsSummary[] | undefined
    records = foldHeadPaths(records, payload({ total: 1, preview: ['x'] }), 1)
    records = foldHeadPaths(records, payload(), 2)
    expect(records).toEqual([summary(HEAD, 1, { total: 1, preview: ['x'] })])
    for (let i = 0; i < HEAD_PATHS_RECORDS + 2; i++)
      records = foldHeadPaths(records, payload({ head: sha(String(i)) }), 10 + i)
    expect(records).toHaveLength(HEAD_PATHS_RECORDS)
    expect(records!.at(-1)!.head).toBe(sha(String(HEAD_PATHS_RECORDS + 1)))
  })
})

describe('build reducer', () => {
  function log(writes: EventWrite[]): AbEvent[] {
    return writes.map(
      (write, index) =>
        ({
          build: 'b',
          seq: index + 1,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          ...validateEventWrite(write),
        }) as AbEvent,
    )
  }
  const created: EventWrite = {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'linear', id: 'ENG-1', title: 't' },
      repo: 'o/r',
      baseBranch: 'main',
    },
  }
  const recorded = (head: string, over: Partial<HeadPathsPayload> = {}): EventWrite => ({
    actor: KERNEL,
    type: 'head.paths-recorded',
    payload: payload({ head, ...over }),
  })
  test('a pre-change log reads as not recorded', () => {
    const state = reduceBuild(log([created]))
    expect(state.headPaths).toBeUndefined()
    expect(headPathsFor(state, HEAD)).toEqual({ recorded: false })
  })
  test('folds bounded summaries, first per head, incrementally', () => {
    const events = log([
      created,
      recorded(HEAD, { resolution: { total: 0, preview: [] } }),
      recorded(HEAD, { total: 1, preview: ['other'] }),
      ...Array.from({ length: HEAD_PATHS_RECORDS }, (_, i) => recorded(sha(String(i)))),
    ])
    checkIncremental(buildReducer, events, { stepwise: false })
    const state = reduceBuild(events)
    expect(state.headPaths).toHaveLength(HEAD_PATHS_RECORDS)
    expect(headPathsFor(state, HEAD)).toEqual({ recorded: false })
    const first = reduceBuild(events.slice(0, 3))
    expect(headPathsFor(first, HEAD)).toEqual({
      recorded: true,
      record: summary(HEAD, 2, { resolution: { total: 0, preview: [] } }),
    })
  })
})

describe('recording and reading', () => {
  const deps = (store: MemoryBuildStore, exec: Exec) => ({
    store,
    slug: 'b',
    exec,
    workspacePath: '/ws',
    actor: KERNEL,
  })
  async function seeded() {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('b'))
    return store
  }
  const paths = Array.from({ length: 1500 }, (_, i) => `src/f${String(i).padStart(5, '0')}.ts`)
  const scripted = () =>
    fakeExec([
      [/cat-file -e/, {}],
      [/merge-base/, { stdout: `${BASE}\n` }],
      [/diff --no-renames/, { stdout: `${[...paths].reverse().join('\0')}\0` }],
    ])

  test('records once per head and reads the complete set back', async () => {
    const store = await seeded()
    const { exec, calls } = scripted()
    const first = await recordHeadPaths(deps(store, exec), {
      source: 'restack',
      head: HEAD,
      destination: DEST,
    })
    expect(first?.recorded).toBe('appended')
    const state = (await readBuildFacts(store, 'b')).value.state
    const record = headPathsFor(state, HEAD)
    if (!record.recorded) throw new Error('expected a record')
    expect(record.record.total).toBe(1500)
    expect(record.record.preview).toEqual(paths.slice(0, HEAD_PATHS_PREVIEW))
    expect(await readHeadPaths(store, 'b', record.record)).toEqual({ paths })

    const before = calls.length
    const again = await recordHeadPaths(deps(store, exec), {
      source: 'restack',
      head: HEAD,
      destination: DEST,
      state,
    })
    expect(again?.recorded).toBe('existing')
    expect(calls.length).toBe(before)
    expect(
      (await store.getEvents('b')).filter((e) => e.type === 'head.paths-recorded'),
    ).toHaveLength(1)
  })

  test('a stale conditional deposit returns null without writing', async () => {
    const store = await seeded()
    const { exec } = scripted()
    const result = await recordHeadPaths(deps(store, exec), {
      source: 'node-rewrite',
      head: HEAD,
      destination: DEST,
      state: {},
      expectedSeq: 5,
    })
    expect(result).toBeNull()
    expect(await store.listArtifacts('b', 'head-paths')).toEqual([])
  })

  test('a mismatched or missing artifact is a typed error', async () => {
    const store = await seeded()
    const facts = {
      version: 1 as const,
      head: HEAD,
      destination: DEST,
      mergeBase: BASE,
      paths: ['a', 'b'],
    }
    const { artifacts, makeEvent } = headPathsWrite(facts, 'finalize', KERNEL)
    const { event } = await store.appendWithArtifacts('b', artifacts, makeEvent)
    const record = { ...event.payload, seq: event.seq }
    expect(await readHeadPaths(store, 'b', record)).toEqual({ paths: ['a', 'b'] })
    await expect(readHeadPaths(store, 'b', { ...record, total: 3 })).rejects.toBeInstanceOf(
      HeadPathsReadError,
    )
    await expect(
      readHeadPaths(store, 'b', { ...record, resolution: { total: 0, preview: [] } }),
    ).rejects.toBeInstanceOf(HeadPathsReadError)
    await expect(
      readHeadPaths(store, 'b', { ...record, artifact: { kind: 'head-paths', rev: 7 } }),
    ).rejects.toThrow('missing')
  })
})

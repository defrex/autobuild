import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { scopeLocalStoreToJudgeSession } from '../store/phase-session'
import type { BuildStore } from '../store/types'
import { temporaryDirectories } from '../testing/temp-directories'
import type { JudgeCliEnv } from './env'
import { runCli } from './main'

const directory = temporaryDirectories(afterEach)
const BUILD = 'b-judge'
const PANEL = 'panel-1'
const SESSION = 's_judge'
const CANDIDATE = 'c'.repeat(40)
const BASELINE = 'b'.repeat(40)
const PIN = 'a'.repeat(40)

const env: JudgeCliEnv = {
  store: '/store',
  build: BUILD,
  panel: PANEL,
  judge: 1,
  session: SESSION,
  contextDir: '.ab/judge',
}

/** A judge root as the runner leaves it: two variants and a brief. */
async function judgeRoot(): Promise<string> {
  const root = await directory(join(tmpdir(), 'ab-judge-cli-'))
  for (const label of ['A', 'B']) {
    await mkdir(join(root, label, 'evals'), { recursive: true })
    await writeFile(join(root, label, 'evals', 'rubric.md'), '# Rubric\nPrefer clarity.\n')
    await writeFile(join(root, label, 'doc.md'), `${label} prose\n`)
  }
  await mkdir(join(root, '.ab', 'judge'), { recursive: true })
  await writeFile(
    join(root, '.ab', 'judge', 'brief.json'),
    JSON.stringify({ judge: 1, purpose: 'clearer onboarding prose', rubric: 'evals/rubric.md' }),
  )
  return root
}

async function judging(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: BUILD, repo: 'repo', branch: `ab/${BUILD}` })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'panel.started',
    payload: {
      panel: PANEL,
      candidate: CANDIDATE,
      baseline: BASELINE,
      harnessPin: PIN,
      purpose: 'clearer onboarding prose',
      rubric: 'evals/rubric.md',
      harness: ['evals/**'],
      judges: 1,
    },
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'panel.judge-started',
    payload: { panel: PANEL, judge: 1, session: SESSION, order: 'baseline-first', runner: 'x' },
  })
  return store
}

/** A store whose every member throws: proof that a command touched nothing. */
function untouchable(): BuildStore {
  return new Proxy({} as BuildStore, {
    get(_target, property) {
      if (property === 'then') return undefined
      return () => {
        throw new Error(`store.${String(property)} was called`)
      }
    },
  })
}

async function cli(argv: string[], workspacePath: string, store: BuildStore) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, {
    workspacePath,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    store,
    judgeEnv: env,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('ab judge', () => {
  test('context materializes from the brief and makes no store call', async () => {
    const root = await judgeRoot()
    const result = await cli(['judge', 'context', '--json'], root, untouchable())
    expect(result.code).toBe(0)
    const manifest = JSON.parse(result.out)
    expect(manifest).toEqual({
      judge: 1,
      variants: { A: 'A', B: 'B' },
      purpose: 'purpose.md',
      rubric: 'rubric.md',
      allowedTerminals: ['prefer'],
    })
    const dir = join(root, '.ab', 'judge')
    expect(await readFile(join(dir, 'purpose.md'), 'utf8')).toBe('clearer onboarding prose\n')
    expect(await readFile(join(dir, 'rubric.md'), 'utf8')).toBe('# Rubric\nPrefer clarity.\n')
    for (const name of ['context.json', 'purpose.md', 'rubric.md']) {
      const text = await readFile(join(dir, name), 'utf8')
      for (const forbidden of [CANDIDATE, BASELINE, PIN, 'candidate', 'baseline', 'first'])
        expect(text).not.toContain(forbidden)
    }
  })

  test('prefer records one preference; a second call is refused', async () => {
    const root = await judgeRoot()
    const store = await judging()
    const scoped = scopeLocalStoreToJudgeSession(store, {
      build: BUILD,
      panel: PANEL,
      judge: 1,
      session: SESSION,
    })
    const first = await cli(
      ['judge', 'prefer', 'B', '--reason', 'B states each step once.'],
      root,
      scoped,
    )
    expect(first.code).toBe(0)
    expect(first.out).toContain('panel.preferred recorded: B')
    const events = await store.getEvents(BUILD)
    expect(events.at(-1)).toMatchObject({
      type: 'panel.preferred',
      actor: { kind: 'agent', role: 'judge', session: SESSION },
      payload: { panel: PANEL, judge: 1, session: SESSION, preference: 'B' },
    })

    const second = await cli(['judge', 'prefer', 'A', '--reason', 'changed my mind'], root, scoped)
    expect(second.code).not.toBe(0)
    expect(second.err).toContain('already recorded its preference')
    expect((await store.getEvents(BUILD)).length).toBe(events.length)
  })

  test('a blank reason or an unknown preference is refused before any write', async () => {
    const root = await judgeRoot()
    for (const argv of [
      ['judge', 'prefer', 'A', '--reason', '   '],
      ['judge', 'prefer', 'C', '--reason', 'because'],
      ['judge', 'prefer', 'A'],
    ]) {
      const result = await cli(argv, root, untouchable())
      expect(result.code).not.toBe(0)
      expect(result.err).not.toContain('was called')
    }
  })

  test('prefer reads a long reason from a file', async () => {
    const root = await judgeRoot()
    const store = await judging()
    const scoped = scopeLocalStoreToJudgeSession(store, {
      build: BUILD,
      panel: PANEL,
      judge: 1,
      session: SESSION,
    })
    await writeFile(join(root, 'reason.md'), 'A tie: both meet every criterion equally.')
    const result = await cli(
      ['judge', 'prefer', 'tie', '--reason-file', join(root, 'reason.md')],
      root,
      scoped,
    )
    expect(result.code).toBe(0)
    expect((await store.getEvents(BUILD)).at(-1)?.payload).toMatchObject({
      preference: 'tie',
      reason: 'A tie: both meet every criterion equally.',
    })
  })
})

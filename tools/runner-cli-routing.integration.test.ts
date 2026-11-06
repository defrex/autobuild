import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DISPATCHER, KERNEL } from '../packages/core/src/events/envelope'
import { AGENT_BIN_DIR, sessionEnv } from '../packages/core/src/ports/runner/session-env'
import { openLocalStore } from '../packages/core/src/store/local/store'
import { textContent } from '../packages/core/src/store/types'
import { steppingClock } from '../packages/core/src/testing/fixed'
import { CONFIG_TOML, GIT_ID, git } from '../packages/core/src/scenarios/harness'

test('runner CLI handles event schema skew in an old branch worktree', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-e2e-bin-'))
  try {
    const root = join(tmp, 'store')
    const ws = join(tmp, 'ws')
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await git(['init', '--initial-branch=main'], repo)
    await mkdir(join(repo, 'bin'))
    // Bounded old-schema decoder fixture, not an executed historical release.
    // Read the same scratch SQLite events as the managed CLI.
    await writeFile(
      join(repo, 'bin/ab.ts'),
      `
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
const supported = new Set(['build.created', 'spec.imported', 'plan.started', 'session.started'])
const db = new Database(join(process.env.AB_STORE!, 'autobuild.sqlite'), { readonly: true })
try {
  const events = db.query('SELECT type FROM events WHERE build = ? ORDER BY seq').all(process.env.AB_BUILD!) as { type: string }[]
  for (const event of events) {
    if (!supported.has(event.type)) throw new Error('invalid persisted value for buildReadFacts: unsupported event ' + event.type)
  }
} finally {
  db.close()
}
`,
    )
    await git(['add', '.'], repo)
    await git([...GIT_ID, 'commit', '-m', 'Old branch schema fixture'], repo)
    await git(['worktree', 'add', '-b', 'old-branch', ws], repo)
    await writeFile(join(ws, 'autobuild.toml'), CONFIG_TOML)
    const slug = 'local-e2e'
    const ticket = { source: 'fake', id: 'T-local', title: 'Local e2e' }

    // Seed a real plan session through the store API.
    const seed = openLocalStore(root, { clock: steppingClock() })
    try {
      await seed.createBuild({ slug, repo: '/repo/e2e', ticket })
      await seed.putArtifact(slug, { kind: 'spec', content: '# Spec: local e2e\n' })
      await seed.append(slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket, repo: '/repo/e2e', baseBranch: 'main' },
      })
      await seed.append(slug, {
        actor: DISPATCHER,
        type: 'spec.imported',
        payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
      })
      await seed.append(slug, {
        actor: KERNEL,
        type: 'plan.started',
        payload: { round: 1 },
      })
      await seed.append(slug, {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 's_e2e',
          role: 'plan',
          runner: 'pi',
          phase: 'plan',
          round: 1,
        },
      })
      await seed.append(slug, {
        actor: KERNEL,
        type: 'session.native-handle-recorded',
        payload: {
          session: 's_e2e',
          phase: 'plan',
          round: 1,
          handle: {
            version: 1,
            runner: 'pi',
            nativeId: 'fixture-session',
            host: 'fixture',
            workspacePath: ws,
          },
        },
      })
    } finally {
      await seed.close()
    }

    const env = sessionEnv(
      {
        AB_STORE: root,
        AB_BUILD: slug,
        AB_PHASE: 'plan@1',
        AB_SESSION: 's_e2e',
        AB_TOKEN: '',
      },
      // The enclosing build's context directory must not override this plan session.
      { ...process.env, AB_CONTEXT_DIR: undefined },
    )
    expect(env.PATH!.split(delimiter)[0]).toBe(AGENT_BIN_DIR)

    // Invoke by the documented spelling — no process.execPath or repository
    // path escape hatch. This also executes the checked-in launcher's mode.
    const ab = async (
      argv: string[],
      executable = 'ab',
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      const proc = Bun.spawn([executable, ...argv], {
        cwd: ws,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    }

    const old = await ab(['bin/ab.ts', 'context'], 'bun')
    expect(old.code).not.toBe(0)
    expect(old.stderr).toContain(
      'invalid persisted value for buildReadFacts: unsupported event session.native-handle-recorded',
    )

    const context = await ab(['context'])
    expect(context).toMatchObject({ code: 0, stderr: '' })
    expect(context.stdout).toContain(`context materialized for ${slug} — plan@1`)
    expect(await readFile(join(ws, '.ab/plan', 'spec.md'), 'utf8')).toBe('# Spec: local e2e\n')

    expect(JSON.parse(await readFile(join(ws, '.ab/plan/context.json'), 'utf8'))).toMatchObject({
      build: slug,
      phase: 'plan',
      round: 1,
      contextDir: '.ab/plan',
    })

    const got = await ab(['artifact', 'get', 'spec'])
    expect(got).toEqual({
      code: 0,
      stderr: '',
      stdout: '# Spec: local e2e\n\n',
    })

    await writeFile(join(ws, 'plan.md'), '# Plan via the managed ab\n')
    const put = await ab(['artifact', 'put', 'plan', join(ws, 'plan.md')])
    expect(put).toEqual({ code: 0, stderr: '', stdout: '0\n' })

    const done = await ab(['done'])
    expect(done).toEqual({
      code: 0,
      stderr: '',
      stdout: 'plan.completed recorded (seq 6)\n',
    })

    // Round-trip through SQLite proves this was the typed Autobuild terminal,
    // attributed to the active session, rather than a same-named shim.
    const store = openLocalStore(root)
    try {
      const plan = (await store.getArtifact(slug, 'plan'))!
      expect(textContent(plan)).toBe('# Plan via the managed ab\n')
      expect(plan.meta.revision).toBe(0)
      const events = await store.getEvents(slug)
      expect(events.map((event) => event.type)).toEqual([
        'build.created',
        'spec.imported',
        'plan.started',
        'session.started',
        'session.native-handle-recorded',
        'plan.completed',
      ])
      const completed = events[5]!
      expect(completed.actor).toEqual({ kind: 'agent', role: 'plan', session: 's_e2e' })
      expect(completed.type).toBe('plan.completed')
      if (completed.type === 'plan.completed') {
        expect(completed.payload).toEqual({
          round: 1,
          artifact: { kind: 'plan', rev: 0 },
          verifySteps: ['unit'],
        })
      }
    } finally {
      await store.close()
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}, 30_000)

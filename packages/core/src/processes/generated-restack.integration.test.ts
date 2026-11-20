import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedStore, BUILD, BRANCH } from '../cli/testkit'
import { parseConfig } from '../config/load'
import { KERNEL } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { sequentialIds } from '../ids'
import { LocalGitForge } from '../ports/forge/local-git'
import { bunExec } from '../ports/forge/github'
import { defaultTurnResult, ScriptedAgentRunner } from '../ports/runner/fake'
import { leafRestackLog } from '../kernel/generators/leaf-restack-log'
import { done } from '../cli/terminals'
import { buildContext } from '../cli/context'
import { parseAbPhase } from '../cli/env'
import { readBuildFacts } from '../store/reduced-reads'
import { BuildRunner } from './build-runner'

const mkdtemp = ownTempDirectories(afterEach)

const configToml = (command: string) => `
[roles.default]
runtime = "scripted"
[tickets]
source = "file"
readyState = "ready"
[commands]
test = "true"
[[generated]]
paths = ["gen.txt"]
command = ${JSON.stringify(command)}
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
`

/**
 * A leaf build whose single change edits gen.txt (conflicting with main) and
 * src/a.ts (applying cleanly). `command` is the declared regeneration.
 */
async function leafRestack(command: (counter: string) => string) {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-generated-leaf-'))
  const outside = await mkdtemp(join(tmpdir(), 'ab-generated-count-'))
  const counter = join(outside, 'runs')
  const git = async (args: string[]) => {
    const result = await bunExec(['git', ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, name)), { recursive: true })
      await writeFile(join(cwd, name), text)
    }
    await git(['add', '-A'])
    await git(['commit', '-qm', message])
    return git(['rev-parse', 'HEAD'])
  }
  const toml = configToml(command(counter))
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'rerere.enabled', 'false'])
  const base = await commit(
    { 'autobuild.toml': toml, '.gitignore': '.ab/\n', 'gen.txt': 'base\n', 'src/a.ts': 'a0\n' },
    'base',
  )
  await git(['checkout', '-qb', BRANCH])
  const oldHead = await commit({ 'gen.txt': 'leaf\n', 'src/a.ts': 'a1\n' }, 'leaf')
  await git(['checkout', '-q', 'main'])
  const target = await commit({ 'gen.txt': 'upstream\n' }, 'upstream')
  await git(['checkout', '-q', BRANCH])

  const store = await seedStore()
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'git-worktree',
      remote: false,
      ref: cwd,
      branch: BRANCH,
      base: { source: 'remote', sha: base },
    },
  })
  for (const event of leafRestackLog().slice(2, 6)) {
    const payload =
      event.type === 'implement.completed'
        ? { ...event.payload, commits: { base, head: oldHead } }
        : event.payload
    await store.append(BUILD, { actor: event.actor, type: event.type, payload })
  }
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'target.moved',
    payload: { branch: 'main', sha: target },
  })
  const forge = new LocalGitForge({ exec: bunExec, repoRoot: cwd })
  const sessions: string[] = []
  const deps = {
    store: store.scopeBuild(BUILD),
    config: parseConfig(toml),
    runtimes: {
      scripted: {
        runner: new ScriptedAgentRunner({
          script: async (ctx) => {
            const parsed = parseAbPhase(ctx.opts.env.AB_PHASE!)
            sessions.push(parsed.phase)
            const env = {
              store: 'local',
              build: BUILD,
              phase: parsed.phase,
              round: parsed.round,
              session: ctx.opts.env.AB_SESSION!,
            }
            await handler({ env, git, cwd })
            const notes = `${cwd}-notes.md`
            await writeFile(notes, 'Resolved the hand-written side and regenerated gen.txt.\n')
            try {
              await done(
                { store, forge, workspacePath: cwd, exec: bunExec, ids: sequentialIds(), env },
                { notes },
              )
            } finally {
              await rm(notes, { force: true })
            }
            return defaultTurnResult()
          },
        }),
        servesModels: [],
      },
    },
    workspacePath: cwd,
    branch: BRANCH,
    slug: BUILD,
    exec: bunExec,
    forge,
    ids: sequentialIds(),
    clock: () => new Date(),
    instance: 'test',
    host: 'test',
    opts: { maxPhaseAttempts: 2 },
  }
  let handler: (input: {
    env: Parameters<typeof done>[0]['env']
    git: typeof git
    cwd: string
  }) => Promise<void> = async () => {
    throw new Error('no reconcile session expected')
  }
  await store.claimLease(BUILD, 'test', 3_600_000)
  const runs = async () =>
    existsSync(counter) ? (await readFile(counter, 'utf8')).split('\n').filter(Boolean).length : 0
  return {
    cwd,
    git,
    store,
    deps,
    target,
    sessions,
    runs,
    onSession: (next: typeof handler) => {
      handler = next
    },
    /** Step until the restack completes (or `limit` steps). */
    runToCompletion: async (limit = 8) => {
      for (let step = 0; step < limit; step++) {
        if ((await readBuildFacts(store, BUILD)).value.log.restack.completed) return
        await new BuildRunner(deps).step()
      }
    },
  }
}

const regenerated = async (store: Awaited<ReturnType<typeof seedStore>>) =>
  (await store.getEvents(BUILD)).filter((event) => event.type === 'restack.regenerated')

test('a restack conflicting only in a declared generated file publishes with no session', async () => {
  const leaf = await leafRestack(
    (counter) => `echo run >> ${counter}; cat src/a.ts > gen.txt; echo regenerated >> gen.txt`,
  )
  await leaf.runToCompletion()
  const facts = (await readBuildFacts(leaf.store, BUILD)).value
  expect(facts.log.restack.completed).toBeDefined()
  expect(leaf.sessions).toEqual([])
  const facts$ = await regenerated(leaf.store)
  expect(facts$.map((event) => event.payload)).toEqual([
    {
      id: facts.log.restack.completed!.id,
      files: ['gen.txt'],
      commands: [{ command: expect.stringContaining('cat src/a.ts'), files: ['gen.txt'] }],
      outcome: 'resolved',
      head: facts.log.restack.completed!.headSha,
    },
  ])
  expect(await leaf.git(['show', '-s', '--format=%P', BRANCH])).toBe(leaf.target)
  expect(await leaf.git(['show', `${BRANCH}:gen.txt`])).toBe('a1\nregenerated')
  expect(await leaf.git(['show', `${BRANCH}:src/a.ts`])).toBe('a1')
  expect(await leaf.runs()).toBe(1)
  expect(facts.log.restack.completedRegeneration?.outcome).toBe('resolved')
  const events = await leaf.store.getEvents(BUILD)
  expect(events.some((event) => event.type === 'reconcile.started')).toBe(false)
  const paths = events.findLast((event) => event.type === 'head.paths-recorded')
  expect(paths?.type === 'head.paths-recorded' && paths.payload.resolution).toBeDefined()
})

test('a failed regeneration falls back to one reconcile session on the recorded conflict', async () => {
  const leaf = await leafRestack(
    (counter) => `echo run >> ${counter}; printf partial > gen.txt; printf junk > junk.txt; exit 1`,
  )
  leaf.onSession(async ({ env, git, cwd }) => {
    expect(env.phase).toBe('reconcile')
    expect(await git(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).toMatch(/^[0-9a-f]{40}$/)
    expect(await git(['diff', '--name-only', '--diff-filter=U'])).toBe('gen.txt')
    expect(await git(['ls-files', '-s', '--', 'src/a.ts'])).toContain(
      await git(['rev-parse', `${BRANCH}:src/a.ts`]),
    )
    expect(existsSync(join(cwd, 'junk.txt'))).toBe(false)
    const manifest = await buildContext({
      store: leaf.store,
      env,
      workspacePath: cwd,
      exec: bunExec,
    })
    expect(manifest.generated).toEqual([
      { command: expect.stringContaining('printf partial'), files: ['gen.txt'] },
    ])
    expect(manifest.regeneration?.reason).toContain('exited 1')
    await rm(join(cwd, manifest.contextDir), { recursive: true, force: true })
    // The agent resolves everything else, then rebuilds the generated file.
    await writeFile(join(cwd, 'gen.txt'), 'agent-regenerated\n')
    await git(['add', 'gen.txt'])
    await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'])
  })
  await leaf.runToCompletion()
  const events = await leaf.store.getEvents(BUILD)
  expect((await regenerated(leaf.store)).map((event) => event.payload.outcome)).toEqual(['failed'])
  expect(leaf.sessions).toEqual(['reconcile'])
  expect(events.filter((event) => event.type === 'reconcile.started')).toHaveLength(1)
  expect(await leaf.runs()).toBe(1)
  expect(await leaf.git(['show', `${BRANCH}:src/a.ts`])).toBe('a1')
  expect(await leaf.git(['show', `${BRANCH}:gen.txt`])).toBe('agent-regenerated')
})

test('an interrupted resolved regeneration publishes its retained head without rerunning', async () => {
  const leaf = await leafRestack(
    (counter) => `echo run >> ${counter}; cat src/a.ts > gen.txt; echo regenerated >> gen.txt`,
  )
  const append = leaf.deps.store.append.bind(leaf.deps.store)
  let interrupt = true
  leaf.deps.store.append = (async (slug: string, write: EventWrite) => {
    if (interrupt && write.type === 'restack.publish-intended') {
      interrupt = false
      throw new Error('process stopped')
    }
    return append(slug, write)
  }) as typeof leaf.deps.store.append
  await new BuildRunner(leaf.deps).step()
  const resolved = (await regenerated(leaf.store)).at(-1)
  expect(resolved?.payload.outcome).toBe('resolved')
  // A replacement workspace starts back at the published branch.
  await leaf.git(['checkout', '-q', '--detach', BRANCH])
  await leaf.runToCompletion()
  const facts = (await readBuildFacts(leaf.store, BUILD)).value
  expect(facts.log.restack.completed?.headSha).toBe(resolved?.payload.head)
  expect(await leaf.git(['rev-parse', BRANCH])).toBe(resolved!.payload.head!)
  expect(await leaf.runs()).toBe(1)
  expect(leaf.sessions).toEqual([])
  expect(await regenerated(leaf.store)).toHaveLength(1)
})

test('a conflict outside the declaration is skipped and reconciled by an agent', async () => {
  const leaf = await leafRestack((counter) => `echo run >> ${counter}`)
  // Main also edits the hand-written file the leaf changes.
  await leaf.git(['checkout', '-q', 'main'])
  await writeFile(join(leaf.cwd, 'src/a.ts'), 'main\n')
  await leaf.git(['commit', '-qam', 'main edits a'])
  const target = await leaf.git(['rev-parse', 'HEAD'])
  await leaf.git(['checkout', '-q', BRANCH])
  await leaf.store.append(BUILD, {
    actor: KERNEL,
    type: 'target.moved',
    payload: { branch: 'main', sha: target },
  })
  leaf.onSession(async ({ git, cwd }) => {
    expect((await git(['diff', '--name-only', '--diff-filter=U'])).split('\n')).toEqual([
      'gen.txt',
      'src/a.ts',
    ])
    await writeFile(join(cwd, 'src/a.ts'), 'merged\n')
    await writeFile(join(cwd, 'gen.txt'), 'merged\n')
    await git(['add', '-A', '--', 'gen.txt', 'src/a.ts'])
    await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'])
  })
  await leaf.runToCompletion()
  const outcomes = (await regenerated(leaf.store)).map((event) => event.payload)
  expect(outcomes).toEqual([
    expect.objectContaining({
      outcome: 'skipped',
      commands: [{ command: expect.any(String), files: ['gen.txt'] }],
      reason: 'conflicts outside [[generated]]: src/a.ts',
    }),
  ])
  expect(leaf.sessions).toEqual(['reconcile'])
  expect(await leaf.runs()).toBe(0)
})

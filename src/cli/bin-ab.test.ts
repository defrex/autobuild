/**
 * End-to-end smoke tests for the REAL `ab` binary.
 *
 * These exist because every other CLI test calls `runCli` directly and so
 * never traverses the real process entries and shared `src/cli/binary.ts`
 * wiring. That wiring classifies sessionless commands before ambient auth,
 * strictly resolves complete build/harvest tuples, and sends a typed missing
 * tuple back through `runCli` for command-aware guidance. A regression at any
 * of those boundaries can ship while dependency-injected router tests stay
 * green, so the binary itself is executed.
 *
 * Most sessionless smoke cases point AB_STORE at a temporary override. Missing
 * session tests remove every AB_* value, while complete-session cases seed the
 * local store and prove strict production resolution still executes. A
 * separate real-Git case exercises the implicit repository-local root.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'

const ROOT = join(import.meta.dir, '..', '..')
const BIN = join(ROOT, 'bin', 'ab.ts')

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-bin-'))
  // Scoped binary composition reads the build worktree's config before
  // selecting its forge. Sessionless cases ignore this fixture.
  await writeFile(join(tmp, 'autobuild.toml'), '[tickets]\nsource = "file"\nreadyState = "ready"\n')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function collect(
  proc: Bun.ReadableSubprocess,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

function bareEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
}

function testEnv(): Record<string, string> {
  return {
    ...bareEnv(),
    // The store is a temp dir; AB_BUILD/AB_PHASE/AB_SESSION are deliberately
    // absent for sessionless smoke cases.
    AB_STORE: join(tmp, 'store'),
  }
}

async function runBin(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(
    Bun.spawn(['bun', BIN, ...args], {
      cwd: tmp,
      env: { ...testEnv(), ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

async function runBinWithoutAb(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(
    Bun.spawn(['bun', BIN, ...args], {
      cwd: tmp,
      env: { ...bareEnv(), ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

async function runDev(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(
    Bun.spawn(['bun', 'run', 'dev', '--', ...args], {
      cwd: ROOT,
      env: testEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

async function runBinAt(
  cwd: string,
  args: string[],
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(
    Bun.spawn(['bun', BIN, ...args], {
      cwd,
      // Deliberately omit every AB_* variable: this is the implicit-root path.
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

test('top-level help aliases are identical and need no AB_* environment', async () => {
  const results = await Promise.all(
    [['help'], ['--help'], ['-h']].map((argv) => runBinWithoutAb(argv)),
  )
  for (const result of results) {
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Primary human workflow:')
    expect(result.stdout).toContain('Human-first commands:')
    expect(result.stdout).toContain('AI-first commands:')
  }
  expect(new Set(results.map((result) => result.stdout)).size).toBe(1)
})

test('detailed AI-first help is identical outside and inside ambient sessions', async () => {
  const canonical = await runBinWithoutAb(['help', 'context'])
  const flag = await runBinWithoutAb(['context', '--help'])
  const ambient = await runBinWithoutAb(['context', '--help'], {
    AB_STORE: 'https://invalid.example.test/store',
    AB_BUILD: 'ambient-build',
    AB_PHASE: 'malformed-on-purpose',
    AB_SESSION: 'ambient-session',
  })

  for (const result of [canonical, flag, ambient]) {
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('ab context [--json]')
  }
  expect(flag.stdout).toBe(canonical.stdout)
  expect(ambient.stdout).toBe(canonical.stdout)
})

test('unknown detailed help exits nonzero and names the target', async () => {
  const result = await runBinWithoutAb(['help', 'frobnicate'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('unknown help command "frobnicate"')
})

const BUILD_SESSION_COMMANDS = [
  ['context', ['context']],
  ['artifact put', ['artifact', 'put', 'notes', 'notes.md']],
  ['artifact get', ['artifact', 'get', 'notes']],
  ['observe', ['observe', '--kind', 'followup', 'record this']],
  ['server', ['server', 'status']],
  ['done', ['done']],
  ['verdict', ['verdict', 'approve']],
  ['escalate', ['escalate', 'Which behavior is intended?']],
] as const

test.each(BUILD_SESSION_COMMANDS)(
  'bare ab %s reports complete build-session guidance',
  async (_label, argv) => {
    const result = await runBinWithoutAb([...argv])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`'ab ${argv[0]}' runs inside a build session`)
    for (const name of ['AB_STORE', 'AB_BUILD', 'AB_PHASE', 'AB_SESSION']) {
      expect(result.stderr).toContain(name)
      expect(result.stderr).not.toContain(`${name} is not set`)
    }
  },
)

const HARVEST_SESSION_COMMANDS = [
  ['context', ['harvest', 'context']],
  ['submit', ['harvest', 'submit', 'proposals.json']],
  ['verdict', ['harvest', 'verdict', 'approve', '--notes', 'review.md']],
] as const

test.each(HARVEST_SESSION_COMMANDS)(
  'bare ab harvest %s reports complete harvest-session guidance',
  async (subcommand, argv) => {
    const result = await runBinWithoutAb([...argv])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      `'ab harvest ${subcommand}' runs inside a harvest agent session`,
    )
    for (const name of ['AB_STORE', 'AB_REPO', 'AB_HARVEST', 'AB_PHASE', 'AB_SESSION']) {
      expect(result.stderr).toContain(name)
      expect(result.stderr).not.toContain(`${name} is not set`)
    }
  },
)

test('ab builds runs with no session environment set', async () => {
  const result = await runBin(['builds'])
  expect(result.stderr).not.toContain('AB_BUILD')
  expect(result.stderr).not.toContain('runs inside a build session')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('no active builds')
})

test('ab builds --json emits parseable JSON and no ANSI', async () => {
  const result = await runBin(['builds', '--all', '--json'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b')
  expect(JSON.parse(result.stdout)).toEqual([])
})

test('the repo dev script forwards a complete CLI invocation and exits under --hot', async () => {
  const result = await runDev(['builds', '--all', '--json'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b')
  expect(JSON.parse(result.stdout)).toEqual([])
})

test('plugin diagnostics and a real contract run are sessionless in the binary', async () => {
  await writeFile(
    join(tmp, 'autobuild.toml'),
    'plugins = ["./plugin.ts"]\n[tickets]\nsource = "file"\nreadyState = "ready"\n',
  )
  await writeFile(
    join(tmp, 'plugin.ts'),
    `
import { FakeTicketSource } from ${JSON.stringify(join(ROOT, 'src', 'plugin-sdk', 'index.ts'))}
const adapter = () => new FakeTicketSource()
const fixture = () => async () => ({
  source: new FakeTicketSource([], { createState: 'Triage', doneState: 'Done' }),
  states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
  editableLabel: 'contract',
})
export default {
  name: 'binary-fixture', apiVersion: '^1.1.0',
  ticketSources: { sample: { factory: adapter, contract: { factory: fixture } } },
}
`,
  )

  const doctor = await runBinWithoutAb(['plugin', 'doctor'])
  expect(doctor.code).toBe(0)
  expect(doctor.stdout).toContain('OK ./plugin.ts')
  expect(doctor.stderr).not.toContain('AB_BUILD')

  const contract = await runBinWithoutAb(['plugin', 'test', 'ticket-source', 'sample'])
  expect(contract.code).toBe(0)
  expect(contract.stdout + contract.stderr).toContain('create/get round-trips common fields')
})

test('ab build status runs sessionless and exits 1 on an unknown slug', async () => {
  const result = await runBin(['build', 'status', 'no-such-build'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('no-such-build')
  expect(result.stderr).not.toContain('AB_BUILD')
})

test('a real sessionless control command reaches the store and writes a human event', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'controlled', repo: await realpath(tmp) })
  await local.append('controlled', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
  })
  await local.close()

  const result = await runBin(['pause', 'controlled'])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('pause requested')

  const reopened = openLocalStore(join(tmp, 'store'))
  const event = (await reopened.getEvents('controlled')).at(-1)
  expect(event?.type).toBe('build.pause-requested')
  expect(event?.actor).toEqual({ kind: 'human', user: 'dashboard' })
  await reopened.close()
})

test('artifact download alone is sessionless and preserves binary bytes', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'finished', repo: await realpath(tmp) })
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
  await local.putArtifact('finished', {
    kind: 'visual:mixed-wide',
    content: bytes,
  })
  await local.close()

  const result = await runBinWithoutAb([
    'artifact',
    'download',
    'finished',
    'visual:mixed-wide@0',
    '--output',
    'downloads/frame.png',
    '--store',
    join(tmp, 'store'),
  ])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('visual:mixed-wide@0')
  expect(await Bun.file(join(tmp, 'downloads', 'frame.png')).bytes()).toEqual(bytes)
})

test('artifact put --attach uses the real binary grammar and records the assigned revision', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'attached', repo: await realpath(tmp) })
  await local.close()
  const file = join(tmp, 'evidence.png')
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  await writeFile(file, bytes)

  const result = await runBin(['artifact', 'put', 'visual:evidence', file, '--attach'], {
    AB_BUILD: 'attached',
    AB_PHASE: 'verify:visual@1',
    AB_SESSION: 's_visual',
  })
  expect(result).toEqual({ code: 0, stderr: '', stdout: '0\n' })

  const reopened = openLocalStore(join(tmp, 'store'))
  const event = (await reopened.getEvents('attached')).at(-1)
  expect(event).toMatchObject({
    actor: { kind: 'agent', role: 'verify:visual', session: 's_visual' },
    type: 'pr-attachment.designated',
    payload: {
      artifact: { kind: 'visual:evidence', rev: 0 },
      filename: 'evidence.png',
      mediaType: 'image/png',
    },
  })
  expect((await reopened.getArtifact('attached', 'visual:evidence', 0))?.content).toEqual(bytes)
  await reopened.close()
})

test('harvest status remains sessionless with no ambient AB_* values', async () => {
  const result = await runBinWithoutAb([
    'harvest',
    'status',
    '--json',
    '--store',
    join(tmp, 'status-store'),
  ])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'idle',
    paused: false,
    runs: [],
  })
})

test('a complete build tuple resolves its store and runs context', async () => {
  const slug = 'phase-context'
  const repo = await realpath(tmp)
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug, repo, branch: `ab/${slug}` })
  await local.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: {
        source: 'linear',
        id: 'AUT-101',
        title: 'Phase context fixture',
      },
      repo,
      baseBranch: 'main',
    },
  })
  const spec = await local.putArtifact(slug, {
    kind: 'spec',
    content: '# Phase context fixture\n',
  })
  await local.append(slug, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: {
      artifact: { kind: spec.kind, rev: spec.revision },
      ticket: { source: 'linear', id: 'AUT-101' },
    },
  })
  await local.close()

  const result = await runBin(['context', '--json'], {
    AB_BUILD: slug,
    AB_PHASE: 'plan@1',
    AB_SESSION: 's_context',
  })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchObject({
    build: slug,
    phase: 'plan',
    round: 1,
    materialized: { 'spec.md': { kind: 'spec', rev: 0 } },
  })
})

test('a scoped implement terminal routes publication through the configured plugin forge', async () => {
  const slug = 'plugin-forge-terminal'
  const marker = join(tmp, 'forge-calls.log')
  await writeFile(
    join(tmp, 'autobuild.toml'),
    'forge = "recording"\nplugins = ["./forge-plugin.ts"]\n[tickets]\nsource = "file"\nreadyState = "ready"\n',
  )
  await writeFile(
    join(tmp, 'forge-plugin.ts'),
    `import { appendFileSync } from 'node:fs'\n` +
      `export default { name: 'recording-forge', apiVersion: '^1.0.0', forges: { recording: ({ env }) => ({\n` +
      `  name: 'recording',\n` +
      `  pushBranch: async (_workspace, branch) => { appendFileSync(env['FORGE_MARKER'], 'push:' + branch + '\\n') },\n` +
      `  openPr: async () => ({ number: 1, url: 'https://example.test/pr/1', headSha: 'head' }),\n` +
      `  getPrState: async () => ({ state: 'open', mergeable: null }),\n` +
      `  setAutoMerge: async () => ({ kind: 'applied' }),\n` +
      `  squashMerge: async () => {}, commentOnPr: async () => {}\n` +
      `}) } }\n`,
  )
  await git(tmp, 'init', '-q', '-b', 'main')
  await git(tmp, 'config', 'user.email', 'ab-bin@example.invalid')
  await git(tmp, 'config', 'user.name', 'ab-bin')
  await git(tmp, 'add', 'autobuild.toml', 'forge-plugin.ts')
  await git(tmp, 'commit', '-q', '-m', 'initial')
  await git(tmp, 'init', '--bare', '-q', '-b', 'main', 'remote.git')
  await git(tmp, 'remote', 'add', 'origin', join(tmp, 'remote.git'))
  await git(tmp, 'push', '-q', '-u', 'origin', 'main')
  const baseResult = await spawnExec(['git', 'rev-parse', 'HEAD'], { cwd: tmp })
  expect(baseResult.exitCode).toBe(0)
  const base = baseResult.stdout.trim()
  await git(tmp, 'checkout', '-q', '-b', `ab/${slug}`)
  await writeFile(join(tmp, 'feature.ts'), 'export const feature = true\n')
  await git(tmp, 'add', 'feature.ts')
  await git(tmp, 'commit', '-q', '-m', 'implement feature')
  await mkdir(join(tmp, '.ab'), { recursive: true })
  await writeFile(
    join(tmp, '.git', 'info', 'exclude'),
    '.ab/\nstore/\nremote.git/\nforge-calls.log\n',
  )
  await writeFile(join(tmp, '.ab', 'implement-notes.md'), 'implemented through plugin forge\n')

  const repo = await realpath(tmp)
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug, repo, branch: `ab/${slug}` })
  await local.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'file', id: 'T-plugin', title: 'Plugin forge terminal' },
      repo,
      baseBranch: 'main',
    },
  })
  await local.append(slug, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'git-worktree',
      ref: repo,
      branch: `ab/${slug}`,
      base: { source: 'existing', sha: base },
    },
  })
  await local.append(slug, {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round: 1 },
  })
  await local.close()

  const result = await runBin(['done', '--notes', '.ab/implement-notes.md'], {
    AB_BUILD: slug,
    AB_PHASE: 'implement@1',
    AB_SESSION: 's_plugin_forge',
    FORGE_MARKER: marker,
  })
  expect(result).toEqual({
    code: 0,
    stderr: '',
    stdout: 'implement.completed recorded (seq 4)\n',
  })
  expect(await Bun.file(marker).text()).toBe(`push:ab/${slug}\n`)

  const reopened = openLocalStore(join(tmp, 'store'))
  expect((await reopened.getEvents(slug)).map((event) => event.type)).toContain(
    'implement.completed',
  )
  await reopened.close()
})

test('a complete harvest tuple resolves its store and runs context', async () => {
  const repo = await realpath(tmp)
  const run = 'h_context'
  const local = openLocalStore(join(tmp, 'store'))
  await local.ensureRepo(repo)
  const packet = {
    repo,
    run,
    observations: [
      {
        occurrence: { build: 'source-build', seq: 7 },
        id: 'obs-context',
        kind: 'followup' as const,
        summary: 'Follow-up fixture',
        ts: '2026-01-01T00:00:00.000Z',
      },
    ],
    ledger: [],
  }
  await local.appendRepoWithArtifacts(
    repo,
    [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run,
        observations: [{ build: 'source-build', seq: 7 }],
        scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
      },
    }),
  )
  await local.close()

  const result = await runBin(['harvest', 'context', '--json'], {
    AB_REPO: repo,
    AB_HARVEST: run,
    AB_PHASE: 'synthesize@1',
    AB_SESSION: 'hs_context',
  })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchObject({
    repo,
    run,
    phase: 'synthesize',
    round: 1,
    allowedTerminal: 'submit',
  })
})

test('complete but malformed build and harvest phases keep precise resolver errors', async () => {
  const build = await runBin(['context'], {
    AB_BUILD: 'phase-context',
    AB_PHASE: 'implement@nope',
    AB_SESSION: 's_bad_phase',
  })
  expect(build.code).toBe(1)
  expect(build.stderr).toContain('AB_PHASE "implement@nope" has a malformed round "nope"')
  expect(build.stderr).not.toContain('runs inside a build session')

  const harvest = await runBin(['harvest', 'context'], {
    AB_REPO: await realpath(tmp),
    AB_HARVEST: 'h_bad_phase',
    AB_PHASE: 'review',
    AB_SESSION: 'hs_bad_phase',
  })
  expect(harvest.code).toBe(1)
  expect(harvest.stderr).toContain('AB_PHASE "review" is not a harvest session phase')
  expect(harvest.stderr).not.toContain('runs inside a harvest agent session')
})

test('the real binary rejects an own-phase control without changing the log', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'self-controlled', repo: await realpath(tmp) })
  await local.append('self-controlled', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
  })
  const before = await local.getEvents('self-controlled')
  await local.close()

  const result = await runBin(['abort', 'self-controlled'], {
    AB_SESSION: 'phase-session',
    AB_BUILD: 'self-controlled',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('own phase session')
  expect(result.stderr).toContain('AB_SESSION/AB_BUILD conflict')

  const reopened = openLocalStore(join(tmp, 'store'))
  expect(await reopened.getEvents('self-controlled')).toEqual(before)
  await reopened.close()
})

test('implicit state is shared by a main checkout and its linked worktree and ignores HOME', async () => {
  const main = join(tmp, 'main')
  const linked = join(tmp, 'linked')
  const fakeHome = join(tmp, 'home')
  await git(tmp, 'init', '-b', 'main', main)
  await git(main, 'config', 'user.email', 'test@example.com')
  await git(main, 'config', 'user.name', 'Test')
  await writeFile(join(main, 'README.md'), 'fixture\n')
  await git(main, 'add', 'README.md')
  await git(main, 'commit', '-m', 'fixture')
  await git(main, 'worktree', 'add', '-b', 'linked', linked)

  const canonicalMain = await realpath(main)
  const local = openLocalStore(join(main, '.autobuild'))
  await local.createBuild({ slug: 'repo-build', repo: canonicalMain })
  await local.append('repo-build', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  await local.close()

  // Poison the old machine-level shape. Repository-local resolution must never
  // discover this otherwise valid store through HOME.
  const poison = openLocalStore(join(fakeHome, '.autobuild'))
  await poison.createBuild({ slug: 'home-only', repo: canonicalMain })
  await poison.close()

  const fromMain = await runBinAt(main, ['builds', '--all', '--json'], fakeHome)
  const fromLinked = await runBinAt(linked, ['builds', '--all', '--json'], fakeHome)
  expect(fromMain.code).toBe(0)
  expect(fromLinked.code).toBe(0)
  expect(fromMain.stderr).toBe('')
  expect(fromLinked.stderr).toBe('')
  expect(JSON.parse(fromMain.stdout).map((build: { slug: string }) => build.slug)).toEqual([
    'repo-build',
  ])
  expect(JSON.parse(fromLinked.stdout)).toEqual(JSON.parse(fromMain.stdout))
})

test('a partial build tuple is rejected by the command guard', async () => {
  // AB_STORE alone must not become an accepted partial identity.
  const result = await runBin(['context'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("'ab context' runs inside a build session")
  expect(result.stderr).toContain('AB_BUILD')
  expect(result.stderr).not.toContain('AB_BUILD is not set')
})

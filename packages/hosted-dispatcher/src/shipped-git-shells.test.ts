import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FakeForge,
  inspectGitCandidate,
  kernelGitUnavailableDetail,
  MemoryBuildStore,
  restoreChange,
  restoreReplay,
  retainReplay,
  spawnExec,
  temporaryDirectories,
  type Exec,
  type RestackDeps,
} from '@defrex/autobuild/testing'
import { materializeShippedGit, shippedGitExec, type ShippedGit } from './shipped-git'

/**
 * Kernel Git that runs inside a shell, driven through the dispatcher's exact
 * wiring (`shippedGitExec(spawnExec, git, { PATH })`) with a `PATH` that has
 * no `git`. The shipped tree's `bin/git` is a stand-in that refuses to run
 * without the tree's environment, records its arguments, then hands off to the
 * host Git.
 */
const temporary = temporaryDirectories(afterEach)
const SLUG = 'shell-git'
const HOST_TOOLS = ['sh', 'bash', 'base64', 'mktemp', 'mkdir', 'rm', 'wc', 'dd', 'sha256sum', 'cat']

let hostGit: string
beforeAll(() => {
  const found = Bun.which('git')
  if (!found) throw new Error('these tests need a host git to stand in for the shipped one')
  hostGit = found
})

async function hostRun(args: string[], cwd: string, stdin?: Uint8Array) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`)
  return Buffer.from(stdout)
}
const hostGitText = async (args: string[], cwd: string) =>
  (await hostRun(args, cwd)).toString('utf8').trim()

/** A materialized shipped tree whose `git` checks it got the tree's env. */
async function shippedTree(): Promise<ShippedGit & { calls: () => Promise<string> }> {
  const root = join(await temporary(join(tmpdir(), 'ab-shells-runtime-')), 'abg')
  const source = await temporary(join(tmpdir(), 'ab-shells-bundle-'))
  await mkdir(join(source, 'bin'), { recursive: true })
  await writeFile(
    join(source, 'bin', 'git'),
    [
      '#!/bin/sh',
      `[ "$LD_LIBRARY_PATH" = '${root}/lib' ] && [ "$GIT_EXEC_PATH" = '${root}/libexec/git-core' ] || { echo 'shipped git ran without its tree environment' >&2; exit 97; }`,
      `printf '%s\\n' "$*" >> '${root}/calls'`,
      'unset LD_LIBRARY_PATH GIT_EXEC_PATH GIT_TEMPLATE_DIR',
      `exec '${hostGit}' "$@"`,
      '',
    ].join('\n'),
  )
  const manifest = {
    schema: 1 as const,
    platform: 'linux-x64' as const,
    gitVersion: '2.99.0',
    glibcVersion: '2.34',
    minimumKernel: '3.2.0',
    root,
    git: 'bin/git',
    execPath: 'libexec/git-core',
    lib: 'lib',
    caBundle: 'ssl/ca-bundle.crt',
    files: ['bin/git'],
    executables: ['bin/git'],
    bytes: 1,
  }
  await materializeShippedGit(source, manifest, JSON.stringify(manifest))
  return {
    root,
    manifest,
    calls: () => readFile(join(root, 'calls'), 'utf8').catch(() => ''),
  }
}

/** Host programs the kernel scripts use, without `git`. */
async function toolsWithoutGit(): Promise<string> {
  const directory = await temporary(join(tmpdir(), 'ab-shells-tools-'))
  for (const tool of HOST_TOOLS) {
    const path = Bun.which(tool)
    if (!path) throw new Error(`host ${tool} is required`)
    await symlink(path, join(directory, tool))
  }
  expect(Bun.which('git', { PATH: directory })).toBeNull()
  return directory
}

async function repositories() {
  const source = await temporary(join(tmpdir(), 'ab-shells-source-'))
  const fresh = await temporary(join(tmpdir(), 'ab-shells-fresh-'))
  await hostRun(['init', '-q'], source)
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ])
    await hostRun(['config', key!, value!], source)
  await writeFile(join(source, 'data'), 'base\n')
  await hostRun(['add', '.'], source)
  await hostRun(['commit', '-qm', 'base'], source)
  const base = await hostGitText(['rev-parse', 'HEAD'], source)
  await hostRun(['clone', '-q', '--no-local', source, fresh], source)
  await writeFile(join(source, 'data'), 'base\nhead\n')
  await hostRun(['commit', '-qam', 'head'], source)
  const head = await hostGitText(['rev-parse', 'HEAD'], source)
  return { source, fresh, base, head }
}

async function store() {
  const memory = new MemoryBuildStore()
  await memory.createBuild({
    slug: SLUG,
    repo: 'acme/app',
    branch: `ab/${SLUG}`,
    ticket: { source: 'linear', id: 'ENG-1' },
  })
  return memory
}

function restack(memory: MemoryBuildStore, workspacePath: string, exec: Exec): RestackDeps {
  return { store: memory, slug: SLUG, workspacePath, forge: new FakeForge(), exec }
}

describe('kernel shell Git on a hosted dispatcher', () => {
  async function wiring() {
    const git = await shippedTree()
    const tools = await toolsWithoutGit()
    return { git, tools, exec: shippedGitExec(spawnExec, git, { PATH: tools }) }
  }

  test('the replay pack is retained and restored through the shipped Git', async () => {
    const { git, exec } = await wiring()
    const repos = await repositories()
    const memory = await store()
    await retainReplay(restack(memory, repos.source, exec), repos.head, repos.base)
    expect(await restoreReplay(restack(memory, repos.fresh, exec), repos.head)).toBe(true)
    expect(await hostGitText(['cat-file', '-t', repos.head], repos.fresh)).toBe('commit')
    const calls = await git.calls()
    expect(calls).toContain('pack-objects')
    expect(calls).toContain('index-pack')
  })

  test('a legacy base64 replay unpacks through the shipped Git', async () => {
    const { git, exec } = await wiring()
    const repos = await repositories()
    const memory = await store()
    const pack = await hostRun(
      ['pack-objects', '--stdout', '--revs'],
      repos.source,
      new TextEncoder().encode(`${repos.head}\n^${repos.base}\n`),
    )
    await memory.putArtifact(SLUG, {
      kind: `replay-objects-${repos.head}`,
      content: pack.toString('base64'),
    })
    expect(await restoreReplay(restack(memory, repos.fresh, exec), repos.head)).toBe(true)
    expect(await git.calls()).toContain('unpack-objects')
  })

  test('a replayed commit object is written through the shipped Git', async () => {
    const { git, exec } = await wiring()
    const repos = await repositories()
    const memory = await store()
    await memory.putArtifact(SLUG, {
      kind: `reconcile-change-${repos.head}`,
      content: await hostRun(['cat-file', 'commit', repos.head], repos.source),
    })
    expect(await restoreChange(restack(memory, repos.fresh, exec), repos.head)).toBe(true)
    expect(await hostGitText(['cat-file', '-t', repos.head], repos.fresh)).toBe('commit')
    expect(await git.calls()).toContain('hash-object')
  })

  test('commit preservation restores a replay pack through the shipped Git', async () => {
    const { git, exec } = await wiring()
    const repos = await repositories()
    const pack = await hostRun(
      ['pack-objects', '--stdout', '--revs'],
      repos.source,
      new TextEncoder().encode(`${repos.head}\n^${repos.base}\n`),
    )
    expect(
      await inspectGitCandidate({
        exec,
        workspacePath: repos.fresh,
        sha: repos.head,
        branch: `ab/${SLUG}`,
        archiveRef: `refs/autobuild/archive/${SLUG}`,
        local: true,
        replayPack: pack.toString('base64'),
      }),
    ).toBe(true)
    expect(await git.calls()).toContain('unpack-objects')
  })

  test('without the wiring the same restore reproduces the incident', async () => {
    const { tools, exec } = await wiring()
    const repos = await repositories()
    const memory = await store()
    await retainReplay(restack(memory, repos.source, exec), repos.head, repos.base)
    const bare: Exec = (cmd, opts) => spawnExec(cmd, { ...opts, env: { ...opts.env, PATH: tools } })
    await expect(restoreReplay(restack(memory, repos.fresh, bare), repos.head)).rejects.toThrow(
      /not found/,
    )
  })

  test('a shell keeps the host libraries and still runs host programs beside Git', async () => {
    const { git, exec } = await wiring()
    const result = await exec(
      ['sh', '-c', 'printf "%s\\n" "$LD_LIBRARY_PATH"; printf abc | wc -c; git --version', 'probe'],
      { env: { LD_LIBRARY_PATH: '/host/lib' } },
    )
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe('/host/lib')
    expect(lines[1]!.trim()).toBe('3')
    expect(lines[2]).toStartWith('git version')
    expect(await git.calls()).toContain('--version')
  })

  test('Git failing inside a shell is never the Git-unavailable condition', async () => {
    const { git, exec } = await wiring()
    const repos = await repositories()
    const result = await exec(['sh', '-c', `git cat-file -e ${'de'.repeat(20)}`, 'probe'], {
      cwd: repos.fresh,
    })
    expect(result.exitCode).not.toBe(0)
    expect([126, 127, 97]).not.toContain(result.exitCode)
    expect(kernelGitUnavailableDetail({ result })).toBeUndefined()
    expect(await git.calls()).toContain('cat-file')
  })
})

import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AbEvent } from '../events/catalog'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  readVerifyPipeline,
  resolvePipelineSource,
  type PipelineSourceFailure,
} from './pipeline-source'

const PIPELINE_A = `
[tickets]
source = "file"
readyState = "ready"

[commands]
a = "true"

[verify]
steps = ["a"]
[verify.a]
kind = "check"
command = "a"
`

const PIPELINE_B = `
[tickets]
source = "file"
readyState = "ready"

[commands]
b = "true"

[verify]
steps = ["b"]
[verify.b]
kind = "check"
command = "b"
`

const GIT_ID = [
  '-c',
  'user.email=ab@e2e.invalid',
  '-c',
  'user.name=ab-e2e',
  '-c',
  'commit.gpgsign=false',
]

function provisioned(baseSha: string): AbEvent {
  return {
    build: 'b1',
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    type: 'workspace.provisioned',
    payload: {
      provider: 'git-worktree',
      ref: 'w1',
      branch: 'ab/b1',
      base: { source: 'local', sha: baseSha, remoteError: 'no remote' },
    },
  } as AbEvent
}

async function git(dir: string, args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd: dir })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function committedBase(dir: string): Promise<string> {
  await git(dir, ['init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'autobuild.toml'), PIPELINE_A)
  await git(dir, ['add', '-A'])
  await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'base'])
  return git(dir, ['rev-parse', 'HEAD'])
}

describe('resolvePipelineSource (SPEC §16.1)', () => {
  test('checkout mode reads the build branch head and falls back to base after release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    try {
      const baseSha = await committedBase(dir)

      await git(dir, ['checkout', '-q', '-b', 'ab/b1'])
      await writeFile(join(dir, 'autobuild.toml'), PIPELINE_B)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'head'])
      const headSha = await git(dir, ['rev-parse', 'HEAD'])

      const events = [provisioned(baseSha)]
      const headResult = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events,
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
      })
      expect(headResult?.meta).toEqual({ ref: 'branch-head', commit: headSha })
      expect(headResult?.config.verify.steps).toEqual(['b'])

      // A released workspace deletes the ref but the recorded base survives.
      await git(dir, ['checkout', '-q', 'main'])
      await git(dir, ['branch', '-D', 'ab/b1'])
      const baseResult = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events,
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
      })
      expect(baseResult?.meta).toEqual({ ref: 'base', commit: baseSha })
      expect(baseResult?.config.verify.steps).toEqual(['a'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('checkout mode tracks clean, dirty and malformed workspace transitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    const workspace = await mkdtemp(join(tmpdir(), 'ab-workspace-'))
    try {
      const baseSha = await committedBase(dir)
      await git(dir, ['checkout', '-q', '-b', 'ab/b1'])
      await writeFile(join(dir, 'autobuild.toml'), PIPELINE_B)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'head'])
      const headSha = await git(dir, ['rev-parse', 'HEAD'])
      await git(dir, ['worktree', 'add', '--detach', '-q', workspace, 'ab/b1'])

      // The workspace carries the head commit's content: provenance is
      // exactly the branch-head commit, as before this change.
      await writeFile(join(workspace, 'autobuild.toml'), PIPELINE_B)
      const result = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned(baseSha)],
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
        workspacePath: workspace,
      })
      expect(result?.meta).toEqual({ ref: 'branch-head', commit: headSha })
      expect(result?.config.verify.steps).toEqual(['b'])

      // The workspace file differs from the committed head: dirty. The
      // provenance must not attribute worktree bytes to the branch-head
      // commit — it records `worktree-dirty` with no commit at all.
      await writeFile(join(workspace, 'autobuild.toml'), PIPELINE_A)
      const dirtyResult = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned(baseSha)],
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
        workspacePath: workspace,
      })
      expect(dirtyResult?.meta).toEqual({ ref: 'worktree-dirty' })
      expect(dirtyResult?.meta).not.toHaveProperty('commit')
      expect(dirtyResult?.config.verify.steps).toEqual(['a'])

      // The build's own (dirty) worktree carries an unparseable pipeline: the
      // recorded base is not the build's pipeline either, so the resolver
      // degrades to undefined with an actionable branch-source failure.
      await writeFile(join(workspace, 'autobuild.toml'), 'not = [valid toml')
      const failures: PipelineSourceFailure[] = []
      const malformed = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned(baseSha)],
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
        workspacePath: workspace,
        onFailure: (failure) => failures.push(failure),
      })
      expect(malformed).toBeUndefined()
      expect(failures.some((failure) => failure.kind === 'branch-source')).toBe(true)
      expect(failures.some((failure) => failure.detail.includes('worktree-dirty'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('a clean worktree stays clean under eol conversion (core.autocrlf)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    const workspace = await mkdtemp(join(tmpdir(), 'ab-workspace-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      // With autocrlf the worktree file carries CRLF while the stored blob is
      // LF-normalized: a byte comparison against `git show` output would call
      // this clean worktree dirty. The git-normalized comparison (the blob's
      // oid vs the worktree file hashed through the same clean conversion)
      // must keep the branch-head attribution.
      await git(dir, ['config', 'core.autocrlf', 'true'])
      await writeFile(join(dir, 'autobuild.toml'), PIPELINE_A)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'base'])
      const baseSha = await git(dir, ['rev-parse', 'HEAD'])
      await git(dir, ['checkout', '-q', '-b', 'ab/b1'])
      await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'head'])
      const headSha = await git(dir, ['rev-parse', 'HEAD'])
      await git(dir, ['worktree', 'add', '--detach', '-q', workspace, 'ab/b1'])

      await writeFile(join(workspace, 'autobuild.toml'), PIPELINE_A.replace(/\n/g, '\r\n'))
      const result = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned(baseSha)],
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
        workspacePath: workspace,
      })
      expect(result?.meta).toEqual({ ref: 'branch-head', commit: headSha })
      expect(result?.config.verify.steps).toEqual(['a'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('a worktree file that was never committed degrades to worktree-dirty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    const workspace = await mkdtemp(join(tmpdir(), 'ab-workspace-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      // An empty root commit: the branch head's tree never carried
      // autobuild.toml, so the committed-blob read (`rev-parse head:path`)
      // fails. The comparison must degrade to dirty — not crash, not fall
      // through to the committed-ref or base fallback.
      await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'base'])
      const baseSha = await git(dir, ['rev-parse', 'HEAD'])
      await git(dir, ['checkout', '-q', '-b', 'ab/b1'])
      await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'head'])
      await git(dir, ['worktree', 'add', '--detach', '-q', workspace, 'ab/b1'])

      await writeFile(join(workspace, 'autobuild.toml'), PIPELINE_B)
      const result = await resolvePipelineSource({
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned(baseSha)],
        mode: 'checkout',
        checkout: dir,
        exec: spawnExec,
        workspacePath: workspace,
      })
      expect(result?.meta).toEqual({ ref: 'worktree-dirty' })
      expect(result?.config.verify.steps).toEqual(['b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('repeated launches on a legacy landing branch resolve without writing a deprecation', async () => {
    const legacy = `landing = []\n${PIPELINE_A}`
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await writeFile(join(dir, 'autobuild.toml'), legacy)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'legacy'])
      for (let read = 0; read < 2; read++)
        expect((await readVerifyPipeline(dir, spawnExec)).config.verify.steps).toEqual(['a'])
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

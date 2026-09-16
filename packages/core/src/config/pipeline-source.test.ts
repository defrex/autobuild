import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AbEvent } from '../events/catalog'
import { FakeForge } from '../ports/forge/fake'
import { spawnExec } from '../ports/workspace/git-worktree'
import { isPipelineSourceRef, recordedBaseSha, resolvePipelineSource } from './pipeline-source'

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

describe('resolvePipelineSource (SPEC §16.1)', () => {
  test('origin mode reads the build branch head through the forge', async () => {
    const forge = new FakeForge()
    forge.seedBranch('ab/b1', 'head1')
    forge.seedFile('head1', 'autobuild.toml', PIPELINE_B)
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
    })
    expect(result?.meta).toEqual({ ref: 'branch-head', commit: 'head1' })
    expect(result?.config.verify.steps).toEqual(['b'])
  })

  test('origin mode falls back to the recorded base commit when the branch is unpublished', async () => {
    const forge = new FakeForge()
    forge.seedFile('base1', 'autobuild.toml', PIPELINE_A)
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
    })
    expect(result?.meta).toEqual({ ref: 'base', commit: 'base1' })
    expect(result?.config.verify.steps).toEqual(['a'])
  })

  test('origin mode degrades to the legacy fallback when nothing is readable', async () => {
    const forge = new FakeForge()
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
    })
    expect(result).toBeUndefined()
  })

  test('a malformed build-branch file never escapes the resolver', async () => {
    const forge = new FakeForge()
    forge.seedBranch('ab/b1', 'head1')
    forge.seedFile('head1', 'autobuild.toml', 'not = [valid toml')
    forge.seedFile('base1', 'autobuild.toml', PIPELINE_A)
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
    })
    // The unparseable branch head is rejected and the recorded base is used.
    expect(result?.meta).toEqual({ ref: 'base', commit: 'base1' })
  })

  test('checkout mode reads the build branch head and falls back to base after release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await writeFile(join(dir, 'autobuild.toml'), PIPELINE_A)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'base'])
      const baseSha = await git(dir, ['rev-parse', 'HEAD'])

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

  test('checkout mode prefers the open workspace file over the committed ref read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pipeline-'))
    const workspace = await mkdtemp(join(tmpdir(), 'ab-workspace-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await writeFile(join(dir, 'autobuild.toml'), PIPELINE_A)
      await git(dir, ['add', '-A'])
      await git(dir, [...GIT_ID, 'commit', '-q', '-m', 'base'])
      const baseSha = await git(dir, ['rev-parse', 'HEAD'])
      await git(dir, ['checkout', '-q', '-b', 'ab/b1'])
      await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'head'])
      const headSha = await git(dir, ['rev-parse', 'HEAD'])

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
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('re-resolving sees a pipeline change published to the build branch (next launch)', async () => {
    const forge = new FakeForge()
    forge.seedBranch('ab/b1', 'head1')
    forge.seedFile('head1', 'autobuild.toml', PIPELINE_A)
    const input = {
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin' as const,
      forge,
    }
    expect((await resolvePipelineSource(input))?.config.verify.steps).toEqual(['a'])

    // The build publishes a pipeline change to its own branch. The next launch
    // re-resolves (the dispatcher calls this per launch), so it adopts the new
    // universe without any base-branch involvement.
    forge.seedBranch('ab/b1', 'head2')
    forge.seedFile('head2', 'autobuild.toml', PIPELINE_B)
    const next = await resolvePipelineSource(input)
    expect(next?.meta).toEqual({ ref: 'branch-head', commit: 'head2' })
    expect(next?.config.verify.steps).toEqual(['b'])
  })

  test('recordedBaseSha takes the newest provisioned workspace', () => {
    const events = [provisioned('first'), provisioned('second')]
    expect(recordedBaseSha(events)).toBe('second')
    expect(recordedBaseSha([])).toBeUndefined()
  })

  test('isPipelineSourceRef narrows only the declared refs', () => {
    expect(isPipelineSourceRef('branch-head')).toBe(true)
    expect(isPipelineSourceRef('base')).toBe(true)
    expect(isPipelineSourceRef('legacy-fallback')).toBe(true)
    expect(isPipelineSourceRef('elsewhere')).toBe(false)
    expect(isPipelineSourceRef(3)).toBe(false)
  })
})

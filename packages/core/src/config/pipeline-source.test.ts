import { describe, expect, spyOn, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { FakeForge } from '../ports/forge/fake'
import {
  isActionablePipelineFailure,
  isPipelineSourceRef,
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

describe('resolvePipelineSource origin and refs', () => {
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
    const failures: PipelineSourceFailure[] = []
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
      onFailure: (failure) => failures.push(failure),
    })
    // The build's own branch exists but carries an unparseable pipeline, so
    // the recorded base is not its pipeline either (AUT-366 by another door):
    // the resolver degrades to undefined and the caller keeps the build's
    // last good deposit, naming the failed parse.
    expect(result).toBeUndefined()
    expect(failures.some((failure) => failure.kind === 'branch-source')).toBe(true)
  })

  test('a malformed recorded-base file degrades to the legacy fallback with a reason', async () => {
    const forge = new FakeForge()
    forge.seedFile('base1', 'autobuild.toml', 'not = [valid toml')
    const failures: PipelineSourceFailure[] = []
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
      onFailure: (failure) => failures.push(failure),
    })
    expect(result).toBeUndefined()
    expect(failures.some((failure) => failure.kind === 'base-source')).toBe(true)
  })

  test('failed origin reads surface reasons but keep the base/legacy fallback', async () => {
    const forge = new FakeForge()
    forge.seedBranch('ab/b1', 'head1')
    const failures: PipelineSourceFailure[] = []
    const result = await resolvePipelineSource({
      slug: 'b1',
      record: { branch: 'ab/b1' },
      events: [provisioned('base1')],
      mode: 'origin',
      forge,
      onFailure: (failure) => failures.push(failure),
    })
    // Branch head resolves but the file read fails (actionable); no base file
    // seeded either (legacy fallback).
    expect(result).toBeUndefined()
    expect(failures.some((failure) => failure.kind === 'branch-source')).toBe(true)
    expect(failures.some((failure) => failure.kind === 'base-source')).toBe(true)
    // An unpublished branch alone is normal resolution order, not actionable.
    expect(isActionablePipelineFailure({ kind: 'unpublished', detail: 'x' })).toBe(false)
    expect(isActionablePipelineFailure({ kind: 'base-source', detail: 'x' })).toBe(false)
    expect(isActionablePipelineFailure({ kind: 'no-base', detail: 'x' })).toBe(false)
    expect(isActionablePipelineFailure({ kind: 'capability', detail: 'x' })).toBe(true)
    expect(isActionablePipelineFailure({ kind: 'branch-source', detail: 'x' })).toBe(true)
    expect(isActionablePipelineFailure({ kind: 'store', detail: 'x' })).toBe(true)
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

  test('isPipelineSourceRef narrows only the declared refs', () => {
    expect(isPipelineSourceRef('branch-head')).toBe(true)
    expect(isPipelineSourceRef('base')).toBe(true)
    expect(isPipelineSourceRef('legacy-fallback')).toBe(true)
    expect(isPipelineSourceRef('worktree-dirty')).toBe(true)
    expect(isPipelineSourceRef('elsewhere')).toBe(false)
    expect(isPipelineSourceRef(3)).toBe(false)
  })

  test('repeated launches on a legacy landing branch resolve without writing a deprecation', async () => {
    const legacy = `landing = []\n${PIPELINE_A}`
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const forge = new FakeForge()
      forge.seedBranch('ab/b1', 'head1')
      forge.seedFile('head1', 'autobuild.toml', legacy)
      forge.seedFile('base1', 'autobuild.toml', legacy)
      const input = {
        slug: 'b1',
        record: { branch: 'ab/b1' },
        events: [provisioned('base1')],
        mode: 'origin' as const,
        forge,
      }
      for (let launch = 0; launch < 3; launch++) {
        const result = await resolvePipelineSource(input)
        expect(result?.meta).toEqual({ ref: 'branch-head', commit: 'head1' })
        expect(result?.config.verify.steps).toEqual(['a'])
      }
      const base = await resolvePipelineSource({ ...input, record: { branch: 'ab/unpublished' } })
      expect(base?.meta).toEqual({ ref: 'base', commit: 'base1' })

      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})

/**
 * Scripted-exec tests for the git-worktree adapter: error shapes git cannot
 * produce on demand, and input validation that refuses before any IO. Real
 * git behavior lives in git-worktree.integration.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { GitError, GitWorktreeProvider, type Exec } from './git-worktree'

const ROOT = '/worktrees'
const SHA = 'a'.repeat(40)

/** Scripted exec: records every command and answers through `reply`. */
function scripted(
  reply: (cmd: string[]) => { stdout?: string; stderr?: string; exitCode: number },
) {
  const calls: string[][] = []
  const exec: Exec = async (cmd) => {
    calls.push([...cmd])
    const { stdout = '', stderr = '', exitCode } = reply(cmd)
    return { stdout, stderr, exitCode }
  }
  return { calls, exec }
}

/** Any IO attempt fails the test loudly. */
const noExec: Exec = async (cmd) => {
  throw new Error(`unexpected exec: ${cmd.join(' ')}`)
}

const handle = (path: string) => ({
  provider: 'git-worktree',
  ref: path,
  path,
  branch: 'ab/scripted',
})

describe('GitWorktreeProvider (scripted exec)', () => {
  test('release fails typed when rev-parse --git-common-dir succeeds with empty stdout', async () => {
    // discoverRepo guards the same degenerate-input shape as
    // excludeProvisioningMarker: a successful rev-parse with empty stdout
    // would feed '' into resolve(path, …) and target the worktree directory
    // itself, misdirecting the subsequent worktree remove. The chosen posture
    // is failing loudly (GitError, matching shaFrom's empty-SHA guard) rather
    // than the release-is-a-no-op null return.
    const path = '/worktrees/ab-empty-common-dir'
    const { calls, exec } = scripted((cmd) =>
      cmd.at(-1) === '--git-common-dir' ? { exitCode: 0 } : { exitCode: 0, stdout: 'unexpected' },
    )
    const error = await new GitWorktreeProvider({ root: ROOT, exec })
      .release(handle(path))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GitError)
    // Exact pin: shaFrom's guard uses the same synthesized stderr tail. A
    // future edit to either message must move both implementations together
    // and update this pin.
    expect((error as Error).message).toBe(
      `git -C ${resolve(path)} rev-parse --git-common-dir exited 1: git returned no common directory`,
    )
    // The guard fired before any side effect: no worktree remove was issued.
    expect(calls.some((cmd) => cmd.includes('remove'))).toBe(false)
  })

  test('git failures surface stderr in the thrown error', async () => {
    const { exec } = scripted(() => ({ stderr: 'fatal: disk on fire', exitCode: 128 }))
    const broken = new GitWorktreeProvider({ root: ROOT, exec })
    await expect(
      broken.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/feature-6' }),
    ).rejects.toThrow(/disk on fire/)
  })

  test('release rethrows unexpected worktree-remove failures', async () => {
    const { exec } = scripted((cmd) => {
      if (cmd.at(-1) === '--git-common-dir') return { stdout: '/repo/.git\n', exitCode: 0 }
      if (cmd.includes('remove')) return { stderr: 'fatal: worktree is locked', exitCode: 128 }
      return { exitCode: 0 }
    })
    const provider = new GitWorktreeProvider({ root: ROOT, exec })
    await expect(provider.release(handle('/worktrees/ab-feature-7'))).rejects.toThrow(
      /worktree is locked/,
    )
  })

  test('the build-path publication discriminator is untouched; the sandbox seam exists', () => {
    const provider = new GitWorktreeProvider({ root: ROOT, exec: noExec })
    expect((provider as unknown as { publication?: unknown }).publication).toBeUndefined()
    expect(provider.sandboxPublication).toBeDefined()
  })

  test('sandboxPublication validates input shapes and a missing ref', async () => {
    const publication = new GitWorktreeProvider({ root: ROOT, exec: noExec }).sandboxPublication!
    await expect(
      publication.publish({ ref: '/sandbox', sha: 'nothash', branch: 'ab/orch-ops-x' }),
    ).rejects.toThrow(/exact commit SHA/)
    await expect(
      publication.publish({ ref: '/sandbox', sha: SHA, branch: 'main' }),
    ).rejects.toThrow(/canonical build branch/)
    // The git-worktree probe is workspace-anchored: without a ref it cannot
    // run, and the service always supplies one.
    await expect(publication.isPublished!({ sha: SHA, branch: 'ab/orch-ops-x' })).rejects.toThrow(
      /workspace ref/,
    )
  })
})

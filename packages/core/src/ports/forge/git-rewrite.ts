import type { ForgeRewrite, RewriteResult } from '../types'
import type { Exec } from '../workspace/git-worktree'
import { isValidGitBranchName } from '../../kernel/origin'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
function object(value: string): void {
  if (!oid.test(value)) throw new Error(`rewrite requires an exact object id: ${value}`)
}
function branchRef(branch: string): string {
  if (!isValidGitBranchName(branch) || !branch.startsWith('ab/'))
    throw new Error(`rewrite requires a build branch: ${branch}`)
  return `refs/heads/${branch}`
}

/** Git transport and shared-database implementations share validation, but local-git
 * never consults a remote, even when the repository happens to have one. */
export function gitRewrite(exec: Exec, local: boolean): ForgeRewrite {
  async function git(cwd: string, args: string[], allowFailure = false) {
    const result = await exec(['git', ...args], { cwd })
    if (!allowFailure && result.exitCode !== 0)
      throw new Error(
        `reconcile git ${args.join(' ')} failed: ${result.stderr || result.stdout}; enable refs/autobuild/archive/ publication and guarded build-branch rewrites`,
      )
    return result
  }
  async function read(cwd: string, ref: string): Promise<string | null> {
    const result = await git(
      cwd,
      local ? ['rev-parse', '--verify', '--quiet', ref] : ['ls-remote', '--refs', 'origin', ref],
      true,
    )
    if (local && result.exitCode === 1) return null
    if (result.exitCode !== 0) throw new Error(`cannot read ${ref}: ${result.stderr}`)
    const sha = result.stdout.trim().split(/\s+/)[0]
    if (!sha) return null
    object(sha)
    return sha
  }
  return {
    async snapshot(input) {
      const ref = branchRef(input.branch)
      if (!/^refs\/autobuild\/reconcile\/[a-z0-9-]+\/[a-z0-9/-]+$/.test(input.destinationRef))
        throw new Error('snapshot requires a build-private reconcile ref')
      if (local) {
        const sha = await read(input.workspacePath, ref)
        if (sha === null)
          throw new Error(`build branch ${ref} was deleted; restore it before reconciling`)
        await git(input.workspacePath, ['update-ref', input.destinationRef, sha])
        return sha
      }
      await git(input.workspacePath, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+${ref}:${input.destinationRef}`,
      ])
      const result = await git(input.workspacePath, [
        'rev-parse',
        '--verify',
        `${input.destinationRef}^{commit}`,
      ])
      const sha = result.stdout.trim()
      object(sha)
      return sha
    },
    async archive(input) {
      object(input.sha)
      if (
        !/^refs\/autobuild\/archive\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9a-f]+$/.test(input.ref) ||
        !input.ref.endsWith(`/${input.sha}`)
      )
        throw new Error(`invalid immutable archive ref: ${input.ref}`)
      const existing = await read(input.workspacePath, input.ref)
      if (existing !== null && existing !== input.sha)
        throw new Error(`immutable archive ${input.ref} names ${existing}, expected ${input.sha}`)
      if (existing === null) {
        const result = await git(
          input.workspacePath,
          local
            ? ['update-ref', input.ref, input.sha, '0'.repeat(input.sha.length)]
            : ['push', `--force-with-lease=${input.ref}:`, 'origin', `${input.sha}:${input.ref}`],
          true,
        )
        // An uncertain acknowledgement is adopted only after an exact readback.
        if ((await read(input.workspacePath, input.ref)) !== input.sha)
          throw new Error(
            `archive publication rejected for ${input.ref}: ${result.stderr}; enable refs/autobuild/archive/ publication before branch rewrites`,
          )
      }
      if (!local) {
        // Fetch by the exact archive ref, never by an unadvertised object id.
        await git(input.workspacePath, [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          'origin',
          input.ref,
        ])
      }
      await git(input.workspacePath, ['cat-file', '-e', `${input.sha}^{commit}`])
    },
    async replace(input): Promise<RewriteResult> {
      object(input.expected)
      object(input.sha)
      const ref = branchRef(input.branch)
      const actual = await read(input.workspacePath, ref)
      async function acknowledge(): Promise<RewriteResult> {
        if (!local) {
          const localHead = await git(
            input.workspacePath,
            ['rev-parse', '--verify', '--quiet', ref],
            true,
          )
          if (localHead.exitCode === 0 && localHead.stdout.trim() !== input.sha)
            await git(input.workspacePath, [
              'update-ref',
              ref,
              input.sha,
              input.localExpected ?? input.expected,
            ])
        }
        return { kind: 'published' }
      }
      if (actual === input.sha) return acknowledge()
      if (actual !== input.expected) return { kind: 'lease-mismatch', actual }
      const result = await git(
        input.workspacePath,
        local
          ? ['update-ref', ref, input.sha, input.expected]
          : [
              'push',
              `--force-with-lease=${ref}:${input.expected}`,
              'origin',
              `${input.sha}:${ref}`,
            ],
        true,
      )
      const after = await read(input.workspacePath, ref)
      if (after === input.sha) return acknowledge()
      if (after !== input.expected) return { kind: 'lease-mismatch', actual: after }
      throw new Error(
        `guarded rewrite rejected for ${ref}: ${result.stderr}; enable guarded build-branch rewrites`,
      )
    },
  }
}

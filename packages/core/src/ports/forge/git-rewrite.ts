import { ForgeRequestDeferred } from '../forge-request-context'
import { classifyGitNetworkFailure, isForgeFailure } from '../forge-failure'
import type { ForgeRewrite, RewriteResult } from '../types'
import type { Exec } from '../workspace/git-worktree'
import { isValidGitBranchName } from '../../kernel/origin'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
function object(value: string): void {
  if (!oid.test(value)) throw new Error(`rewrite requires an exact object id: ${value}`)
}
function branchRef(branch: string): string {
  if (!isValidGitBranchName(branch) || !/^(?:ab|ab-node)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch))
    throw new Error(`rewrite requires a build branch: ${branch}`)
  return `refs/heads/${branch}`
}

/** Git transport and shared-database implementations share validation, but local-git
 * never consults a remote, even when the repository happens to have one. */
export function gitRewrite(
  exec: Exec,
  local: boolean,
  createArchive?: (ref: string, sha: string) => Promise<void>,
): ForgeRewrite {
  async function git(cwd: string, args: string[], allowFailure = false) {
    const network = !local && ['push', 'fetch', 'ls-remote'].includes(args[0] ?? '')
    let result: Awaited<ReturnType<Exec>>
    try {
      result = await exec(['git', ...args], { cwd })
    } catch (error) {
      throw network ? classifyGitNetworkFailure(error) : error
    }
    if (network && result.exitCode !== 0) {
      const original = new Error(result.stderr || result.stdout)
      const classified = classifyGitNetworkFailure(original)
      if (classified !== original) throw classified
    }
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
    if (local) {
      const sha = result.stdout.trim()
      object(sha)
      return sha
    }
    return parseRemoteHead(result.stdout, ref)
  }
  return {
    async fastForward(input) {
      object(input.expected)
      object(input.sha)
      if (!isValidGitBranchName(input.branch)) throw new Error('invalid fast-forward destination')
      const ref = `refs/heads/${input.branch}`
      const actual = await read(input.workspacePath, ref)
      if (actual === input.sha) {
        if (!local) await refreshBranchCache(exec, input.workspacePath, input.branch, input.sha)
        return { kind: 'published' }
      }
      if (actual !== input.expected) return { kind: 'lease-mismatch', actual }
      const ancestry = await git(
        input.workspacePath,
        ['merge-base', '--is-ancestor', input.expected, input.sha],
        true,
      )
      if (ancestry.exitCode !== 0) throw new Error('publication is not a fast-forward')
      const result = await git(
        input.workspacePath,
        local
          ? ['update-ref', ref, input.sha, input.expected]
          : [
              'push',
              '--porcelain',
              `--force-with-lease=${ref}:${input.expected}`,
              'origin',
              `${input.sha}:${ref}`,
            ],
        true,
      )
      const after = await read(input.workspacePath, ref)
      if (after === input.sha) {
        if (!local) await refreshBranchCache(exec, input.workspacePath, input.branch, input.sha)
        return { kind: 'published' }
      }
      return {
        kind: 'lease-mismatch',
        actual: after,
        ...(result.exitCode === 0 ? { rewritten: true } : {}),
      }
    },
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
        '--refmap=',
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
      const missing =
        !local &&
        (await git(input.workspacePath, ['cat-file', '-e', `${input.sha}^{commit}`], true))
          .exitCode !== 0
      if (existing === null) {
        let failure: unknown
        try {
          if (missing) {
            if (!createArchive)
              throw new Error('remote archive creation is unavailable in this adapter')
            await createArchive(input.ref, input.sha)
          } else {
            const result = await git(
              input.workspacePath,
              local
                ? ['update-ref', input.ref, input.sha, '0'.repeat(input.sha.length)]
                : [
                    'push',
                    `--force-with-lease=${input.ref}:`,
                    'origin',
                    `${input.sha}:${input.ref}`,
                  ],
              true,
            )
            if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
          }
        } catch (error) {
          failure = error
        }
        // Mutation acknowledgement alone is never proof, including API races.
        let confirmed: string | null
        try {
          confirmed = await read(input.workspacePath, input.ref)
        } catch (error) {
          if (isForgeFailure(failure) || failure instanceof ForgeRequestDeferred) throw failure
          throw error
        }
        if (confirmed !== input.sha) {
          if (isForgeFailure(failure) || failure instanceof ForgeRequestDeferred) throw failure
          throw new Error(
            `archive publication rejected for ${input.ref} at ${input.sha}: ${String(failure ?? 'exact readback did not confirm publication')}; enable refs/autobuild/archive/ publication before branch rewrites`,
            { cause: failure },
          )
        }
      }
      if (!local) {
        // Fetch by the exact archive ref, never by an unadvertised object id.
        await git(input.workspacePath, [
          'fetch',
          ...(missing ? ['--depth=1', '--refmap='] : []),
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
          await refreshBranchCache(exec, input.workspacePath, input.branch, input.sha)
        }
        // Replay stays detached until the guarded branch update is confirmed.
        // Reattach only its exact workspace result; explicit-source callers may
        // legitimately publish an object other than their checked-out HEAD.
        const workspaceHead = await git(input.workspacePath, ['rev-parse', 'HEAD'])
        if (!input.branch.startsWith('ab-node/') && workspaceHead.stdout.trim() === input.sha)
          await git(input.workspacePath, ['checkout', '--no-guess', input.branch])
        return { kind: 'published' }
      }
      async function mismatch(observed: string | null): Promise<RewriteResult> {
        return { kind: 'lease-mismatch', actual: observed }
      }
      if (actual === input.sha) return acknowledge()
      if (actual !== input.expected) return mismatch(actual)
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
      // A successful CAS is a fact even if its candidate is overtaken before
      // readback. Callers record that rewrite, then replay the observed head.
      if (result.exitCode === 0) return { kind: 'lease-mismatch', actual: after, rewritten: true }
      if (after !== input.expected) return mismatch(after)
      throw new Error(
        `guarded rewrite rejected for ${ref}: ${result.stderr}; enable guarded build-branch rewrites`,
      )
    },
  }
}

/** A successful transport read is either an exact advertised ref or absence. */
export function parseRemoteHead(stdout: string, ref: string): string | null {
  const lines = stdout.trim() === '' ? [] : stdout.trim().split('\n')
  if (lines.length === 0) return null
  if (lines.length !== 1) throw new Error(`ambiguous remote head for ${ref}`)
  const fields = lines[0]!.split(/\s+/)
  if (fields.length !== 2 || fields[1] !== ref || !oid.test(fields[0]!))
    throw new Error(`invalid remote head for ${ref}`)
  return fields[0]!
}

export async function remoteBranchHead(
  exec: Exec,
  cwd: string,
  branch: string,
): Promise<string | null> {
  if (!isValidGitBranchName(branch)) throw new Error('invalid publication branch')
  const ref = `refs/heads/${branch}`
  const result = await exec(['git', 'ls-remote', '--refs', 'origin', ref], { cwd })
  if (result.exitCode !== 0) throw new Error(`cannot read ${ref}: ${result.stderr}`)
  return parseRemoteHead(result.stdout, ref)
}

/** Confirmed remote-backed refs are caches; never touch checkout contents. */
export async function refreshBranchCache(
  exec: Exec,
  cwd: string,
  branch: string,
  sha: string,
): Promise<void> {
  object(sha)
  if (!isValidGitBranchName(branch)) throw new Error('invalid publication branch')
  const run = async (args: string[]) => {
    const network = ['push', 'fetch', 'ls-remote'].includes(args[0] ?? '')
    let result: Awaited<ReturnType<Exec>>
    try {
      result = await exec(['git', ...args], { cwd })
    } catch (error) {
      throw network ? classifyGitNetworkFailure(error) : error
    }
    if (network && result.exitCode !== 0) {
      const original = new Error(result.stderr || result.stdout)
      const classified = classifyGitNetworkFailure(original)
      if (classified !== original) throw classified
    }
    if (result.exitCode !== 0)
      throw new Error(`publication cache ${args.join(' ')} failed: ${result.stderr}`)
  }
  if ((await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd })).exitCode !== 0)
    await run([
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      'origin',
      `refs/heads/${branch}`,
    ])
  await run(['update-ref', `refs/heads/${branch}`, sha])
}

/** Ordinary publication is fast-forward only, with exact frozen input and readback. */
export async function publishBranch(
  exec: Exec,
  cwd: string,
  branch: string,
  intended?: string,
): Promise<void> {
  const sha =
    intended ??
    (await exec(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], { cwd })).stdout.trim()
  object(sha)
  if ((await remoteBranchHead(exec, cwd, branch)) !== sha) {
    const result = await exec(['git', 'push', 'origin', `${sha}:refs/heads/${branch}`], { cwd })
    if ((await remoteBranchHead(exec, cwd, branch)) !== sha)
      throw new Error(`publication did not confirm ${sha}: ${result.stderr}`)
  }
  await refreshBranchCache(exec, cwd, branch, sha)
}

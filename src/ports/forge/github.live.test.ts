import { describe } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeForgeContract,
  type ForgeContractFactory,
} from './contract'
import {
  bunExec,
  GitHubForge,
  rulesetsHaveMergeGate,
  type ExecResult,
} from './github'

const GIT_ID = [
  '-c',
  'user.email=ab-contract@test.invalid',
  '-c',
  'user.name=ab-port-contract',
  '-c',
  'commit.gpgsign=false',
]

function nonblank(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!nonblank(value)) {
    throw new Error(
      `GitHub live Forge contract requires ${name} once ` +
        'AB_RUN_LIVE_PORT_CONTRACTS=1 and a GitHub token are set',
    )
  }
  return value.trim()
}

async function execute(cmd: string[], cwd: string): Promise<ExecResult> {
  return bunExec(cmd, { cwd })
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const result = await execute(cmd, cwd)
  if (result.exitCode !== 0) {
    throw new Error(
      `GitHub contract fixture command failed (exit ${result.exitCode}): ` +
        `${cmd.join(' ')}\n${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}

function parseJson<T>(stdout: string, context: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch (error) {
    throw new Error(`${context}: invalid JSON — ${String(error)}`)
  }
}

interface PrProbe {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  headRefOid: string
  autoMergeRequest: { enabledAt: string } | null
  mergeCommit: { oid: string } | null
  comments: { nodes: Array<{ body: string }> }
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (ready(last)) return last
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(1_000)
  }
  const detail =
    lastError instanceof Error
      ? lastError.message
      : last === undefined
        ? String(lastError ?? 'no response')
        : JSON.stringify(last)
  throw new Error(`timed out waiting for ${label}; last observation: ${detail}`)
}

const githubForgeContractFactory: ForgeContractFactory = async (opts = {}) => {
  const repoSlug = requiredEnv('AB_GITHUB_CONTRACT_REPO')
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repoSlug)
  if (!match) {
    throw new Error(
      'AB_GITHUB_CONTRACT_REPO must be an owner/name scratch repository',
    )
  }
  const owner = match[1]!
  const name = match[2]!
  const tmp = await mkdtemp(join(tmpdir(), 'ab-github-forge-contract-'))
  const workspacePath = join(tmp, 'repo')
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
  const base = `ab-contract-${suffix}-base`
  const head = `ab-contract-${suffix}-head`
  const protectionEndpoint =
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/` +
    `${encodeURIComponent(base)}/protection`
  const trackedPrs = new Set<number>()
  let cloneReady = false
  let protectionInstalled = false

  const ghApi = async (args: string[]): Promise<string> =>
    run(['gh', 'api', ...args], cloneReady ? workspacePath : tmp)

  const prProbe = async (number: number): Promise<PrProbe> => {
    const query = [
      'query($owner:String!,$name:String!,$number:Int!){',
      'repository(owner:$owner,name:$name){',
      'pullRequest(number:$number){',
      'state mergeable mergeStateStatus headRefOid',
      'autoMergeRequest{enabledAt} mergeCommit{oid}',
      'comments(last:100){nodes{body}}',
      '}',
      '}',
      '}',
    ].join(' ')
    const payload = parseJson<{
      data?: { repository?: { pullRequest?: PrProbe | null } | null }
      errors?: Array<{ message?: string }>
    }>(
      await ghApi([
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ]),
      `GitHub PR #${number} probe`,
    )
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(
        `GitHub PR #${number} probe errors: ${payload.errors
          .map((error) => error.message ?? JSON.stringify(error))
          .join('; ')}`,
      )
    }
    const pr = payload.data?.repository?.pullRequest
    if (!pr) throw new Error(`GitHub PR #${number} probe returned no PR`)
    return pr
  }

  const directStates = new Set(['BEHIND', 'CLEAN', 'UNSTABLE'])
  const waitForMergeable = (number: number): Promise<PrProbe> =>
    waitFor(
      `PR #${number} to become mergeable`,
      () => prProbe(number),
      (pr) =>
        pr.state === 'OPEN' &&
        pr.mergeable === 'MERGEABLE' &&
        (opts.gated === true || directStates.has(pr.mergeStateStatus)),
    )

  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const number of trackedPrs) {
      try {
        const pr = await prProbe(number)
        if (pr.state === 'OPEN' && pr.autoMergeRequest !== null) {
          const disabled = await execute(
            ['gh', 'pr', 'merge', String(number), '--disable-auto'],
            workspacePath,
          )
          if (disabled.exitCode !== 0) {
            failures.push(
              new Error(
                `GitHub cleanup could not disable auto-merge on #${number}: ` +
                  disabled.stderr.trim(),
              ),
            )
          }
        }
        if (pr.state === 'OPEN') {
          const closed = await execute(
            [
              'gh',
              'api',
              `repos/${owner}/${name}/pulls/${number}`,
              '--method',
              'PATCH',
              '-f',
              'state=closed',
            ],
            workspacePath,
          )
          if (closed.exitCode !== 0) {
            failures.push(
              new Error(
                `GitHub cleanup could not close PR #${number}: ${closed.stderr.trim()}`,
              ),
            )
          }
        }
      } catch (error) {
        failures.push(error)
      }
    }

    if (protectionInstalled && cloneReady) {
      const removed = await execute(
        ['gh', 'api', protectionEndpoint, '--method', 'DELETE'],
        workspacePath,
      )
      if (removed.exitCode !== 0 && !/404|not found/i.test(removed.stderr)) {
        failures.push(
          new Error(
            `GitHub cleanup could not remove ${base} protection: ${removed.stderr.trim()}`,
          ),
        )
      }
      protectionInstalled = false
    }

    if (cloneReady) {
      for (const branch of [head, base]) {
        const deleted = await execute(
          ['git', 'push', 'origin', '--delete', branch],
          workspacePath,
        )
        if (
          deleted.exitCode !== 0 &&
          !/remote ref does not exist|unable to delete/i.test(deleted.stderr)
        ) {
          failures.push(
            new Error(
              `GitHub cleanup could not delete ${branch}: ${deleted.stderr.trim()}`,
            ),
          )
        }
      }
    }
    await rm(tmp, { recursive: true, force: true })
    if (failures.length > 0) {
      throw new AggregateError(failures, 'GitHub contract cleanup failed')
    }
  }

  try {
    const setupQuery = [
      'query($owner:String!,$name:String!){',
      'repository(owner:$owner,name:$name){',
      'nameWithOwner viewerPermission autoMergeAllowed defaultBranchRef{name}',
      '}',
      '}',
    ].join(' ')
    const setup = parseJson<{
      data?: {
        repository?: {
          nameWithOwner: string
          viewerPermission: string
          autoMergeAllowed: boolean
          defaultBranchRef: { name: string } | null
        } | null
      }
      errors?: Array<{ message?: string }>
    }>(
      await ghApi([
        'graphql',
        '-f',
        `query=${setupQuery}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
      ]),
      'GitHub scratch-repository preflight',
    )
    const repository = setup.data?.repository
    if (!repository || repository.nameWithOwner.toLowerCase() !== repoSlug.toLowerCase()) {
      throw new Error(
        `GitHub live Forge contract cannot access scratch repository ${repoSlug}`,
      )
    }
    if (repository.viewerPermission !== 'ADMIN') {
      throw new Error(
        `GitHub scratch repository ${repoSlug} requires ADMIN permission for ` +
          `temporary branch protection; found ${repository.viewerPermission}`,
      )
    }
    if (!repository.autoMergeAllowed) {
      throw new Error(
        `GitHub scratch repository ${repoSlug} must have native auto-merge enabled`,
      )
    }
    const defaultBranch = repository.defaultBranchRef?.name
    if (!defaultBranch) {
      throw new Error(`GitHub scratch repository ${repoSlug} has no default branch`)
    }

    await run(['gh', 'repo', 'clone', repoSlug, workspacePath], tmp)
    cloneReady = true
    await run(['git', 'config', 'user.email', 'ab-contract@test.invalid'], workspacePath)
    await run(['git', 'config', 'user.name', 'ab-port-contract'], workspacePath)
    await run(['git', 'config', 'commit.gpgsign', 'false'], workspacePath)
    await run(['git', 'checkout', '-q', '-b', base, `origin/${defaultBranch}`], workspacePath)
    await run(['git', 'push', '-q', '-u', 'origin', base], workspacePath)
    await run(['git', 'checkout', '-q', '-b', head, base], workspacePath)
    await writeFile(join(workspacePath, `contract-${suffix}.txt`), 'head fixture\n')
    await run(['git', 'add', `contract-${suffix}.txt`], workspacePath)
    await run(
      ['git', ...GIT_ID, 'commit', '-q', '-m', `ab contract head ${suffix}`],
      workspacePath,
    )

    // A unique branch can still inherit an organization ruleset or wildcard
    // classic protection. The ungated contract must never silently run under
    // one; gated tests install only the known temporary check below.
    const rules = parseJson<
      Array<{ type: string; parameters?: unknown; [key: string]: unknown }>
    >(
      await ghApi([
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rules/branches/${encodeURIComponent(base)}`,
      ]),
      'GitHub active-rules preflight',
    )
    if (rulesetsHaveMergeGate(rules)) {
      throw new Error(
        `GitHub scratch base ${base} inherits a merge-blocking ruleset; ` +
          'the live contract requires an otherwise ungated scratch repository',
      )
    }
    const existingProtection = await execute(
      ['gh', 'api', protectionEndpoint],
      workspacePath,
    )
    if (existingProtection.exitCode === 0) {
      throw new Error(
        `GitHub scratch base ${base} unexpectedly inherits classic branch protection`,
      )
    }
    if (!/404|branch not protected|not found/i.test(existingProtection.stderr)) {
      throw new Error(
        `GitHub classic-protection preflight failed: ${existingProtection.stderr.trim()}`,
      )
    }

    if (opts.gated) {
      const payloadPath = join(tmp, 'branch-protection.json')
      await writeFile(
        payloadPath,
        JSON.stringify({
          required_status_checks: {
            strict: false,
            contexts: [`ab-contract-never-reported-${suffix}`],
          },
          enforce_admins: false,
          required_pull_request_reviews: null,
          restrictions: null,
        }),
      )
      await ghApi([
        protectionEndpoint,
        '--method',
        'PUT',
        '--input',
        payloadPath,
        '-H',
        'Accept: application/vnd.github+json',
      ])
      protectionInstalled = true
    }

    return {
      forge: new GitHubForge(),
      workspacePath,
      head,
      base,
      title: `Autobuild Forge contract ${suffix}`,
      body: `Scratch-only Forge contract fixture ${suffix}`,
      controls: {
        remoteHead: async (branch) => {
          const output = await run(
            ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
            workspacePath,
          )
          const sha = output.split(/\s+/)[0]
          if (!sha) throw new Error(`remote branch ${branch} was not published`)
          return sha
        },
        prepareMergeable: async (number) => {
          await waitForMergeable(number)
        },
        closePr: async (number) => {
          await ghApi([
            `repos/${owner}/${name}/pulls/${number}`,
            '--method',
            'PATCH',
            '-f',
            'state=closed',
          ])
          await waitFor(
            `PR #${number} to close`,
            () => prProbe(number),
            (pr) => pr.state === 'CLOSED',
          )
        },
        makeConflict: async (number) => {
          await run(['git', 'checkout', '-q', head], workspacePath)
          const file = `conflict-${suffix}.txt`
          await writeFile(join(workspacePath, file), 'head side\n')
          await run(['git', 'add', file], workspacePath)
          await run(
            ['git', ...GIT_ID, 'commit', '-q', '-m', `head conflict ${suffix}`],
            workspacePath,
          )
          await run(['git', 'push', '-q', 'origin', head], workspacePath)

          await run(['git', 'checkout', '-q', base], workspacePath)
          await writeFile(join(workspacePath, file), 'base side\n')
          await run(['git', 'add', file], workspacePath)
          await run(
            ['git', ...GIT_ID, 'commit', '-q', '-m', `base conflict ${suffix}`],
            workspacePath,
          )
          await run(['git', 'push', '-q', 'origin', base], workspacePath)
          await run(['git', 'checkout', '-q', head], workspacePath)
          await waitFor(
            `PR #${number} conflict projection`,
            () => prProbe(number),
            (pr) => pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING',
          )
        },
        advanceHead: async (number) => {
          await run(['git', 'checkout', '-q', head], workspacePath)
          const file = `advance-${crypto.randomUUID()}.txt`
          await writeFile(join(workspacePath, file), 'advanced head\n')
          await run(['git', 'add', file], workspacePath)
          await run(
            ['git', ...GIT_ID, 'commit', '-q', '-m', `advance contract head ${suffix}`],
            workspacePath,
          )
          const sha = await run(['git', 'rev-parse', 'HEAD'], workspacePath)
          await run(['git', 'push', '-q', 'origin', head], workspacePath)
          await waitFor(
            `PR #${number} advanced head ${sha}`,
            () => prProbe(number),
            (pr) =>
              pr.state === 'OPEN' &&
              pr.headRefOid === sha &&
              pr.mergeable === 'MERGEABLE' &&
              directStates.has(pr.mergeStateStatus),
          )
          return sha
        },
        nativeAutoMergeEnabled: async (number) =>
          (await prProbe(number)).autoMergeRequest !== null,
        commentExists: async (number, body) => {
          await waitFor(
            `PR #${number} comment delivery`,
            () => prProbe(number),
            (pr) => pr.comments.nodes.some((comment) => comment.body === body),
          )
          return true
        },
        mergeSha: async (number) => {
          const merged = await waitFor(
            `PR #${number} to merge`,
            () => prProbe(number),
            (pr) => pr.state === 'MERGED' && pr.mergeCommit !== null,
          )
          if (!merged.mergeCommit) {
            throw new Error(`GitHub PR #${number} merged without a landing SHA`)
          }
          return merged.mergeCommit.oid
        },
        trackPr: (number) => {
          trackedPrs.add(number)
        },
      },
      cleanup,
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      await cleanup()
    } catch (caught) {
      cleanupError = caught
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        'GitHub contract setup and cleanup both failed',
      )
    }
    throw error
  }
}

const runLiveGitHub =
  process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1' &&
  (nonblank(process.env.GH_TOKEN) || nonblank(process.env.GITHUB_TOKEN))

describe.skipIf(!runLiveGitHub)('GitHub live port contracts (opt-in)', () => {
  describeForgeContract('GitHubForge (live)', githubForgeContractFactory)
})

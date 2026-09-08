import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Sandbox, type NetworkPolicy, type SandboxRegion } from '@vercel/sandbox'
import type { VercelSandboxConfig } from '../../config/schema'
import { distributionRoot } from '../../distribution'
import type { WorkspaceHandle, WorkspaceProvider, WorkspaceProvisionResult } from '../types'
import type {
  BuildExecution,
  BuildExecutionExit,
  BuildExecutionHandle,
  BuildExecutionStart,
} from './build-execution'
import { BUILD_RUNNER_OPTIONS_ENV } from './local-build-execution'
import type { Exec } from './git-worktree'
import { spawnExec } from './git-worktree'

export const VERCEL_WORKSPACE_PATH = '/vercel/sandbox/workspace'
export const VERCEL_AUTOBUILD_PATH = '/opt/autobuild'
export const VERCEL_PROVISIONED_MARKER = `${VERCEL_AUTOBUILD_PATH}/.provisioned`

export interface VercelCommand {
  readonly exitCode: number | null
  wait(): Promise<{ exitCode: number }>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

export interface VercelSandboxHandle {
  readonly name: string
  runCommand(params: {
    cmd: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    detached?: true
  }): Promise<VercelCommand | { exitCode: number }>
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>
  stop(): Promise<unknown>
  delete(): Promise<void>
  update(params: { networkPolicy: NetworkPolicy }): Promise<unknown>
}

export interface VercelSandboxFacade {
  get(name: string): Promise<VercelSandboxHandle | null>
  create(input: {
    name: string
    source: {
      type: 'git'
      url: string
      revision: string
      depth?: number
      username?: string
      password?: string
    }
    image: string
    resources: { vcpus: number }
    timeout: number
    persistent: true
    region?: string
    failoverRegions?: string[]
    networkPolicy: NetworkPolicy
  }): Promise<VercelSandboxHandle>
}

function sdkCredentials(env: Record<string, string | undefined>): Record<string, string> {
  if (env.VERCEL_OIDC_TOKEN) return {}
  const token = env.VERCEL_TOKEN
  const teamId = env.VERCEL_TEAM_ID
  const projectId = env.VERCEL_PROJECT_ID
  if (!token || !teamId || !projectId) {
    throw new Error(
      'vercel-sandbox requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID',
    )
  }
  return { token, teamId, projectId }
}

export function isMissingVercelSandbox(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as {
    response?: { status?: number }
    json?: { error?: { code?: string } }
  }
  return (
    candidate.response?.status === 404 ||
    (candidate.response?.status === 410 && candidate.json?.error?.code === 'snapshot_not_found')
  )
}

export function createVercelSdkFacade(
  env: Record<string, string | undefined>,
): VercelSandboxFacade {
  const credentials = sdkCredentials(env)
  return {
    async get(name) {
      try {
        return await Sandbox.get({ name, ...credentials })
      } catch (error) {
        if (isMissingVercelSandbox(error)) return null
        throw error
      }
    },
    async create(input) {
      // get() returning null includes stale snapshots. getOrCreate performs the
      // SDK's required stale-name deletion before recreating and also closes a
      // concurrent provision race safely.
      return await Sandbox.getOrCreate({
        ...input,
        region: input.region as SandboxRegion | undefined,
        failoverRegions: input.failoverRegions as SandboxRegion[] | undefined,
        ...credentials,
      })
    },
  }
}

function requireValue(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`vercel-sandbox requires environment variable ${name}`)
  }
  return value
}

export function validateVercelGithubOrigin(raw: string): {
  url: string
  host: string
  path: string
  directory: string
} {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('vercel-sandbox requires an HTTPS GitHub origin')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('vercel-sandbox requires an HTTPS github.com origin')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\.git$/, '').replace(/^\//, '')
  if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error('GitHub origin must name owner/repository')
  return {
    url: `https://github.com/${path}.git`,
    host: 'github.com',
    path: `/${path}.git`,
    directory: basename(path),
  }
}

const cleanGithubOrigin = validateVercelGithubOrigin

function sandboxName(origin: string, branch: string): string {
  const readable = branch
    .replace(/^ab\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40)
  const digest = createHash('sha256').update(`${origin}\0${branch}`).digest('hex').slice(0, 10)
  return `autobuild-${readable || 'build'}-${digest}`.slice(0, 63)
}

async function execOrThrow(exec: Exec, cmd: string[], cwd: string): Promise<string> {
  const result = await exec(cmd, { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout.trim()
}

function oneSha(output: string, label: string): string | null {
  const lines = output.trim() === '' ? [] : output.trim().split(/\r?\n/)
  if (lines.length === 0) return null
  if (lines.length !== 1) throw new Error(`${label} returned more than one ref`)
  const sha = lines[0]!.split(/\s+/)[0]!
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`${label} returned an invalid commit id`)
  return sha
}

function uploadPackPolicy(
  origin: ReturnType<typeof cleanGithubOrigin>,
  auth?: string,
): NetworkPolicy {
  if (auth === undefined) return 'allow-all'
  return {
    allow: {
      '*': [],
      [origin.host]: [
        {
          match: {
            method: ['GET'],
            path: { exact: `${origin.path}/info/refs` },
            queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
          },
          transform: [{ headers: { authorization: auth } }],
        },
        {
          match: { method: ['POST'], path: { exact: `${origin.path}/git-upload-pack` } },
          transform: [{ headers: { authorization: auth } }],
        },
      ],
    },
  }
}

async function commandOrThrow(
  sandbox: VercelSandboxHandle,
  params: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> },
): Promise<void> {
  const result = await sandbox.runCommand(params)
  if (result.exitCode === null || result.exitCode === undefined) {
    throw new Error(`sandbox command ${params.cmd} did not return an exit status`)
  }
  if (result.exitCode !== 0)
    throw new Error(`sandbox command ${params.cmd} exited ${result.exitCode}`)
}

export async function packageAutobuildDistribution(): Promise<Uint8Array> {
  const destination = await mkdtemp(join(tmpdir(), 'autobuild-pack-'))
  try {
    await execOrThrow(
      spawnExec,
      ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', destination],
      distributionRoot(),
    )
    const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
    if (archives.length !== 1)
      throw new Error('Autobuild packaging did not produce exactly one archive')
    return new Uint8Array(await readFile(join(destination, archives[0]!)))
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
}

export interface VercelSandboxProviderOptions {
  config: VercelSandboxConfig
  env: Record<string, string | undefined>
  storeRef: string
  storeToken: string
  /** Dispatcher-local main checkout, used only for origin discovery and verification. */
  repo: string
  facade?: VercelSandboxFacade
  exec?: Exec
  packageArchive?: () => Promise<Uint8Array>
}

/** Vercel-backed working copy and executor. SDK command output is never read:
 * durable Store events remain the sole build-state channel. */
export class VercelSandboxProvider implements WorkspaceProvider {
  readonly name = 'vercel-sandbox'
  readonly buildExecution: BuildExecution
  readonly publication
  private readonly facade: VercelSandboxFacade
  private readonly exec: Exec
  private readonly active = new Set<string>()
  private readonly origins = new Map<string, ReturnType<typeof cleanGithubOrigin>>()
  private readonly sessions = new Map<string, VercelSandboxHandle>()

  constructor(private readonly options: VercelSandboxProviderOptions) {
    if (!/^https:\/\//i.test(options.storeRef) || options.storeToken === '') {
      throw new Error('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
    }
    this.facade = options.facade ?? createVercelSdkFacade(options.env)
    this.exec = options.exec ?? spawnExec
    this.buildExecution = { start: (input) => this.start(input) }
    this.publication = {
      publish: (input: { ref: string; sha: string; branch: string }) => this.publish(input),
    }
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceProvisionResult> {
    const rawOrigin = await execOrThrow(
      this.exec,
      ['git', 'remote', 'get-url', 'origin'],
      opts.repo,
    )
    const origin = cleanGithubOrigin(rawOrigin)
    const name = sandboxName(origin.url, opts.branch)
    let sandbox = await this.facade.get(name)
    const existing = oneSha(
      await execOrThrow(
        this.exec,
        ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${opts.branch}`],
        opts.repo,
      ),
      `remote branch ${opts.branch}`,
    )
    const base =
      existing === null
        ? oneSha(
            await execOrThrow(
              this.exec,
              ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${opts.baseBranch}`],
              opts.repo,
            ),
            `remote base ${opts.baseBranch}`,
          )
        : existing
    if (base === null)
      throw new Error(
        `remote branch ${existing === null ? opts.baseBranch : opts.branch} does not exist`,
      )

    if (sandbox !== null) {
      const marker = await sandbox.runCommand({
        cmd: 'test',
        args: ['-f', VERCEL_PROVISIONED_MARKER],
      })
      if (marker.exitCode === 0) {
        await sandbox.stop()
      } else {
        // A named VM without the marker is a crashed/legacy provisioning
        // attempt. Never expose its potentially unscrubbed checkout to agents.
        await sandbox.delete()
        sandbox = null
      }
    }

    if (sandbox === null) {
      const username =
        this.options.config.gitUsernameEnv === undefined
          ? undefined
          : requireValue(this.options.env, this.options.config.gitUsernameEnv)
      const password =
        this.options.config.gitPasswordEnv === undefined
          ? undefined
          : requireValue(this.options.env, this.options.config.gitPasswordEnv)
      const readAuth =
        password === undefined
          ? undefined
          : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      sandbox = await this.facade.create({
        name,
        source: {
          type: 'git',
          url: origin.url,
          revision: base,
          ...(username !== undefined && password !== undefined ? { username, password } : {}),
        },
        image: this.options.config.image,
        resources: { vcpus: this.options.config.vcpus },
        timeout: this.options.config.timeoutSeconds * 1000,
        persistent: true,
        ...(this.options.config.region !== undefined ? { region: this.options.config.region } : {}),
        ...(this.options.config.failoverRegions.length > 0
          ? { failoverRegions: this.options.config.failoverRegions }
          : {}),
        networkPolicy: uploadPackPolicy(origin, readAuth),
      })
      try {
        const sourcePath = `/vercel/sandbox/${origin.directory}`
        await commandOrThrow(sandbox, { cmd: 'mv', args: [sourcePath, VERCEL_WORKSPACE_PATH] })
        await commandOrThrow(sandbox, {
          cmd: 'git',
          args: ['checkout', '-B', opts.branch, base],
          cwd: VERCEL_WORKSPACE_PATH,
        })
        await commandOrThrow(sandbox, {
          cmd: 'git',
          args: ['remote', 'set-url', 'origin', origin.url],
          cwd: VERCEL_WORKSPACE_PATH,
        })
        for (const key of [
          'credential.helper',
          'http.extraheader',
          `http.${origin.url}.extraheader`,
        ]) {
          const result = await sandbox.runCommand({
            cmd: 'git',
            args: ['config', '--local', '--unset-all', key],
            cwd: VERCEL_WORKSPACE_PATH,
          })
          if (result.exitCode !== 0 && result.exitCode !== 5)
            throw new Error(`failed to scrub git config ${key}`)
        }
        const archive = await (this.options.packageArchive ?? packageAutobuildDistribution)()
        await sandbox.writeFiles([{ path: '/tmp/autobuild.tgz', content: archive }])
        await commandOrThrow(sandbox, { cmd: 'mkdir', args: ['-p', VERCEL_AUTOBUILD_PATH] })
        await commandOrThrow(sandbox, {
          cmd: 'tar',
          args: ['-xzf', '/tmp/autobuild.tgz', '--strip-components=1', '-C', VERCEL_AUTOBUILD_PATH],
        })
        await commandOrThrow(sandbox, {
          cmd: 'bun',
          args: ['install', '--production', '--ignore-scripts'],
          cwd: VERCEL_AUTOBUILD_PATH,
        })
        // Repository dependencies precede branch-owned package plugin loading.
        // The fixed bootstrap supports the consuming repository's lockfile; its
        // configured setup command still runs at every runner attachment.
        await commandOrThrow(sandbox, {
          cmd: 'sh',
          args: [
            '-c',
            'if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable; fi',
          ],
          cwd: VERCEL_WORKSPACE_PATH,
        })
        await commandOrThrow(sandbox, {
          cmd: 'touch',
          args: [VERCEL_PROVISIONED_MARKER],
        })
        await sandbox.stop()
      } catch (error) {
        try {
          await sandbox.delete()
        } catch (deleteError) {
          throw new AggregateError(
            [error, deleteError],
            `sandbox ${name} setup failed and its incomplete environment could not be deleted`,
          )
        }
        throw error
      }
    }
    this.origins.set(name, origin)
    this.sessions.set(name, sandbox)
    return {
      provider: this.name,
      ref: name,
      path: VERCEL_WORKSPACE_PATH,
      branch: opts.branch,
      base: { source: existing === null ? 'remote' : 'existing', sha: base },
    }
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    if (this.active.has(handle.ref)) throw new Error(`cannot release active sandbox ${handle.ref}`)
    const sandbox = this.sessions.get(handle.ref) ?? (await this.facade.get(handle.ref))
    if (sandbox === null) return
    await sandbox.delete()
    this.sessions.delete(handle.ref)
    this.origins.delete(handle.ref)
  }

  private async start(input: BuildExecutionStart): Promise<BuildExecutionHandle> {
    const ref = input.workspaceRef
    if (this.active.has(ref)) throw new Error(`sandbox ${ref} already has a live execution`)
    const sandbox = this.sessions.get(ref) ?? (await this.facade.get(ref))
    if (sandbox === null) throw new Error(`sandbox ${ref} no longer exists`)
    this.sessions.set(ref, sandbox)
    const env: Record<string, string> = {
      AB_STORE: this.options.storeRef,
      AB_TOKEN: this.options.storeToken,
      [BUILD_RUNNER_OPTIONS_ENV]: JSON.stringify({
        ...input,
        supervision: { kind: 'environment' },
      }),
    }
    for (const name of this.options.config.environmentVariables)
      env[name] = requireValue(this.options.env, name)
    const command = (await sandbox.runCommand({
      cmd: 'bun',
      args: [`${VERCEL_AUTOBUILD_PATH}/bin/ab-build-runner.ts`],
      cwd: VERCEL_WORKSPACE_PATH,
      env,
      detached: true,
    })) as VercelCommand
    this.active.add(ref)
    let environmentStop: Promise<void> | undefined
    const stopEnvironment = async (): Promise<void> => {
      environmentStop ??= (async () => {
        try {
          await sandbox.stop()
        } catch (error) {
          // Do not retain a potentially expired/stale SDK handle. A later
          // execution or abort cleanup re-resolves the named sandbox.
          this.sessions.delete(ref)
          throw error
        } finally {
          this.active.delete(ref)
        }
      })()
      await environmentStop
    }
    let stopping: Promise<void> | undefined
    const stop = async () => {
      stopping ??= (async () => {
        try {
          await command.kill('SIGTERM')
        } catch {
          /* already exited */
        }
        await stopEnvironment()
      })()
      await stopping
    }
    const completion = command.wait().then(
      async (result): Promise<BuildExecutionExit> => {
        await stopEnvironment()
        return { exitCode: result.exitCode }
      },
      async (error) => {
        await stopEnvironment()
        throw error
      },
    )
    return { completion, stop }
  }

  private async publish(input: { ref: string; sha: string; branch: string }): Promise<void> {
    if (this.active.has(input.ref))
      throw new Error('publication is forbidden while a sandbox execution is live')
    if (!/^[0-9a-f]{40,64}$/i.test(input.sha) || !/^ab\/[a-z0-9][a-z0-9-]*$/.test(input.branch)) {
      throw new Error('publication requires an exact commit SHA and canonical build branch')
    }
    const token = this.options.env.GITHUB_TOKEN || this.options.env.GH_TOKEN
    if (!token) {
      throw new Error('vercel-sandbox publication requires GITHUB_TOKEN or GH_TOKEN')
    }
    const origin =
      this.origins.get(input.ref) ??
      cleanGithubOrigin(
        await execOrThrow(this.exec, ['git', 'remote', 'get-url', 'origin'], this.options.repo),
      )
    const sandbox = this.sessions.get(input.ref) ?? (await this.facade.get(input.ref))
    if (sandbox === null) throw new Error(`unknown sandbox ${input.ref}`)
    this.origins.set(input.ref, origin)
    this.sessions.set(input.ref, sandbox)
    const normal = uploadPackPolicy(
      origin,
      this.options.config.gitPasswordEnv === undefined
        ? undefined
        : `Basic ${Buffer.from(`${requireValue(this.options.env, this.options.config.gitUsernameEnv!)}:${requireValue(this.options.env, this.options.config.gitPasswordEnv)}`).toString('base64')}`,
    )
    const publicationPolicy: NetworkPolicy = {
      allow: {
        [origin.host]: [
          {
            match: {
              method: ['GET'],
              path: { exact: `${origin.path}/info/refs` },
              queryString: [{ key: { exact: 'service' }, value: { exact: 'git-receive-pack' } }],
            },
            transform: [
              {
                headers: {
                  authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
                },
              },
            ],
          },
          {
            match: { method: ['POST'], path: { exact: `${origin.path}/git-receive-pack` } },
            transform: [
              {
                headers: {
                  authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
                },
              },
            ],
          },
        ],
      },
    }
    try {
      await sandbox.update({ networkPolicy: publicationPolicy })
      await commandOrThrow(sandbox, {
        cmd: 'git',
        args: ['push', '--no-verify', 'origin', `${input.sha}:refs/heads/${input.branch}`],
        cwd: VERCEL_WORKSPACE_PATH,
      })
      await sandbox.stop()
      const published = oneSha(
        await execOrThrow(
          this.exec,
          ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${input.branch}`],
          this.options.repo,
        ),
        'published branch',
      )
      if (published !== input.sha)
        throw new Error(`published head ${published ?? '(missing)'} did not match ${input.sha}`)
    } finally {
      try {
        await sandbox.update({ networkPolicy: normal })
      } finally {
        await sandbox.stop()
      }
    }
  }
}

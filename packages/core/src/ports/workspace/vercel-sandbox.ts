import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Sandbox, type NetworkPolicy, type SandboxRegion } from '@vercel/sandbox'
import { displayName, tomlKey, type RuntimeReferenceGroup } from '../../config/roles'
import {
  type VercelProvisioningStep,
  type VercelSandboxConfig,
  vercelSandboxConfigSchema,
} from '../../config/schema'
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
export const VERCEL_BUN_VERSION = '1.4.0'
export const VERCEL_BUN_PREFIX = '/opt/autobuild-runtime'
export const VERCEL_BUN_BIN_PATH = `${VERCEL_BUN_PREFIX}/node_modules/.bin`
export const VERCEL_BUN_EXECUTABLE = `${VERCEL_BUN_BIN_PATH}/bun`

export interface VercelCommand {
  readonly exitCode: number | null
  wait(): Promise<{ exitCode: number }>
  kill(signal?: 'SIGTERM' | 'SIGKILL', opts?: { abortSignal?: AbortSignal }): Promise<void>
  /** Completed-command output is read only for readiness/validation reporting
   * and declared system-provisioning failure diagnostics, including failures
   * during durable build provisioning. It is not a durable build-state channel;
   * scoped Store facts/events remain authoritative. */
  stdout?(): Promise<string>
  stderr?(): Promise<string>
}

export interface VercelSandboxHandle {
  readonly name: string
  currentSession?(): { sessionId: string }
  runCommand(params: {
    cmd: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    detached?: true
    sudo?: boolean
    signal?: AbortSignal
  }): Promise<VercelCommand | { exitCode: number }>
  writeFiles(
    files: { path: string; content: Uint8Array }[],
    opts?: { signal?: AbortSignal },
  ): Promise<void>
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>
  delete(opts?: { signal?: AbortSignal }): Promise<void>
  update(
    params: { networkPolicy: NetworkPolicy },
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>
}

export type VercelSandboxCreateInput = {
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
  signal?: AbortSignal
}

export interface VercelSandboxFacade {
  get(name: string, signal?: AbortSignal): Promise<VercelSandboxHandle | null>
  /** Durable build workspaces retain the named get-or-create lifecycle. */
  create(input: VercelSandboxCreateInput): Promise<VercelSandboxHandle>
  /** Readiness always acquires a new unnamed disposable environment. */
  createFresh?(
    input: Omit<VercelSandboxCreateInput, 'name' | 'persistent'>,
  ): Promise<VercelSandboxHandle>
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
    async get(name, signal) {
      try {
        return await Sandbox.get({ name, signal, ...credentials })
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
    async createFresh(input) {
      return await Sandbox.create({
        ...input,
        region: input.region as SandboxRegion | undefined,
        failoverRegions: input.failoverRegions as SandboxRegion[] | undefined,
        ...credentials,
      })
    },
  }
}

export function requireVercelEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string {
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

function sandboxName(origin: string, branch: string, generation = 0): string {
  const readable = branch
    .replace(/^ab\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40)
  const digest = createHash('sha256')
    .update(`${origin}\0${branch}\0${generation}`)
    .digest('hex')
    .slice(0, 10)
  return `autobuild-${readable || 'build'}-g${generation}-${digest}`.slice(0, 63)
}

async function execOrThrow(
  exec: Exec,
  cmd: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec(cmd, { cwd, ...(signal === undefined ? {} : { signal }) })
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
  params: {
    cmd: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    sudo?: boolean
    signal?: AbortSignal
  },
): Promise<void> {
  const result = await sandbox.runCommand(params)
  if (result.exitCode === null || result.exitCode === undefined) {
    throw new Error(`sandbox command ${params.cmd} did not return an exit status`)
  }
  if (result.exitCode !== 0)
    throw new Error(`sandbox command ${params.cmd} exited ${result.exitCode}`)
}

function bunProvisioningError(image: string, operation: string, error: unknown): Error {
  return new Error(
    `vercel-sandbox could not ${operation} Bun ${VERCEL_BUN_VERSION} on image ${JSON.stringify(image)}; Autobuild supports the universal managed image with working Node/npm, shell, filesystem, and package-registry access`,
    { cause: error },
  )
}

async function provisionBun(
  sandbox: VercelSandboxHandle,
  image: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await commandOrThrow(sandbox, {
      cmd: 'npm',
      args: ['install', '--prefix', VERCEL_BUN_PREFIX, '--no-save', `bun@${VERCEL_BUN_VERSION}`],
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw bunProvisioningError(image, 'provision', error)
  }
  try {
    await commandOrThrow(sandbox, {
      cmd: VERCEL_BUN_EXECUTABLE,
      args: ['--version'],
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw bunProvisioningError(image, 'verify provisioned', error)
  }
}

function runtimeEnvironment(
  config: VercelSandboxConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    config.environmentVariables.map((name) => [name, requireVercelEnvironmentValue(env, name)]),
  )
}

function redactRuntimeError(error: unknown, env: Record<string, string>): string {
  let detail = error instanceof Error ? error.message : String(error)
  for (const value of Object.values(env).sort((a, b) => b.length - a.length)) {
    if (value !== '') detail = detail.split(value).join('[REDACTED]')
  }
  return detail
}

async function bootstrapRuntimes(
  sandbox: VercelSandboxHandle,
  config: VercelSandboxConfig,
  hostEnv: Record<string, string | undefined>,
  references: readonly RuntimeReferenceGroup[],
  install: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const env = runtimeEnvironment(config, hostEnv)
  for (const group of [...references].sort((left, right) =>
    left.runtime < right.runtime ? -1 : left.runtime > right.runtime ? 1 : 0,
  )) {
    const provisioning = config.runtimeProvisioning?.[group.runtime]
    if (provisioning === undefined) {
      throw new Error(
        `runtime ${displayName(group.runtime)} selected by ${group.references.join(', ')} has no provisioning; add [workspace.config.runtimeProvisioning.${tomlKey(group.runtime)}] with install and preflight commands`,
      )
    }
    for (const stage of install ? (['install', 'preflight'] as const) : (['preflight'] as const)) {
      try {
        await readableCommand(sandbox, {
          cmd: 'sh',
          args: ['-c', provisioning[stage]],
          cwd: VERCEL_WORKSPACE_PATH,
          env,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        throw new Error(
          `runtime ${displayName(group.runtime)} ${stage} failed (selected by ${group.references.join(', ')}); fix workspace.config.runtimeProvisioning.${group.runtime}.${stage}: ${redactRuntimeError(error, env)}`,
        )
      }
    }
  }
}

async function runSystemProvisioning(
  sandbox: VercelSandboxHandle,
  steps: readonly VercelProvisioningStep[],
  signal?: AbortSignal,
): Promise<string[]> {
  const completed: string[] = []
  for (const step of steps) {
    const result = (await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', step.command],
      cwd: VERCEL_WORKSPACE_PATH,
      sudo: true,
      ...(signal === undefined ? {} : { signal }),
    })) as VercelCommand
    if (result.exitCode !== 0) {
      const [stdout, stderr] = await Promise.all([
        result.stdout?.() ?? Promise.resolve(''),
        result.stderr?.() ?? Promise.resolve(''),
      ])
      throw new Error(
        `system provisioning step ${JSON.stringify(step.name)} failed\n` +
          `command: ${step.command}\n` +
          `exit status: ${result.exitCode ?? '(missing)'}\n` +
          `stdout:\n${stdout.trim() === '' ? '(empty)' : stdout}\n` +
          `stderr:\n${stderr.trim() === '' ? '(empty)' : stderr}\n` +
          'remediation: fix [workspace.config].provisioning and rerun ab init --validate',
      )
    }
    completed.push(step.name)
  }
  return completed
}

async function preflightBun(sandbox: VercelSandboxHandle, image: string): Promise<void> {
  try {
    await commandOrThrow(sandbox, { cmd: VERCEL_BUN_EXECUTABLE, args: ['--version'] })
  } catch (error) {
    throw new Error(
      `vercel-sandbox Bun ${VERCEL_BUN_VERSION} preflight failed on image ${JSON.stringify(image)}; release and reprovision this sandbox before retrying the build`,
      { cause: error },
    )
  }
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

export interface VercelReadinessOptions {
  config: VercelSandboxConfig
  env: Record<string, string | undefined>
  storeRef: string
  storeToken: string
  repo: string
  baseBranch: string
  facade?: VercelSandboxFacade
  exec?: Exec
  packageArchive?: () => Promise<Uint8Array>
  runtimeReferences?: readonly RuntimeReferenceGroup[]
  signal?: AbortSignal
  /** Called as soon as the fresh sandbox has an identity, before bootstrap. */
  onSandbox?: (name: string) => void
}

export interface VercelReadinessResult {
  sandbox: string
  revision: string
  origin: string
  provisioning: string[]
  output: string
}

async function readableCommand(
  sandbox: VercelSandboxHandle,
  params: {
    cmd: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    sudo?: boolean
    signal?: AbortSignal
  },
): Promise<string> {
  const result = (await sandbox.runCommand(params)) as VercelCommand
  const stderr = result.stderr === undefined ? '' : await result.stderr()
  const stdout = result.stdout === undefined ? '' : await result.stdout()
  if (result.exitCode === null || result.exitCode === undefined) {
    throw new Error(`sandbox command ${params.cmd} did not return an exit status`)
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `sandbox command ${params.cmd} exited ${result.exitCode}: ${stderr.trim() || stdout.trim() || '(no output)'}`,
    )
  }
  return stdout
}

/** Create, inspect, and always delete one remote readiness environment. Unlike
 * build provisioning this never uses a stable name, branch, or marker. */
export async function validateVercelSandbox(
  options: VercelReadinessOptions,
): Promise<VercelReadinessResult> {
  const config = vercelSandboxConfigSchema.parse(options.config)
  if (!/^https:\/\//i.test(options.storeRef) || options.storeToken === '') {
    throw new Error(
      'remote validation requires an HTTPS AB_STORE and nonempty AB_TOKEN; configure a remotely reachable hosted Store',
    )
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('validation cancelled')
  const exec = options.exec ?? spawnExec
  const rawOrigin = await execOrThrow(
    exec,
    ['git', 'remote', 'get-url', 'origin'],
    options.repo,
    options.signal,
  )
  const origin = cleanGithubOrigin(rawOrigin)
  const revision = oneSha(
    await execOrThrow(
      exec,
      ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${options.baseBranch}`],
      options.repo,
      options.signal,
    ),
    `remote base ${options.baseBranch}`,
  )
  if (revision === null) {
    throw new Error(
      `remote base ${options.baseBranch} does not exist; commit and push the setup before validating`,
    )
  }
  const username =
    config.gitUsernameEnv === undefined
      ? undefined
      : requireVercelEnvironmentValue(options.env, config.gitUsernameEnv)
  const password =
    config.gitPasswordEnv === undefined
      ? undefined
      : requireVercelEnvironmentValue(options.env, config.gitPasswordEnv)
  const facade = options.facade ?? createVercelSdkFacade(options.env)
  if (facade.createFresh === undefined) {
    throw new Error('the configured Vercel SDK facade does not support fresh validation sandboxes')
  }
  const sandbox = await facade.createFresh({
    source: {
      type: 'git',
      url: origin.url,
      revision,
      ...(username !== undefined && password !== undefined ? { username, password } : {}),
    },
    image: config.image,
    resources: { vcpus: config.vcpus },
    timeout: config.timeoutSeconds * 1000,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.failoverRegions.length > 0 ? { failoverRegions: config.failoverRegions } : {}),
    networkPolicy: 'allow-all',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const name = sandbox.name
  const withSignal = <T extends { cmd: string }>(params: T): T & { signal?: AbortSignal } => ({
    ...params,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const checkCancellation = (): void => {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new Error(`validation cancelled; releasing sandbox ${name}`)
  }
  let failure: unknown
  let readiness: VercelReadinessResult | undefined
  try {
    options.onSandbox?.(name)
    checkCancellation()
    const sourcePath = `/vercel/sandbox/${origin.directory}`
    await commandOrThrow(
      sandbox,
      withSignal({ cmd: 'mv', args: [sourcePath, VERCEL_WORKSPACE_PATH] }),
    )
    await commandOrThrow(
      sandbox,
      withSignal({
        cmd: 'git',
        args: ['remote', 'set-url', 'origin', origin.url],
        cwd: VERCEL_WORKSPACE_PATH,
      }),
    )
    for (const key of ['credential.helper', 'http.extraheader', `http.${origin.url}.extraheader`]) {
      const result = await sandbox.runCommand(
        withSignal({
          cmd: 'git',
          args: ['config', '--local', '--unset-all', key],
          cwd: VERCEL_WORKSPACE_PATH,
        }),
      )
      if (result.exitCode !== 0 && result.exitCode !== 5) {
        throw new Error(`failed to scrub git config ${key}`)
      }
    }
    await provisionBun(sandbox, config.image, options.signal)
    const provisioning = await runSystemProvisioning(sandbox, config.provisioning, options.signal)
    const archive = await (options.packageArchive ?? packageAutobuildDistribution)()
    checkCancellation()
    await sandbox.writeFiles([{ path: '/tmp/autobuild.tgz', content: archive }], {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    checkCancellation()
    await commandOrThrow(sandbox, withSignal({ cmd: 'mkdir', args: ['-p', VERCEL_AUTOBUILD_PATH] }))
    await commandOrThrow(
      sandbox,
      withSignal({
        cmd: 'tar',
        args: ['-xzf', '/tmp/autobuild.tgz', '--strip-components=1', '-C', VERCEL_AUTOBUILD_PATH],
      }),
    )
    await commandOrThrow(
      sandbox,
      withSignal({
        cmd: VERCEL_BUN_EXECUTABLE,
        args: ['install', '--production', '--ignore-scripts'],
        cwd: VERCEL_AUTOBUILD_PATH,
      }),
    )
    await commandOrThrow(
      sandbox,
      withSignal({
        cmd: 'sh',
        args: [
          '-c',
          `if [ -f bun.lock ] || [ -f bun.lockb ]; then ${VERCEL_BUN_EXECUTABLE} install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable; fi`,
        ],
        cwd: VERCEL_WORKSPACE_PATH,
      }),
    )
    await bootstrapRuntimes(
      sandbox,
      config,
      options.env,
      options.runtimeReferences ?? [],
      true,
      options.signal,
    )
    const setup = await readableCommand(
      sandbox,
      withSignal({
        cmd: 'sh',
        args: [
          '-c',
          `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-init-probe.ts`,
        ],
        cwd: VERCEL_WORKSPACE_PATH,
        env: Object.fromEntries([
          ['AB_STORE', options.storeRef],
          ['AB_TOKEN', options.storeToken],
          ...config.environmentVariables.map((name) => [
            name,
            requireVercelEnvironmentValue(options.env, name),
          ]),
        ]),
      }),
    )
    readiness = { sandbox: name, revision, origin: origin.url, provisioning, output: setup }
  } catch (error) {
    failure = error
  }
  try {
    await sandbox.delete()
  } catch (deleteError) {
    const guidance = `disposable sandbox ${name} could not be deleted; delete it manually in the Vercel dashboard or with: vercel sandbox rm ${name}`
    if (failure !== undefined) throw new AggregateError([failure, deleteError], guidance)
    throw new Error(guidance, { cause: deleteError })
  }
  if (failure !== undefined) {
    throw new Error(
      `disposable sandbox ${name} was deleted after validation failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    )
  }
  return readiness!
}

export type RuntimeReferencesSource =
  | readonly RuntimeReferenceGroup[]
  | (() => readonly RuntimeReferenceGroup[])

function currentRuntimeReferences(
  source: RuntimeReferencesSource | undefined,
): readonly RuntimeReferenceGroup[] {
  if (source === undefined) return []
  return typeof source === 'function' ? source() : source
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
  runtimeReferences?: RuntimeReferencesSource
}

/** Vercel-backed working copy and executor. Completed SDK command output is
 * read only for readiness/validation reporting and declared system-provisioning
 * failure diagnostics, including failures during durable build provisioning. It
 * is not a durable build-state channel; scoped Store facts/events remain the
 * authoritative build-state channel. */
export class VercelSandboxProvider implements WorkspaceProvider {
  readonly name = 'vercel-sandbox'
  readonly buildExecution: BuildExecution
  readonly publication
  readonly recovery
  private readonly facade: VercelSandboxFacade
  private readonly exec: Exec
  private readonly active = new Set<string>()
  /** A failed stop leaves execution state unknown until a later stop/delete succeeds. */
  private readonly uncertain = new Set<string>()
  private readonly origins = new Map<string, ReturnType<typeof cleanGithubOrigin>>()
  private readonly sessions = new Map<string, VercelSandboxHandle>()

  constructor(private readonly options: VercelSandboxProviderOptions) {
    if (!/^https:\/\//i.test(options.storeRef) || options.storeToken === '') {
      throw new Error('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
    }
    this.facade = options.facade ?? createVercelSdkFacade(options.env)
    this.exec = options.exec ?? spawnExec
    this.buildExecution = { start: (input) => this.start(input) }
    this.recovery = { reap: (handle: WorkspaceHandle) => this.reap(handle.ref) }
    this.publication = {
      isPublished: (input: { sha: string; branch: string }) => this.isPublished(input),
      publish: (input: { ref: string; sha: string; branch: string }) => this.publish(input),
    }
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
    revision?: string
    generation?: number
  }): Promise<WorkspaceProvisionResult> {
    const rawOrigin = await execOrThrow(
      this.exec,
      ['git', 'remote', 'get-url', 'origin'],
      opts.repo,
    )
    const origin = cleanGithubOrigin(rawOrigin)
    const name = sandboxName(origin.url, opts.branch, opts.generation)
    let sandbox = await this.facade.get(name, this.operationSignal())
    const existing = oneSha(
      await execOrThrow(
        this.exec,
        ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${opts.branch}`],
        opts.repo,
      ),
      `remote branch ${opts.branch}`,
    )
    const base =
      existing ??
      opts.revision ??
      oneSha(
        await execOrThrow(
          this.exec,
          ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${opts.baseBranch}`],
          opts.repo,
        ),
        `remote base ${opts.baseBranch}`,
      )
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
        await sandbox.stop({ signal: this.operationSignal() })
      } else {
        // A named VM without the marker is a crashed/legacy provisioning
        // attempt. Never expose its potentially unscrubbed checkout to agents.
        await sandbox.delete({ signal: this.operationSignal() })
        sandbox = null
      }
    }

    if (sandbox === null) {
      const username =
        this.options.config.gitUsernameEnv === undefined
          ? undefined
          : requireVercelEnvironmentValue(this.options.env, this.options.config.gitUsernameEnv)
      const password =
        this.options.config.gitPasswordEnv === undefined
          ? undefined
          : requireVercelEnvironmentValue(this.options.env, this.options.config.gitPasswordEnv)
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
        signal: this.operationSignal(),
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
        await provisionBun(sandbox, this.options.config.image)
        await runSystemProvisioning(sandbox, this.options.config.provisioning ?? [])
        const archive = await (this.options.packageArchive ?? packageAutobuildDistribution)()
        await sandbox.writeFiles([{ path: '/tmp/autobuild.tgz', content: archive }], {
          signal: this.operationSignal(),
        })
        await commandOrThrow(sandbox, { cmd: 'mkdir', args: ['-p', VERCEL_AUTOBUILD_PATH] })
        await commandOrThrow(sandbox, {
          cmd: 'tar',
          args: ['-xzf', '/tmp/autobuild.tgz', '--strip-components=1', '-C', VERCEL_AUTOBUILD_PATH],
        })
        await commandOrThrow(sandbox, {
          cmd: VERCEL_BUN_EXECUTABLE,
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
            `if [ -f bun.lock ] || [ -f bun.lockb ]; then ${VERCEL_BUN_EXECUTABLE} install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable; fi`,
          ],
          cwd: VERCEL_WORKSPACE_PATH,
        })
        await bootstrapRuntimes(
          sandbox,
          this.options.config,
          this.options.env,
          currentRuntimeReferences(this.options.runtimeReferences),
          true,
        )
        await commandOrThrow(sandbox, {
          cmd: 'touch',
          args: [VERCEL_PROVISIONED_MARKER],
        })
        await sandbox.stop({ signal: this.operationSignal() })
      } catch (error) {
        try {
          this.sessions.set(name, sandbox)
          await this.reap(name)
        } catch (deleteError) {
          throw new AggregateError(
            [error, deleteError],
            `sandbox ${name} setup failed and its incomplete environment could not be confirmed deleted`,
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
    await this.reap(handle.ref)
  }

  private operationSignal(): AbortSignal {
    return AbortSignal.timeout(this.options.config.operationTimeoutMs ?? 30_000)
  }

  /** Stop/delete and then prove absence by exact deterministic name. */
  private async reap(ref: string): Promise<'confirmed' | 'absent'> {
    let sandbox = this.sessions.get(ref) ?? (await this.facade.get(ref, this.operationSignal()))
    if (sandbox === null) {
      this.forget(ref)
      return 'absent'
    }
    try {
      await sandbox.stop({ signal: this.operationSignal() })
      await sandbox.delete({ signal: this.operationSignal() })
      sandbox = await this.facade.get(ref, this.operationSignal())
      if (sandbox !== null)
        throw new Error(`sandbox ${ref} still exists after delete acknowledgement`)
      this.forget(ref)
      return 'confirmed'
    } catch (error) {
      this.uncertain.add(ref)
      this.sessions.delete(ref)
      throw new Error(
        `sandbox ${ref} cleanup outcome is unknown and remains retryable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private forget(ref: string): void {
    this.active.delete(ref)
    this.uncertain.delete(ref)
    this.sessions.delete(ref)
    this.origins.delete(ref)
  }

  private async normalNetworkPolicy(ref: string): Promise<{
    origin: ReturnType<typeof cleanGithubOrigin>
    policy: NetworkPolicy
  }> {
    const origin =
      this.origins.get(ref) ??
      cleanGithubOrigin(
        await execOrThrow(this.exec, ['git', 'remote', 'get-url', 'origin'], this.options.repo),
      )
    this.origins.set(ref, origin)
    return {
      origin,
      policy: uploadPackPolicy(
        origin,
        this.options.config.gitPasswordEnv === undefined
          ? undefined
          : `Basic ${Buffer.from(`${requireVercelEnvironmentValue(this.options.env, this.options.config.gitUsernameEnv!)}:${requireVercelEnvironmentValue(this.options.env, this.options.config.gitPasswordEnv)}`).toString('base64')}`,
      ),
    }
  }

  private async start(input: BuildExecutionStart): Promise<BuildExecutionHandle> {
    const ref = input.workspaceRef
    if (this.active.has(ref)) throw new Error(`sandbox ${ref} already has a live execution`)
    const sandbox = this.sessions.get(ref) ?? (await this.facade.get(ref, this.operationSignal()))
    if (sandbox === null) throw new Error(`sandbox ${ref} no longer exists`)
    // A prior publication restore may have failed. Reassert the
    // receive-pack-free policy before any guest command can run.
    const { policy } = await this.normalNetworkPolicy(ref)
    await sandbox.update({ networkPolicy: policy }, { signal: this.operationSignal() })
    if (this.uncertain.has(ref)) {
      // A prior wait/stop failure may have left agent code alive. Confirm a
      // stop before starting another runner in the same environment.
      await sandbox.stop({ signal: this.operationSignal() })
      this.uncertain.delete(ref)
    }
    await preflightBun(sandbox, this.options.config.image)
    await bootstrapRuntimes(
      sandbox,
      this.options.config,
      this.options.env,
      currentRuntimeReferences(this.options.runtimeReferences),
      false,
    )
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
      env[name] = requireVercelEnvironmentValue(this.options.env, name)
    const command = (await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-build-runner.ts`,
      ],
      cwd: VERCEL_WORKSPACE_PATH,
      env,
      detached: true,
      signal: this.operationSignal(),
    })) as VercelCommand
    this.active.add(ref)
    let environmentStop: Promise<void> | undefined
    const stopEnvironment = async (): Promise<void> => {
      environmentStop ??= (async () => {
        try {
          await sandbox.stop({ signal: this.operationSignal() })
        } catch (error) {
          // Do not retain a potentially expired/stale SDK handle. A later
          // execution must first re-resolve and confirm teardown.
          this.uncertain.add(ref)
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
          await command.kill('SIGTERM', { abortSignal: this.operationSignal() })
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
    const sessionId = sandbox.currentSession?.().sessionId
    return {
      identity: {
        provider: this.name,
        workspaceRef: ref,
        environmentId: sandbox.name,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
      completion,
      stop: async () => {
        try {
          await stop()
          return { outcome: 'confirmed' }
        } catch (error) {
          return {
            outcome: 'unknown',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    }
  }

  private async isPublished(input: { sha: string; branch: string }): Promise<boolean> {
    const head = oneSha(
      await execOrThrow(
        this.exec,
        ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${input.branch}`],
        this.options.repo,
      ),
      `published branch ${input.branch}`,
    )
    return head === input.sha
  }

  private async publish(input: { ref: string; sha: string; branch: string }): Promise<void> {
    if (this.active.has(input.ref) || this.uncertain.has(input.ref)) {
      throw new Error('publication is forbidden until sandbox execution teardown is confirmed')
    }
    if (!/^[0-9a-f]{40,64}$/i.test(input.sha) || !/^ab\/[a-z0-9][a-z0-9-]*$/.test(input.branch)) {
      throw new Error('publication requires an exact commit SHA and canonical build branch')
    }
    const token = this.options.env.GITHUB_TOKEN || this.options.env.GH_TOKEN
    if (!token) {
      throw new Error('vercel-sandbox publication requires GITHUB_TOKEN or GH_TOKEN')
    }
    const { origin, policy: normal } = await this.normalNetworkPolicy(input.ref)
    const sandbox =
      this.sessions.get(input.ref) ?? (await this.facade.get(input.ref, this.operationSignal()))
    if (sandbox === null) throw new Error(`unknown sandbox ${input.ref}`)
    this.sessions.set(input.ref, sandbox)
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
      await sandbox.update({ networkPolicy: publicationPolicy }, { signal: this.operationSignal() })
      await commandOrThrow(sandbox, {
        cmd: 'git',
        args: ['push', '--no-verify', 'origin', `${input.sha}:refs/heads/${input.branch}`],
        cwd: VERCEL_WORKSPACE_PATH,
      })
      await sandbox.stop({ signal: this.operationSignal() })
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
        await sandbox.update({ networkPolicy: normal }, { signal: this.operationSignal() })
      } finally {
        await sandbox.stop({ signal: this.operationSignal() })
      }
    }
  }
}

import {
  missingAccountCredentials,
  MissingAccountCredentialsError,
} from '../../accounts/availability'
import { WorkspaceCleanupRequired } from '../types'
import { inspectGitCandidate, preserveGitCommits, restoreGitCommits } from './commit-preservation'
import { isArchiveRefusal } from '../../kernel/history-retention'
import { accountPolicy, accountGuestEnvironment } from './account-policy'
import { HOSTED_ACCOUNT_READINESS_ENV } from '../../accounts/hosted-readiness'
import { gitRewrite, parseRemoteHead } from '../forge/git-rewrite'
import { GITHUB_REQUIRE_CREDENTIAL_ENV } from '../forge/github-transport'
import { delegateCredential } from '../../store/remote/credentials'
import type { ExecutionLaunchAuth } from './build-execution'
import { createHash } from 'node:crypto'
import { Sandbox, Snapshot, type NetworkPolicy, type SandboxRegion } from '@vercel/sandbox'
import { displayName, tomlKey, type RuntimeReferenceGroup } from '../../config/roles'
import {
  type VercelProvisioningStep,
  type VercelSandboxConfig,
  vercelSandboxConfigSchema,
} from '../../config/schema'
import { distributionStampFor, resolveDistributionArchive } from './distribution-archive'
import type {
  ForgeRewrite,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceProvisionResult,
  WorkspacePublication,
  WorkspaceReapOutcome,
} from '../types'
import {
  SandboxOperationError,
  type OperatorSandboxExecution,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxProviderStatus,
  type SandboxProvisionStage,
  type SandboxRefreshResult,
  type SandboxWaitResult,
  redactSandboxMessage,
  SANDBOX_INTERRUPTED_MESSAGE,
  SANDBOX_REFRESH_DIRTY_MESSAGE,
  sandboxRefreshDivergedMessage,
} from './operator-sandbox'
import type {
  BuildExecution,
  BuildExecutionExit,
  BuildExecutionHandle,
  BuildExecutionIdentity,
  BuildExecutionStart,
  ExecutionObservation,
} from './build-execution'
import {
  HARVEST_RUNNER_OPTIONS_ENV,
  type HarvestExecution,
  type HarvestExecutionStart,
  type HarvestRunnerLaunch,
} from './harvest-execution'
import { BUILD_RUNNER_OPTIONS_ENV } from './local-build-execution'
import type { Exec } from './git-worktree'
import { spawnExec } from './git-worktree'
import { validateVercelGithubOrigin } from './github-origin'
import { currentRuntimeReferences, type RuntimeReferencesSource } from './provider-capabilities'

export { validateVercelGithubOrigin }

export const VERCEL_WORKSPACE_PATH = '/vercel/sandbox/workspace'
export const VERCEL_AUTOBUILD_PATH = '/opt/autobuild'
export const VERCEL_PROVISIONED_MARKER = `${VERCEL_AUTOBUILD_PATH}/.provisioned`
/** Records the installed distribution's identity stamp — everything the
 * hosted store's skew check compares (package version and remote-store
 * protocol version) plus the sha256 digest of the exact packed archive the
 * dispatcher installs (see `readDistributionIdentityStamp`). A reused sandbox
 * whose marker disagrees with the stamp the current system would deliver is
 * refreshed by reinstalling the archive, so an upgraded dispatcher retrofits
 * its persistent guests (including legacy guests predating this marker)
 * instead of resuming a stale distribution that the hosted store would
 * reject. */
export const VERCEL_DISTRIBUTION_VERSION_MARKER = `${VERCEL_AUTOBUILD_PATH}/.distribution-version`
export const VERCEL_BUN_VERSION = '1.4.4'
export const VERCEL_BUN_PREFIX = '/opt/autobuild-runtime'
export const VERCEL_BUN_BIN_PATH = `${VERCEL_BUN_PREFIX}/node_modules/.bin`
export const VERCEL_BUN_EXECUTABLE = `${VERCEL_BUN_BIN_PATH}/bun`

export interface VercelCommand {
  readonly exitCode: number | null
  /** Provider-native command identity, recorded durably at launch so a later
   * process can re-observe the execution. */
  readonly cmdId: string
  /** The optional signal lets a detaching supervisor release a pending
   * long-poll without killing the remote command. */
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>
  kill(signal?: 'SIGTERM' | 'SIGKILL', opts?: { abortSignal?: AbortSignal }): Promise<void>
  /** Completed-command output is read only for readiness/validation reporting
   * and declared system-provisioning failure diagnostics, including failures
   * during durable build provisioning. It is not a durable build-state channel;
   * scoped Store facts/events remain authoritative. */
  stdout?(): Promise<string>
  stderr?(): Promise<string>
}

/**
 * Bun's native fetch enforces its own request timeout on the SDK's `wait=true`
 * long-poll and ignores the SDK's undici agent (`bodyTimeout: 0`). A guest
 * execution routinely outlives that timeout, so an interrupted long-poll is
 * re-issued until the command reports an exit code or the environment's own
 * lifetime has passed. Any other failure still propagates: it may mean the
 * environment is gone. The same classification reads the observation path's
 * bounded wait: an interrupted or timed-out bounded wait leaves the execution
 * provably unobserved, which reads as `running`.
 */
export function isInterruptedLongPoll(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true
  const message = error.message.toLowerCase()
  return message.includes('timed out') || message.includes('socket connection was closed')
}

export async function waitForCommandExit(
  command: Pick<VercelCommand, 'wait'>,
  expired: () => boolean,
  opts?: { signal?: AbortSignal },
): Promise<{ exitCode: number }> {
  for (;;) {
    try {
      return await command.wait(opts?.signal === undefined ? {} : { signal: opts.signal })
    } catch (error) {
      if (!isInterruptedLongPoll(error) || expired()) throw error
    }
  }
}

/** Narrow re-observation surface of one recorded detached command. The
 * provider's plain lookup reports `exitCode: null` for a command that finished
 * while no client was waiting on it, and keeps reporting none until some
 * client issues `wait` — a caller may not conclude `running` from
 * `exitCode: null` without first issuing a wait, whose resolution carries the
 * populated exit code. The SDK's `Command` satisfies this structurally. */
export interface VercelCommandLookup {
  exitCode: number | null
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>
  /** Completed-command output, when the concrete handle exposes it (the SDK's
   * `Command` does; narrow lookups may omit it). Read only after exit. */
  stdout?(): Promise<string>
  stderr?(): Promise<string>
}

export interface VercelSandboxHandle {
  readonly name: string
  /** The session's default working directory, where the server places a git
   * source checkout. Managed images differ (`/vercel/sandbox` on the language
   * images, `/vercel` on universal), so the checkout is located through it. */
  readonly cwd?: string
  currentSession?(): { sessionId: string }
  /** Status of the session this handle observed, captured at `facade.get`
   * time. Optional: facades without session metadata omit it. */
  readonly sessionStatus?:
    | 'failed'
    | 'aborted'
    | 'pending'
    | 'running'
    | 'stopping'
    | 'stopped'
    | 'snapshotting'
  /** The provider-computed moment the running session times out (epoch ms;
   * the SDK Sandbox's `expiresAt` getter, session start plus configured
   * timeout). Optional: facades without session metadata omit it, and it is
   * `undefined` while no session is running. Read live so a refreshed handle
   * — including one carrying a resumed session's new expiry — reports fresh
   * values on every observation. */
  readonly sessionExpiresAt?: number
  /** Narrowed re-observation of one recorded detached command. A missing
   * command under a resumed session rejects; callers classify that as `lost`.
   * The plain lookup reports no exit code for a command that finished while no
   * client was waiting on it, and keeps reporting none until some client
   * issues `wait` — a caller may not conclude `running` from `exitCode: null`
   * without first issuing a wait. */
  getCommand(cmdId: string, opts?: { signal?: AbortSignal }): Promise<VercelCommandLookup>
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
    params: { networkPolicy?: NetworkPolicy; timeout?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>
  /** Add `duration` ms to the running session's lifetime (SDK
   * `extendTimeout`: additive, never a set). */
  extendTimeout(duration: number, opts?: { signal?: AbortSignal }): Promise<void>
}

export type VercelSandboxCreateInput = {
  name: string
  /** Absent starts a sandbox without a git source (SDK 3.1.0); only the
   * deployment-fallback operator sandbox omits it and clones in the guest. */
  source?: {
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
  /** Snapshot expiration in milliseconds for this environment's automatic
   * snapshots (SDK `snapshotExpiration`); absent means the provider default. */
  snapshotExpiration?: number
  /** Retention bound for this environment's automatic snapshots. Snapshots
   * are created whenever a session stops, and `Sandbox.delete()` never removes
   * them; the bound keeps a live environment at exactly what resuming it
   * needs. Release purges even this snapshot. */
  keepLastSnapshots: { count: number; deleteEvicted: boolean }
}

/** Snapshots retained for a live environment: exactly the one resuming it
 * needs. Each session stop supersedes the previous snapshot, so stops along
 * the build never accumulate one snapshot per stop. */
export const VERCEL_KEEP_LAST_SNAPSHOTS = 1

/** The stop/snapshot margin added to the environment's configured lifetime by
 * every VM-lifetime deadline: a command or observation may legitimately still
 * resolve while the environment is being stopped or snapshotted, but past
 * session expiry plus this margin it cannot still be running. Shared by the
 * command path and the observation path so the two bounds cannot drift. */
export const VERCEL_LIFETIME_MARGIN_MS = 5 * 60 * 1000

/** The bound on the observation path's single wait on a recorded command
 * whose plain lookup reports no exit code. A few seconds: long enough to
 * observe an already-exited guest, far below the tick's operation timeout so
 * one observation never approaches it. A genuinely running guest costs this
 * much per observation; the next tick retries. */
export const VERCEL_OBSERVE_WAIT_MS = 5_000

/** The expected wall time of one build `provision`: clone, Bun, system steps,
 * distribution, dependencies, runtime installs and a snapshot stop typically
 * take two to three minutes. A bounded dispatcher invocation won't start
 * provisioning with less budget left. It errs low: an estimate too high would
 * starve builds whenever pre-dispatch tick work is slow, while one slightly
 * too low only costs an uncharged teardown abandonment the next invocation
 * finishes. */
export const VERCEL_PROVISION_ESTIMATE_MS = 150_000

/** The snapshot rows that hold billed storage. `deleted`/`failed` rows hold
 * none and are never purge targets. */
const LIVE_SNAPSHOT_STATUS = 'created'

/** Bounded list→delete→re-list repetitions that absorb the provider's
 * snapshot materialization lag between a session stop and its snapshot
 * becoming listed. */
const SNAPSHOT_PURGE_PASSES = 3

export interface VercelSnapshotInfo {
  id: string
  sourceSessionId: string
  status: 'created' | 'deleted' | 'failed'
  sizeBytes?: number
}

/** Result of purging one environment's snapshots by exact name. `unknown`
 * never silently claims confirmation. */
export interface VercelSnapshotPurge {
  outcome: 'confirmed' | 'unknown'
  deleted: number
  error?: string
}

export interface VercelSandboxFacade {
  get(name: string, signal?: AbortSignal): Promise<VercelSandboxHandle | null>
  /** Creation never deletes an existing named environment. */
  create(input: VercelSandboxCreateInput): Promise<VercelSandboxHandle>
  /** Dispatcher-authorized destruction only, after fence and commit receipt. */
  deleteByName?(name: string, signal?: AbortSignal): Promise<'confirmed' | 'absent'>
  /** Readiness always acquires a new unnamed disposable environment. */
  createFresh?(
    input: Omit<VercelSandboxCreateInput, 'name' | 'persistent'>,
  ): Promise<VercelSandboxHandle>
  /** Snapshots listed under the exact sandbox name — the deterministic
   * per-environment purge key. */
  listSnapshots(name: string, signal?: AbortSignal): Promise<VercelSnapshotInfo[]>
  deleteSnapshot(snapshotId: string, signal?: AbortSignal): Promise<void>
}

/** The team and project a Vercel OIDC token was issued for, read from its
 * unverified payload exactly as the Sandbox SDK does (`owner_id`,
 * `project_id`). Null when the value is not a decodable JWT carrying both. */
export function vercelOidcTokenScope(token: string): { teamId: string; projectId: string } | null {
  const payload = token.split('.')[1]
  if (payload === undefined || payload === '') return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      owner_id?: unknown
      project_id?: unknown
    }
    if (typeof claims.owner_id !== 'string' || typeof claims.project_id !== 'string') return null
    return { teamId: claims.owner_id, projectId: claims.project_id }
  } catch {
    return null
  }
}

/** Credentials handed to every Sandbox SDK call. An OIDC token in the
 * dispatcher environment is passed explicitly with the team and project from
 * its claims — the SDK's own `VERCEL_OIDC_TOKEN` lookup reads the process
 * environment, which is not where a hosted invocation carries its token (a
 * Vercel Function receives it as a request header). A token whose claims
 * cannot be read is left to the SDK's own resolution. */
export function vercelSdkCredentials(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const oidcToken = env.VERCEL_OIDC_TOKEN
  if (oidcToken) {
    const scope = vercelOidcTokenScope(oidcToken)
    return scope === null ? {} : { token: oidcToken, ...scope }
  }
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

/** The SDK's session metadata is a live getter on the returned object, but the
 * adapter's handle interface names it `sessionStatus`. Bridge it in place so
 * every facade-returned handle carries fresh session state for observation. */
function withSessionMetadata(sandbox: object): VercelSandboxHandle {
  const status = () => (sandbox as { status?: VercelSandboxHandle['sessionStatus'] }).status
  if (status() !== undefined && !Object.hasOwn(sandbox, 'sessionStatus')) {
    Object.defineProperty(sandbox, 'sessionStatus', { get: status, configurable: true })
  }
  // The SDK computes `expiresAt` itself from the authoritative session fields
  // (`(startedAt ?? createdAt) + timeout` while a session is running); bridge
  // it as a live getter so observations never see a stale lifetime.
  const expiresAt = () => (sandbox as { expiresAt?: Date | undefined }).expiresAt?.getTime()
  if (expiresAt() !== undefined && !Object.hasOwn(sandbox, 'sessionExpiresAt')) {
    Object.defineProperty(sandbox, 'sessionExpiresAt', { get: expiresAt, configurable: true })
  }
  return sandbox as VercelSandboxHandle
}

export function isUnavailableVercelSnapshot(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as {
    response?: { status?: number }
    json?: { error?: { code?: string } }
  }
  return candidate.response?.status === 410 && candidate.json?.error?.code === 'snapshot_not_found'
}

/** Confirmed filesystem absence; an expired snapshot may still reserve the name. */
export function isMissingVercelSandbox(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as {
    response?: { status?: number }
    json?: { error?: { code?: string } }
  }
  return candidate.response?.status === 404 || isUnavailableVercelSnapshot(error)
}

export function createVercelSdkFacade(
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): VercelSandboxFacade {
  const credentials = vercelSdkCredentials(env)
  return {
    async get(name, signal) {
      try {
        return withSessionMetadata(
          await Sandbox.get({ name, signal, resume: false, fetch, ...credentials }),
        )
      } catch (error) {
        // Provision must retain the stale name so dispatcher cleanup can delete it.
        if (isUnavailableVercelSnapshot(error)) throw error
        if (isMissingVercelSandbox(error)) return null
        throw error
      }
    },
    async create(input) {
      return withSessionMetadata(
        await Sandbox.create({
          ...input,
          region: input.region as SandboxRegion | undefined,
          failoverRegions: input.failoverRegions as SandboxRegion[] | undefined,
          fetch,
          ...credentials,
        }),
      )
    },
    async deleteByName(name, signal) {
      const { token, projectId, teamId } = credentials
      if (!token || !projectId || !teamId)
        throw new Error(
          'sandbox deletion requires explicitly resolved credentials and project scope',
        )
      const url = new URL(`https://vercel.com/api/v2/sandboxes/${encodeURIComponent(name)}`)
      url.searchParams.set('projectId', projectId)
      url.searchParams.set('teamId', teamId)
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      })
      if (response.status === 404 || response.status === 410) return 'absent'
      if (!response.ok) throw new Error(`sandbox deletion failed with HTTP ${response.status}`)
      return 'confirmed'
    },
    async createFresh(input) {
      return withSessionMetadata(
        await Sandbox.create({
          ...input,
          region: input.region as SandboxRegion | undefined,
          failoverRegions: input.failoverRegions as SandboxRegion[] | undefined,
          fetch,
          ...credentials,
        }),
      )
    },
    async listSnapshots(name, signal) {
      // The API rejects `limit` above 50; `toArray()` walks every page.
      const page = await Snapshot.list({
        name,
        limit: 50,
        fetch,
        ...(signal === undefined ? {} : { signal }),
        ...credentials,
      })
      return (await page.toArray()).map((snapshot) => ({
        id: snapshot.id,
        sourceSessionId: snapshot.sourceSessionId,
        status: snapshot.status,
        ...(typeof snapshot.sizeBytes === 'number' && Number.isFinite(snapshot.sizeBytes)
          ? { sizeBytes: snapshot.sizeBytes }
          : {}),
      }))
    },
    async deleteSnapshot(snapshotId, signal) {
      const snapshot = await Snapshot.get({ snapshotId, fetch, ...credentials })
      await snapshot.delete(signal === undefined ? {} : { signal })
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Delete every `created` snapshot listed under the exact sandbox name, then
 * re-list to prove absence, repeating a bounded number of times to absorb the
 * provider's snapshot materialization lag. Any SDK failure — or a name that
 * still lists live snapshots after the bounded passes — is reported as
 * `unknown` so callers can retry rather than silently claim a purge.
 */
export async function purgeEnvironmentSnapshots(
  facade: VercelSandboxFacade,
  name: string,
  signal?: AbortSignal,
): Promise<VercelSnapshotPurge> {
  let deleted = 0
  for (let pass = 0; ; pass += 1) {
    let listed: VercelSnapshotInfo[]
    try {
      listed = await facade.listSnapshots(name, signal)
    } catch (error) {
      return { outcome: 'unknown', deleted, error: describeError(error) }
    }
    const live = listed.filter((snapshot) => snapshot.status === LIVE_SNAPSHOT_STATUS)
    if (live.length === 0) return { outcome: 'confirmed', deleted }
    if (pass >= SNAPSHOT_PURGE_PASSES) {
      return {
        outcome: 'unknown',
        deleted,
        error:
          `${live.length} snapshot(s) still listed under ${JSON.stringify(name)} ` +
          `after ${SNAPSHOT_PURGE_PASSES} purge passes`,
      }
    }
    for (const snapshot of live) {
      try {
        await facade.deleteSnapshot(snapshot.id, signal)
        deleted += 1
      } catch (error) {
        return { outcome: 'unknown', deleted, error: describeError(error) }
      }
    }
  }
}

const cleanGithubOrigin = validateVercelGithubOrigin

/** The build slug a build branch names: leaves use `ab/<slug>`, integration
 * nodes `ab-node/<slug>`. The delegation target must name the build itself. */
function buildSlugFromBranch(branch: string): string {
  return branch.replace(/^ab(?:-node)?\//, '')
}

function sandboxName(origin: string, branch: string, generation = 0): string {
  // Deliberately strips only the leaf prefix, unlike `buildSlugFromBranch`:
  // changing the readable label would rename, and so orphan, live node sandboxes.
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

/** Deterministic harvest environment name: one per repository origin, with
 * the same digest slicing and charset discipline as `sandboxName`. The name
 * is the get-or-create key and the exact snapshot purge key. */
export function harvestSandboxName(origin: string): string {
  const digest = createHash('sha256').update(origin).digest('hex').slice(0, 10)
  return `autobuild-harvest-${digest}`.slice(0, 63)
}

/** Deterministic operator-sandbox environment name: one per (repository
 * origin, operator) — the same digest over the two identities with the same
 * slicing/charset/63-char rules as the build and harvest names. The name is
 * the get-or-create key and the exact snapshot purge key. */
export function sandboxEnvironmentName(origin: string, operator: string): string {
  const digest = createHash('sha256').update(`${origin}\0${operator}`).digest('hex').slice(0, 10)
  return `autobuild-sandbox-${digest}`.slice(0, 63)
}

/** Hard ceiling on one operator-sandbox command wait (`exec`'s
 * `timeoutSeconds` and `wait`'s `waitSeconds`), in seconds. The service
 * validates against the same bound. */
export const SANDBOX_MAX_WAIT_SECONDS = 300

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

/** Default checkout root when the handle does not report its session cwd. */
const VERCEL_DEFAULT_CWD = '/vercel/sandbox'

/** Where the server checked out the git source: the session cwd plus the
 * repository directory name. Never assume the image's working directory. */
export function sourceCheckoutPath(sandbox: VercelSandboxHandle, directory: string): string {
  const root = (sandbox.cwd ?? '').trim().replace(/\/+$/, '') || VERCEL_DEFAULT_CWD
  return `${root}/${directory}`
}

/**
 * Move the server's checkout to the adapter-owned workspace path. The
 * workspace parent is created first: the universal image has no
 * `/vercel/sandbox` directory of its own.
 */
async function relocateCheckout(
  sandbox: VercelSandboxHandle,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const sourcePath = sourceCheckoutPath(sandbox, directory)
  try {
    await commandOrThrow(sandbox, {
      cmd: 'sh',
      args: [
        '-c',
        'mkdir -p "$(dirname "$2")" && mv "$1" "$2"',
        'relocate',
        sourcePath,
        VERCEL_WORKSPACE_PATH,
      ],
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw new Error(
      `vercel-sandbox could not move the checkout ${sourcePath} to ${VERCEL_WORKSPACE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/** Clone the bare HTTPS origin inside the guest with no credential in argv,
 * env or git config; the host-side upload-pack egress transform authenticates
 * the two upload-pack requests. `GIT_TERMINAL_PROMPT=0` makes a missing
 * transform fail fast instead of prompting. */
async function guestCloneCheckout(
  sandbox: VercelSandboxHandle,
  url: string,
  head: string,
): Promise<void> {
  await commandOrThrow(sandbox, {
    cmd: 'mkdir',
    args: ['-p', VERCEL_WORKSPACE_PATH.slice(0, VERCEL_WORKSPACE_PATH.lastIndexOf('/'))],
  })
  await commandOrThrow(sandbox, {
    cmd: 'git',
    args: ['clone', '--no-checkout', url, VERCEL_WORKSPACE_PATH],
    env: { GIT_TERMINAL_PROMPT: '0' },
  })
  await commandOrThrow(sandbox, {
    cmd: 'git',
    args: ['-C', VERCEL_WORKSPACE_PATH, 'checkout', '--detach', head],
  })
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

/** The trimmed `bun --version` output of the provisioned executable, or
 * undefined when it cannot run or prints nothing. */
async function reportedBunVersion(
  sandbox: VercelSandboxHandle,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const version = (
      await readableCommand(sandbox, {
        cmd: VERCEL_BUN_EXECUTABLE,
        args: ['--version'],
        ...(signal === undefined ? {} : { signal }),
      })
    ).trim()
    return version === '' ? undefined : version
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
}

function describeBunVersion(version: string | undefined): string {
  return version === undefined ? 'no version' : version
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
  const reported = await reportedBunVersion(sandbox, signal)
  if (reported !== VERCEL_BUN_VERSION) {
    throw bunProvisioningError(
      image,
      'verify provisioned',
      new Error(
        `vercel-sandbox provisioned Bun reports ${describeBunVersion(reported)} but the pin is ${VERCEL_BUN_VERSION} on image ${JSON.stringify(image)}`,
      ),
    )
  }
}

function runtimeEnvironment(
  config: VercelSandboxConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    config.environmentVariables
      .filter((name) => !['AB_TOKEN', 'AB_TICKET_URL', 'AB_TICKET_TOKEN'].includes(name))
      .map((name) => [name, requireVercelEnvironmentValue(env, name)]),
  )
}

function redactRuntimeError(error: unknown, env: Record<string, string>): string {
  let detail = error instanceof Error ? error.message : String(error)
  for (const value of Object.values(env).sort((a, b) => b.length - a.length)) {
    if (value !== '') detail = detail.split(value).join('[REDACTED]')
  }
  return detail
}

/** Bootstrap the workspace runtime references with the build path's
 * install/preflight chain. `env` is the already-resolved guest environment:
 * callers decide which names a guest may see — the build and harvest paths
 * forward `[workspace.config].environmentVariables`, while the operator
 * sandbox passes its credential-free forwarded set only (build-workspace
 * variables never enter a sandbox). */
async function bootstrapRuntimes(
  sandbox: VercelSandboxHandle,
  config: VercelSandboxConfig,
  env: Record<string, string>,
  references: readonly RuntimeReferenceGroup[],
  install: boolean,
  signal?: AbortSignal,
): Promise<void> {
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

/** Bring a reused sandbox's Bun to exactly the pin before any guest command
 * runs with it. A matching `bun --version` costs one command; any other
 * report (a stale pin, a missing or unrunnable executable) is reinstalled at
 * the pin with the provisioning recipe. The comparison is exact, so a partly
 * applied upgrade is never accepted by this or any later preflight. */
async function ensurePinnedBun(
  sandbox: VercelSandboxHandle,
  image: string,
  signal?: AbortSignal,
): Promise<void> {
  const reported = await reportedBunVersion(sandbox, signal)
  if (reported === VERCEL_BUN_VERSION) return
  try {
    await provisionBun(sandbox, image, signal)
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    throw new Error(
      `vercel-sandbox Bun preflight on image ${JSON.stringify(image)} found ${describeBunVersion(reported)} (pin ${VERCEL_BUN_VERSION}) and could not bring it to the pin: ${
        cause instanceof Error ? cause.message : String(cause)
      }; release and reprovision this sandbox before retrying the build`,
      { cause: error },
    )
  }
}

export interface VercelReadinessOptions {
  accounts?: import('../../config/accounts').Accounts
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
  /** Automatic snapshots deleted while releasing the disposable environment;
   * zero proves the readiness check left no snapshot storage behind. */
  snapshotsDeleted: number
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

/** The commit the guest checkout is actually on: HEAD and the build branch
 * must resolve to the same commit, which is the only base a provisioning
 * fact may record (AUT-1252). */
async function checkedOutBranchHead(
  sandbox: VercelSandboxHandle,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const stdout = await readableCommand(sandbox, {
    cmd: 'git',
    args: ['rev-parse', 'HEAD^{commit}', `refs/heads/${branch}^{commit}`],
    cwd: VERCEL_WORKSPACE_PATH,
    ...(signal ? { signal } : {}),
  })
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
  if (lines.length !== 2 || !lines.every((line) => objectId.test(line)))
    throw new Error(`unreadable checkout head for ${branch}: ${JSON.stringify(stdout.trim())}`)
  const [head, branchHead] = lines as [string, string]
  if (head !== branchHead)
    throw new Error(`checkout HEAD ${head} disagrees with ${branch} at ${branchHead}`)
  return head
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
  const readinessAccountPolicy = accountPolicy('allow-all', options.accounts ?? {}, options.env)
  if (readinessAccountPolicy.missing.length)
    throw new Error(`Missing credentials: ${readinessAccountPolicy.missing.join('; ')}`)
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
    ...(config.snapshotExpirationSeconds === undefined
      ? {}
      : { snapshotExpiration: config.snapshotExpirationSeconds * 1000 }),
    networkPolicy: readinessAccountPolicy.policy,
    keepLastSnapshots: { count: VERCEL_KEEP_LAST_SNAPSHOTS, deleteEvicted: true },
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
    await relocateCheckout(sandbox, origin.directory, options.signal)
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
    const archive = await effectiveArchive(options.packageArchive)
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
      accountGuestEnvironment(
        runtimeEnvironment(config, options.env),
        options.accounts ?? {},
        options.env,
      ),
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
        env: {
          ...accountGuestEnvironment(
            runtimeEnvironment(config, options.env),
            options.accounts ?? {},
            options.env,
          ),
          AB_STORE: options.storeRef,
          AB_TOKEN: options.storeToken,
          ...(options.env[HOSTED_ACCOUNT_READINESS_ENV]
            ? { [HOSTED_ACCOUNT_READINESS_ENV]: options.env[HOSTED_ACCOUNT_READINESS_ENV] }
            : {}),
        },
      }),
    )
    readiness = {
      sandbox: name,
      revision,
      origin: origin.url,
      provisioning,
      output: setup,
      snapshotsDeleted: 0,
    }
  } catch (error) {
    failure = error
  }
  // Release with zero snapshot storage left behind. Stop first: it ends the
  // session deterministically, so no new snapshot can appear after the purge.
  // Deleting a running sandbox instead stops its session and thereby creates
  // exactly the orphan this sequence exists to prevent. A purge failure is a
  // release failure and surfaces the same manual-remediation guidance.
  const releaseErrors: unknown[] = []
  let snapshotsDeleted = 0
  try {
    await sandbox.stop()
  } catch (stopError) {
    releaseErrors.push(stopError)
  }
  for (const pass of ['pre-delete', 'post-delete'] as const) {
    const purged = await purgeEnvironmentSnapshots(facade, name)
    if (purged.outcome === 'unknown') {
      releaseErrors.push(
        new Error(
          `disposable sandbox ${name} ${pass} snapshot purge did not confirm: ${purged.error ?? 'unknown outcome'}`,
        ),
      )
    }
    snapshotsDeleted += purged.deleted
    if (pass === 'pre-delete') {
      try {
        await sandbox.delete()
      } catch (deleteError) {
        releaseErrors.push(deleteError)
      }
    }
  }
  if (releaseErrors.length > 0) {
    const guidance =
      `disposable sandbox ${name} could not be fully released; ` +
      `delete it manually in the Vercel dashboard or with: vercel sandbox rm ${name}, ` +
      'and delete any snapshots remaining under its name (they keep incurring storage ' +
      'until deleted or expired)'
    if (failure !== undefined) throw new AggregateError([failure, ...releaseErrors], guidance)
    if (releaseErrors.length === 1) {
      throw new Error(guidance, { cause: releaseErrors[0] })
    }
    throw new AggregateError(releaseErrors, guidance)
  }
  if (failure !== undefined) {
    throw new Error(
      `disposable sandbox ${name} was deleted after validation failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    )
  }
  return { ...readiness!, snapshotsDeleted }
}

export type { RuntimeReferencesSource } from './provider-capabilities'

/** Install the distribution archive into `/opt/autobuild` and record its
 * identity marker. Shared by fresh provisioning, reuse-path refreshes, and
 * the restart path; the readback comparison guards a silently failed write or
 * extraction. */
async function installDistribution(
  sandbox: VercelSandboxHandle,
  archive: Uint8Array,
  identity: string,
  signal?: AbortSignal,
): Promise<void> {
  await sandbox.writeFiles([{ path: '/tmp/autobuild.tgz', content: archive }], {
    ...(signal === undefined ? {} : { signal }),
  })
  await commandOrThrow(sandbox, {
    cmd: 'mkdir',
    args: ['-p', VERCEL_AUTOBUILD_PATH],
    ...(signal === undefined ? {} : { signal }),
  })
  await commandOrThrow(sandbox, {
    cmd: 'tar',
    args: ['-xzf', '/tmp/autobuild.tgz', '--strip-components=1', '-C', VERCEL_AUTOBUILD_PATH],
    ...(signal === undefined ? {} : { signal }),
  })
  await commandOrThrow(sandbox, {
    cmd: VERCEL_BUN_EXECUTABLE,
    args: ['install', '--production', '--ignore-scripts'],
    cwd: VERCEL_AUTOBUILD_PATH,
    ...(signal === undefined ? {} : { signal }),
  })
  await writeDistributionVersionMarker(sandbox, identity, signal)
}

async function writeDistributionVersionMarker(
  sandbox: VercelSandboxHandle,
  identity: string,
  signal?: AbortSignal,
): Promise<void> {
  await commandOrThrow(sandbox, {
    cmd: 'sh',
    args: [
      '-c',
      'printf %s "$1" > "$2"',
      'distribution-version',
      identity,
      VERCEL_DISTRIBUTION_VERSION_MARKER,
    ],
    ...(signal === undefined ? {} : { signal }),
  })
  const readback = await readableCommand(sandbox, {
    cmd: 'cat',
    args: [VERCEL_DISTRIBUTION_VERSION_MARKER],
    ...(signal === undefined ? {} : { signal }),
  })
  if (readback.trim() !== identity) {
    throw new Error(
      `distribution identity marker readback mismatch in ${VERCEL_DISTRIBUTION_VERSION_MARKER}: ` +
        `wrote ${JSON.stringify(identity)} but read ${JSON.stringify(readback.trim())}`,
    )
  }
}

/** The installed distribution's identity stamp, or `undefined` when the marker
 * is unreadable — which includes every guest provisioned before the marker
 * existed and is treated as a mismatch by the reuse and restart paths. */
async function readDistributionVersionMarker(
  sandbox: VercelSandboxHandle,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const content = await readableCommand(sandbox, {
      cmd: 'cat',
      args: [VERCEL_DISTRIBUTION_VERSION_MARKER],
      ...(signal === undefined ? {} : { signal }),
    })
    const trimmed = content.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/** The archive bytes a provider installs: the injected test archive when
 * present, else the per-process memoized running distribution archive
 * (`resolveDistributionArchive`), so a deployment without an injected archive
 * packs or fetches once per process rather than once per install site. */
async function effectiveArchive(
  packageArchive: (() => Promise<Uint8Array>) | undefined,
): Promise<Uint8Array> {
  if (packageArchive) return packageArchive()
  return (await resolveDistributionArchive()).archive
}

// ── Operator sandbox provisioning state (#1246) ─────────────────────────────
//
// A hosted deployment composes the provider per warm function instance and
// may freeze it after the response, so provisioning state lives in the
// guest, where any process can read it with one probe command. The host
// phase (create, checkout, scrub, Bun, system provisioning, distribution)
// runs in the caller's background; the slow tail (dependencies, runtimes,
// setup, marker) runs as one detached guest command bounded only by the
// session timer.

/** The guest directory holding one fresh provision's state, outside the
 * checkout: `host` (`<step> <guest epoch seconds>`, the host phase's
 * heartbeat), one `stage-NN-<name>.sh` per tail stage, `tail.sh`, the
 * tail's `pid`, `stage`, `log` and `failed` files, and `resuming` (the guest
 * epoch at which a runtime refresh of a provisioned environment started),
 * which outranks the success marker until that refresh succeeds. */
export const VERCEL_OPERATOR_PROVISION_DIR = `${VERCEL_AUTOBUILD_PATH}/operator-provision`
/** Heartbeat age after which a host phase with no running tail counts as
 * interrupted: above the 300-second hosted function limit, and every host
 * step refreshes the heartbeat. A host step longer than this on a long-lived
 * local `ab mcp` can be judged interrupted by another process; the journal's
 * compare-and-append still settles it once and the next open recovers. */
export const VERCEL_OPERATOR_HOST_STALE_SECONDS = 600
/** Grace after the `launched` heartbeat for the detached tail to record its
 * pid before a missing tail counts as interrupted. */
export const VERCEL_OPERATOR_LAUNCH_GRACE_SECONDS = 30

/** Host-phase heartbeat steps. `launched` follows the tail launch. */
type OperatorHostStep = 'checkout' | 'provision' | 'launched'

const PROVISION_STAGES: readonly SandboxProvisionStage[] = [
  'checkout',
  'setup',
  'environment',
  'resume',
  'provision',
]

/** One classified probe of an operator sandbox's guest state. Rows are
 * checked in order and the first match wins: a recorded failure always
 * outranks an older success marker. */
export type VercelOperatorProbe =
  | { kind: 'failed'; record: string; log: string }
  | { kind: 'resuming'; ageSeconds: number }
  | {
      kind: 'ready'
      marker: { baseSha?: string }
      headSha?: string
      bunVersion?: string
      distribution?: string
    }
  | { kind: 'running'; stage?: string }
  | { kind: 'host'; step: string; ageSeconds: number }
  | { kind: 'none' }

/** The read-only probe, run as `sh -c <script> probe <dir> <marker>
 * <workspace> <bun> <distribution marker>` with no environment. File
 * contents ride base64-encoded so the parser never sees raw guest bytes;
 * ages come from the guest clock. */
export const VERCEL_OPERATOR_PROBE_SCRIPT = [
  'd=$1',
  'enc() { base64 | tr -d "\\n"; }',
  'if [ -f "$d/failed" ]; then',
  '  echo "result failed"',
  '  printf "failed %s\\n" "$(head -c 4096 "$d/failed" | enc)"',
  '  printf "log %s\\n" "$(tail -c 4096 "$d/log" 2>/dev/null | enc)"',
  '  exit 0',
  'fi',
  'if [ -f "$d/resuming" ]; then',
  '  echo "result resuming"',
  '  printf "resuming %s\\n" "$(head -n 1 "$d/resuming")"',
  '  printf "now %s\\n" "$(date +%s)"',
  '  exit 0',
  'fi',
  'if [ -f "$2" ]; then',
  '  echo "result ready"',
  '  printf "marker %s\\n" "$(head -c 4096 "$2" | enc)"',
  '  printf "head %s\\n" "$(git -C "$3" rev-parse HEAD 2>/dev/null)"',
  '  printf "bun %s\\n" "$("$4" --version 2>/dev/null | head -n 1)"',
  '  printf "distribution %s\\n" "$(head -n 1 "$5" 2>/dev/null)"',
  '  exit 0',
  'fi',
  'pid=$(cat "$d/pid" 2>/dev/null)',
  'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q tail.sh "/proc/$pid/cmdline" 2>/dev/null; then',
  '  echo "result running"',
  '  printf "stage %s\\n" "$(head -n 1 "$d/stage" 2>/dev/null)"',
  '  exit 0',
  'fi',
  'if [ -f "$d/host" ]; then',
  '  echo "result host"',
  '  printf "host %s\\n" "$(head -n 1 "$d/host")"',
  '  printf "now %s\\n" "$(date +%s)"',
  '  exit 0',
  'fi',
  'echo "result none"',
].join('\n')

/** Parse the probe's `key value` lines. Unparseable output is `none`. */
export function parseVercelOperatorProbe(stdout: string): VercelOperatorProbe {
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ')
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1).trim())
  }
  const decode = (value: string | undefined): string =>
    value === undefined || value === '' ? '' : Buffer.from(value, 'base64').toString('utf8')
  const optional = (value: string | undefined): string | undefined =>
    value === undefined || value === '' ? undefined : value
  switch (fields.get('result')) {
    case 'failed':
      return {
        kind: 'failed',
        record: decode(fields.get('failed')),
        log: decode(fields.get('log')),
      }
    case 'ready': {
      let marker: { baseSha?: string } = {}
      try {
        const parsed = JSON.parse(decode(fields.get('marker'))) as { baseSha?: unknown }
        if (typeof parsed?.baseSha === 'string' && /^[0-9a-f]{40,64}$/.test(parsed.baseSha))
          marker = { baseSha: parsed.baseSha }
      } catch {
        // A legacy empty marker records no base head.
      }
      const headSha = optional(fields.get('head'))
      const bunVersion = optional(fields.get('bun'))
      const distribution = optional(fields.get('distribution'))
      return {
        kind: 'ready',
        marker,
        ...(headSha !== undefined && /^[0-9a-f]{40,64}$/.test(headSha) ? { headSha } : {}),
        ...(bunVersion !== undefined ? { bunVersion } : {}),
        ...(distribution !== undefined ? { distribution } : {}),
      }
    }
    case 'resuming': {
      const since = Number(fields.get('resuming'))
      const now = Number(fields.get('now'))
      return {
        kind: 'resuming',
        ageSeconds:
          Number.isFinite(since) && Number.isFinite(now) && fields.get('resuming') !== ''
            ? Math.max(0, now - since)
            : 0,
      }
    }
    case 'running': {
      const stage = optional(fields.get('stage'))
      return { kind: 'running', ...(stage !== undefined ? { stage } : {}) }
    }
    case 'host': {
      const [step = '', at = ''] = (fields.get('host') ?? '').split(/\s+/)
      const now = Number(fields.get('now'))
      const then = Number(at)
      const ageSeconds =
        Number.isFinite(now) && Number.isFinite(then) && at !== '' ? Math.max(0, now - then) : 0
      return { kind: 'host', step, ageSeconds }
    }
    default:
      return { kind: 'none' }
  }
}

/** The file-safe form of a runtime name inside a tail stage name. */
function tailRuntimeName(runtime: string): string {
  return runtime.replace(/[^A-Za-z0-9._-]+/g, '_')
}

/** Single-quote one value for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** A host-phase failure, already recorded in the guest when `created`. */
class OperatorHostFailure extends Error {
  override readonly name = 'OperatorHostFailure'
  constructor(
    readonly failure: { stage: SandboxProvisionStage; message: string },
    readonly created: boolean,
    cause: unknown,
  ) {
    super(failure.message, { cause })
  }
}

/** A host phase stopped by `close` or `release`. */
class OperatorAttemptCancelled extends Error {
  override readonly name = 'OperatorAttemptCancelled'
  constructor(readonly created: boolean) {
    super('operator sandbox provisioning was cancelled')
  }
}

const DEPENDENCY_INSTALL_COMMAND = `if [ -f bun.lock ] || [ -f bun.lockb ]; then ${VERCEL_BUN_EXECUTABLE} install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable; fi`

export interface VercelSandboxProviderOptions {
  delegateCredential?: typeof delegateCredential
  config: VercelSandboxConfig
  env: Record<string, string | undefined>
  storeRef: string
  storeToken?: string
  /** Dispatcher-local main checkout, used only for origin discovery and verification.
   * With the injected `origin`/`remoteBranchHead` seams (checkout-less origin
   * mode) it is never touched on the host. */
  repo: string
  facade?: VercelSandboxFacade
  exec?: Exec
  packageArchive?: () => Promise<Uint8Array>
  accounts?: () => import('../../config/accounts').Accounts
  executionAccounts?: () => import('../../config/accounts').Accounts
  runtimeReferences?: RuntimeReferencesSource
  /** Checkout-less seam: the repository's HTTPS GitHub origin. Default reads
   * `git remote get-url origin` from `repo` on the host. */
  origin?: () => Promise<string>
  /** Checkout-less seam: the remote branch's current head, `undefined` when
   * the branch does not exist. Default runs `git ls-remote` from `repo` on
   * the host. */
  remoteBranchHead?: (branch: string) => Promise<string | undefined>
  /** Host-side archive fallback, called only after the guest git transport
   * refuses an exact archive push. It must create exactly that ref at that SHA,
   * create-only, and the guest's exact readback still decides publication. */
  refusedArchive?: (ref: string, sha: string) => Promise<void>
  /** Test seam: the distribution identity stamp the current archive source
   * delivers (package version plus remote-store protocol version plus the
   * sha256 digest of the archive bytes, see `readDistributionIdentityStamp`).
   * Default computes the stamp over the effective archive source (origin mode
   * keys the guest archive to the running version; source mode packs the same
   * tree `readDistributionIdentity` reads), so the stamp and the installed
   * bytes agree by construction. */
  distributionIdentity?: () => Promise<string>
  /** Test seam: the bound on the observation path's wait on a command whose
   * lookup shows no exit. Defaults to `VERCEL_OBSERVE_WAIT_MS`. */
  observeWaitMs?: number
  /** Test seam: the expected wall time of one `provision`. Defaults to
   * `VERCEL_PROVISION_ESTIMATE_MS`. */
  provisionEstimateMs?: number
  /** The repository's raw `[commands].setup` shell string, run once at the end
   * of a fresh operator-sandbox provision (never on resume). Set once at
   * construction; never per call. */
  setupCommand?: string
  /** Names of non-secret host environment variables forwarded into operator
   * sandbox commands (provisioning setup, exec, and start alike). The guest
   * environment is otherwise always built from an empty record — never the
   * process environment — so no credential can leak in. */
  sandboxEnvironmentVariables?: readonly string[]
  /** `[orchestrator.sandbox].idleMinutes` (default 30): the provider timeout
   * an operator sandbox is created and resumed with, extended by every tool
   * call, so the provider's own timer stops an idle sandbox. Build and
   * harvest workspaces keep `timeoutSeconds`. */
  sandboxIdleMinutes?: number
  /** Internal deployment composition only, never user configuration: the git
   * read credential of a hosted deployment's fallback operator sandbox. It is
   * placed only in the host-side upload-pack egress transform (GET
   * `info/refs?service=git-upload-pack` and POST `git-upload-pack`), never in
   * a create `source`, a guest command, or the guest env; the operator
   * sandbox is then created source-less and clones in the guest. Build
   * provisioning never uses it. Mutually exclusive with a configured
   * `gitPasswordEnv`. */
  egressReadCredential?: { username: string; password: string }
}

/** Vercel-backed working copy and executor. Completed SDK command output is
 * read only for readiness/validation reporting and declared system-provisioning
 * failure diagnostics, including failures during durable build provisioning. It
 * is not a durable build-state channel; scoped Store facts/events remain the
 * authoritative build-state channel. */
export class VercelSandboxProvider implements WorkspaceProvider {
  readonly name = 'vercel-sandbox'
  readonly buildExecution: BuildExecution
  readonly harvestExecution: HarvestExecution
  readonly orchestratorSandbox: OperatorSandboxExecution
  readonly publication: WorkspacePublication &
    Required<
      Pick<WorkspacePublication, 'isPublished' | 'rewrite' | 'preserve' | 'recoverCandidate'>
    >
  readonly sandboxPublication: WorkspacePublication
  readonly recovery: import('../types').WorkspaceRecovery
  private readonly facade: VercelSandboxFacade
  private readonly exec: Exec
  private readonly active = new Set<string>()
  private readonly policyLocks = new Map<string, Promise<void>>()

  private async withPolicyLock<T>(ref: string, action: () => Promise<T>): Promise<T> {
    const previous = this.policyLocks.get(ref) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => held)
    this.policyLocks.set(ref, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.policyLocks.get(ref) === queued) this.policyLocks.delete(ref)
    }
  }

  /** A failed stop leaves execution state unknown until a later stop/delete succeeds. */
  private readonly uncertain = new Set<string>()
  private readonly origins = new Map<string, ReturnType<typeof cleanGithubOrigin>>()
  private readonly sessions = new Map<string, VercelSandboxHandle>()
  private readonly observeWaitMs: number
  readonly provisionEstimateMs: number

  /** The archive bytes this provider installs: the injected `packageArchive`
   * seam when set, else the per-process memoized running distribution
   * archive. Every install site routes through here, so the marker digest
   * always describes the bytes actually installed. */
  private archiveBytes(): Promise<Uint8Array> {
    return effectiveArchive(this.options.packageArchive)
  }

  /** The distribution identity stamp to write and compare: the injected
   * `distributionIdentity` seam when set (which pins the stamp independent of
   * the archive), else the default stamp computed over `archiveBytes()` — so
   * a provider that injects only `packageArchive` stamps the bytes it
   * actually installs and the seam divergence class is unrepresentable. */
  private async identityStamp(): Promise<string> {
    if (this.options.distributionIdentity) return this.options.distributionIdentity()
    return distributionStampFor(await this.archiveBytes())
  }

  constructor(private readonly options: VercelSandboxProviderOptions) {
    if (
      !/^https:\/\//i.test(options.storeRef) ||
      (!options.storeToken && !options.delegateCredential)
    ) {
      throw new Error('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
    }
    if (options.egressReadCredential !== undefined && options.config.gitPasswordEnv !== undefined) {
      throw new Error(
        'vercel-sandbox accepts either a deployment egress read credential or a configured gitPasswordEnv, not both',
      )
    }
    this.facade = options.facade ?? createVercelSdkFacade(options.env)
    this.exec = options.exec ?? spawnExec
    this.observeWaitMs = options.observeWaitMs ?? VERCEL_OBSERVE_WAIT_MS
    // Constructor-body assignment, never a field initializer (see the
    // `useDefineForClassFields` note on `sandboxPublication`).
    this.provisionEstimateMs = options.provisionEstimateMs ?? VERCEL_PROVISION_ESTIMATE_MS
    this.buildExecution = {
      start: (input, auth) => this.start(input, auth),
      observe: (identity) =>
        this.withPolicyLock(identity.workspaceRef, () => this.observeExecution(identity)),
    }
    this.harvestExecution = {
      start: (input, auth) => this.startHarvestExecution(input, auth),
      observe: (identity) =>
        this.withPolicyLock(identity.workspaceRef, () => this.observeExecution(identity)),
    }
    this.orchestratorSandbox = {
      lifecycleSupported: true,
      open: (input) => this.openOperator(input),
      status: (input) => this.statusOperator(input),
      close: (input) => this.closeOperator(input),
      refresh: (handle, input) =>
        this.withPolicyLock(handle.environmentId, () => this.refreshOperator(handle, input)),
      describe: (input) => this.describeOperatorSandbox(input),
      ensure: (input) => this.ensureOperatorSandbox(input),
      exec: (handle, request) => this.sandboxExec(handle, request),
      start: (handle, request) => this.sandboxStart(handle, request),
      wait: (handle, input) => this.sandboxWait(handle, input),
      readFile: (handle, path) => this.sandboxReadFile(handle, path),
      writeFile: (handle, path, content) => this.sandboxWriteFile(handle, path, content),
      stop: (input) => this.sandboxStop(input),
      release: (input) => this.sandboxRelease(input),
    }
    this.recovery = {
      fence: async (handle) => {
        if (handle.provider !== this.name) throw new Error('workspace fence provider mismatch')
        try {
          // Never trust the in-process handle after restart or another resume.
          const sandbox = await this.facade.get(handle.ref, this.operationSignal())
          if (sandbox === null) {
            this.forget(handle.ref)
            return { outcome: 'absent' }
          }
          await sandbox.stop({ signal: this.operationSignal() })
          this.active.delete(handle.ref)
          this.uncertain.delete(handle.ref)
          this.sessions.set(handle.ref, sandbox)
          return { outcome: 'confirmed' }
        } catch (error) {
          if (isMissingVercelSandbox(error)) {
            this.forget(handle.ref)
            return { outcome: 'absent' }
          }
          return {
            outcome: 'unknown',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
      reap: (handle: WorkspaceHandle) => {
        if (handle.provider !== this.name) {
          throw new Error(
            `vercel-sandbox cannot reap a workspace owned by provider "${handle.provider}" (${handle.ref})`,
          )
        }
        return this.reap(handle.ref, true)
      },
    }
    this.publication = {
      recoverCandidate: (input) =>
        this.withPolicyLock(input.ref, async () => {
          if (this.active.has(input.ref) || this.uncertain.has(input.ref))
            throw new Error('candidate recovery requires confirmed teardown')
          const sandbox = await this.facade.get(input.ref, this.operationSignal())
          if (!sandbox) throw new Error('candidate recovery awaits replacement workspace')
          return this.withTrustedGit(sandbox, input.ref, async (exec) => {
            const archiveRef = `refs/autobuild/archive/${input.slug}/${input.sha}`
            const available = await inspectGitCandidate({
              ...input,
              exec,
              workspacePath: VERCEL_WORKSPACE_PATH,
              archiveRef,
            })
            if (available)
              try {
                await this.archiveTransport(exec).archive({
                  workspacePath: VERCEL_WORKSPACE_PATH,
                  ref: archiveRef,
                  sha: input.sha,
                })
              } catch (error) {
                // Archive refs are best effort: the settlement rewrite retains
                // the candidate through its `retain` fallback.
                if (!isArchiveRefusal(error)) throw error
              }
            return available
          })
        }),
      preserve: (input) =>
        this.withPolicyLock(input.ref, async () => {
          if (this.active.has(input.ref) || this.uncertain.has(input.ref))
            throw new Error('preservation requires confirmed execution teardown')
          const sandbox = await this.facade.get(input.ref, this.operationSignal())
          if (sandbox === null) return { outcome: 'absent' }
          const heads = await this.withTrustedGit(sandbox, input.ref, async (exec) => {
            // A VM whose provisioning stopped before the checkout was moved
            // into place has nothing to preserve. The probe runs without the
            // checkout as cwd, and only a definite "missing" proves absence.
            const checkout = await sandbox.runCommand({
              cmd: 'test',
              args: ['-e', `${VERCEL_WORKSPACE_PATH}/.git`],
              signal: this.operationSignal(),
            })
            if (checkout.exitCode === 1) return null
            if (checkout.exitCode !== 0)
              throw new Error(
                `preservation could not confirm the checkout at ${VERCEL_WORKSPACE_PATH} (exit ${checkout.exitCode})`,
              )
            const capability = this.archiveTransport(exec)
            const remote = await this.remoteBranchHead(input.branch, 'preservation branch')
            const base =
              remote === null
                ? input.base
                : await capability.snapshot({
                    workspacePath: VERCEL_WORKSPACE_PATH,
                    branch: input.branch,
                    destinationRef: `refs/autobuild/reconcile/${input.slug}/preservation`,
                  })
            // After the guest push and the host REST fallback both refuse,
            // `input.retain` keeps the head as a store copy host-side.
            return preserveGitCommits({
              ...input,
              base,
              exec,
              workspacePath: VERCEL_WORKSPACE_PATH,
              archive: capability.archive,
            })
          })
          if (heads === null) return { outcome: 'absent' }
          return { outcome: 'preserved', heads }
        }),
      rewrite: (input: Parameters<NonNullable<WorkspacePublication['rewrite']>>[0]) =>
        this.withPolicyLock(input.ref, () => this.publish(input)),
      isPublished: (input: { sha: string; branch: string }) => this.isPublished(input),
      publish: (input: { ref: string; sha: string; branch: string }) =>
        this.withPolicyLock(input.ref, () => this.publish(input)),
    }
    // The operator-sandbox publication path reuses the SAME capability: its
    // publish pushes an exact sha from any sandbox ref, including an operator
    // environment, and its isPublished ignores the optional `ref` field.
    // Constructor-body assignment, never a field initializer — the class
    // assigns `publication` in the constructor too, and under the repo's
    // `useDefineForClassFields` semantics a field initializer would run
    // before that assignment and capture `undefined`.
    this.sandboxPublication = this.publication
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
    revision?: string
    generation?: number
    restoration?: import('../types').WorkspacePreservationHead[]
    restorationReplaced?: string[]
    /** Ignored: a sandbox clone never holds archive refs, so restoration here
     * always fetches each exact ref from origin, whatever the forge. */
    restorationArchives?: 'local' | 'remote'
    restoreStored?: Parameters<WorkspaceProvider['provision']>[0]['restoreStored']
    adoptAbandoned?: boolean
  }): Promise<WorkspaceProvisionResult> {
    const scopedToken = await (this.options.delegateCredential ?? delegateCredential)(
      this.options.storeRef,
      this.options.storeToken,
      { kind: 'build-runner', id: buildSlugFromBranch(opts.branch) },
    )
    const rawOrigin = await this.origin()
    const origin = cleanGithubOrigin(rawOrigin)
    const name = sandboxName(origin.url, opts.branch, opts.generation)
    // Resolved once, before the create/reuse branch: the identity stamp the
    // current archive source would deliver, against which both a fresh
    // install's marker and a reused sandbox's marker are compared.
    const distributionIdentity = await this.identityStamp()
    const existing = await this.remoteBranchHead(opts.branch, `remote branch ${opts.branch}`)
    const base =
      existing ??
      opts.revision ??
      (await this.remoteBranchHead(opts.baseBranch, `remote base ${opts.baseBranch}`))
    if (base === null)
      throw new Error(
        `remote branch ${existing === null ? opts.baseBranch : opts.branch} does not exist`,
      )

    let sandbox: VercelSandboxHandle | null
    try {
      sandbox = await this.facade.get(name, this.operationSignal())
    } catch (error) {
      if (!isUnavailableVercelSnapshot(error)) throw error
      throw new WorkspaceCleanupRequired(
        {
          provider: this.name,
          ref: name,
          path: VERCEL_WORKSPACE_PATH,
          branch: opts.branch,
          base: { source: 'existing', sha: base },
        },
        error,
      )
    }

    let checkedOut = base
    if (sandbox !== null) {
      const marker = await sandbox.runCommand({
        cmd: 'test',
        args: ['-f', VERCEL_PROVISIONED_MARKER],
      })
      if (marker.exitCode === 0) {
        // A completed sandbox from an attempt that recorded nothing keeps the
        // commit that attempt checked out, however far the target has moved
        // since. Read it before any stop: a command after stop would resume
        // the persistent guest.
        try {
          checkedOut = await checkedOutBranchHead(sandbox, opts.branch, this.operationSignal())
        } catch (error) {
          throw new WorkspaceCleanupRequired(
            {
              provider: this.name,
              ref: name,
              path: VERCEL_WORKSPACE_PATH,
              branch: opts.branch,
              base: { source: 'existing', sha: base },
            },
            error,
          )
        }
        const installed = await readDistributionVersionMarker(sandbox, this.operationSignal())
        if (installed === distributionIdentity) {
          await sandbox.stop({ signal: this.operationSignal() })
        } else {
          // A completed sandbox whose installed distribution disagrees with
          // what the current system would deliver — including legacy guests
          // without a marker — is refreshed in place. Any refresh failure
          // deletes the sandbox so the next pass rematerializes cleanly.
          try {
            await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
            const archive = await this.archiveBytes()
            await installDistribution(
              sandbox,
              archive,
              distributionIdentity,
              this.operationSignal(),
            )
          } catch (error) {
            throw new WorkspaceCleanupRequired(
              {
                provider: this.name,
                ref: name,
                path: VERCEL_WORKSPACE_PATH,
                branch: opts.branch,
                base: { source: 'existing', sha: base },
              },
              error,
            )
          }
          await sandbox.stop({ signal: this.operationSignal() })
        }
      } else if (!opts.adoptAbandoned) {
        // A named VM without the marker is a crashed/legacy provisioning
        // attempt. Never expose its potentially unscrubbed checkout to agents.
        throw new WorkspaceCleanupRequired(
          {
            provider: this.name,
            ref: name,
            path: VERCEL_WORKSPACE_PATH,
            branch: opts.branch,
            base: { source: 'existing', sha: base },
          },
          new Error('incomplete provisioning marker'),
        )
      } else {
        // The dispatcher recorded this generation's attempt as abandoned at
        // its own teardown, and its lease is gone. Finish the same sandbox in
        // place, but only after verification; any doubt still reaps it.
        try {
          // Quiesce first: stopping ends any command the dead invocation left
          // running, and the persistent guest resumes on the next command.
          await sandbox.stop({ signal: this.operationSignal() })
          const checkout = await sandbox.runCommand({
            cmd: 'test',
            args: ['-e', `${VERCEL_WORKSPACE_PATH}/.git`],
          })
          if (checkout.exitCode !== 0)
            throw new Error('abandoned provisioning left no checkout to finish')
          checkedOut = await this.completeProvisioning(sandbox, {
            origin,
            branch: opts.branch,
            base,
            distributionIdentity,
            scopedToken,
            verifyClean: true,
          })
        } catch (error) {
          throw new WorkspaceCleanupRequired(
            {
              provider: this.name,
              ref: name,
              path: VERCEL_WORKSPACE_PATH,
              branch: opts.branch,
              base: { source: 'remote', sha: base },
            },
            error,
          )
        }
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
        ...(this.options.config.snapshotExpirationSeconds === undefined
          ? {}
          : { snapshotExpiration: this.options.config.snapshotExpirationSeconds * 1000 }),
        networkPolicy: this.billingPolicy(uploadPackPolicy(origin, readAuth)),
        keepLastSnapshots: { count: VERCEL_KEEP_LAST_SNAPSHOTS, deleteEvicted: true },
        signal: this.operationSignal(),
      })
      try {
        await relocateCheckout(sandbox, origin.directory)
        checkedOut = await this.completeProvisioning(sandbox, {
          origin,
          branch: opts.branch,
          base,
          distributionIdentity,
          scopedToken,
        })
      } catch (error) {
        throw new WorkspaceCleanupRequired(
          {
            provider: this.name,
            ref: name,
            path: VERCEL_WORKSPACE_PATH,
            branch: opts.branch,
            base: { source: 'remote', sha: base },
          },
          error,
        )
      }
    }
    let provisionHead = checkedOut
    let restorationSkipped: import('../types').RestorationSkip[] = []
    if (opts.restoration?.length) {
      provisionHead = await this.withTrustedGit(sandbox, name, async (exec) => {
        restorationSkipped = (
          await restoreGitCommits({
            exec,
            workspacePath: VERCEL_WORKSPACE_PATH,
            branch: opts.branch,
            heads: opts.restoration!,
            replaced: opts.restorationReplaced,
            // Store copies are read host-side and applied over the trusted
            // transport; the guest never holds store credentials.
            ...(opts.restoreStored
              ? {
                  restoreStored: (sha: string) =>
                    opts.restoreStored!({ exec, workspacePath: VERCEL_WORKSPACE_PATH, sha }),
                }
              : {}),
          })
        ).skipped
        const result = await exec(
          ['git', 'rev-parse', '--verify', `refs/heads/${opts.branch}^{commit}`],
          { cwd: VERCEL_WORKSPACE_PATH },
        )
        if (result.exitCode !== 0) throw new Error('cannot confirm restored workspace branch')
        return result.stdout.trim()
      })
    }
    this.origins.set(name, origin)
    this.sessions.set(name, sandbox)
    return {
      provider: this.name,
      ref: name,
      path: VERCEL_WORKSPACE_PATH,
      branch: opts.branch,
      // The recorded sha is the guest's verified checkout (or restored branch
      // head), never the separately read target head (AUT-1252).
      base: {
        source: opts.restoration?.length || existing !== null ? 'existing' : 'remote',
        sha: provisionHead,
      },
      ...(restorationSkipped.length ? { restorationSkipped } : {}),
    }
  }

  /** The idempotent post-create sequence: branch checkout at the selected
   * base, credential scrub, toolchain, distribution, dependencies, runtimes,
   * then the completion marker and a snapshot stop. Shared by a fresh create
   * and by finishing a teardown-abandoned attempt in place. Returns the
   * verified checked-out head. */
  private async completeProvisioning(
    sandbox: VercelSandboxHandle,
    input: {
      origin: ReturnType<typeof cleanGithubOrigin>
      branch: string
      base: string
      distributionIdentity: string
      scopedToken: string
      /** Require no tracked modifications before the marker is written. */
      verifyClean?: boolean
    },
  ): Promise<string> {
    const { origin, branch, base, distributionIdentity, scopedToken } = input
    await commandOrThrow(sandbox, {
      cmd: 'git',
      args: ['checkout', '-B', branch, base],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    const head = await checkedOutBranchHead(sandbox, branch, this.operationSignal())
    if (head !== base)
      throw new Error(`checked out ${branch} at ${head}, expected selected base ${base}`)
    if (input.verifyClean) {
      // A finished abandoned attempt must not expose tracked edits the dead
      // invocation may have left behind.
      const diff = await sandbox.runCommand({
        cmd: 'git',
        args: ['diff', '--quiet', 'HEAD', '--'],
        cwd: VERCEL_WORKSPACE_PATH,
      })
      if (diff.exitCode !== 0) throw new Error('abandoned provisioning left tracked modifications')
    }
    await commandOrThrow(sandbox, {
      cmd: 'git',
      args: ['remote', 'set-url', 'origin', origin.url],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    for (const key of ['credential.helper', 'http.extraheader', `http.${origin.url}.extraheader`]) {
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
    const archive = await this.archiveBytes()
    await installDistribution(sandbox, archive, distributionIdentity, this.operationSignal())
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
      { ...this.guestEnvironment(), AB_TOKEN: scopedToken },
      currentRuntimeReferences(this.options.runtimeReferences),
      true,
    )
    await commandOrThrow(sandbox, {
      cmd: 'touch',
      args: [VERCEL_PROVISIONED_MARKER],
    })
    await sandbox.stop({ signal: this.operationSignal() })
    return head
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    if (this.active.has(handle.ref)) throw new Error(`cannot release active sandbox ${handle.ref}`)
    await this.reap(handle.ref)
  }

  private operationSignal(): AbortSignal {
    return AbortSignal.timeout(this.options.config.operationTimeoutMs ?? 30_000)
  }

  /** Stop/delete and then prove absence by exact deterministic name — for the
   * sandbox and, because deleting a sandbox never removes the automatic
   * snapshots its sessions created, for its snapshot storage too. */
  private async reap(ref: string, dispatcherAuthorized = false): Promise<WorkspaceReapOutcome> {
    let sandbox: VercelSandboxHandle | null
    try {
      sandbox = this.sessions.get(ref) ?? (await this.facade.get(ref, this.operationSignal()))
    } catch (error) {
      if (!isMissingVercelSandbox(error)) throw error
      sandbox = null
    }
    if (sandbox === null) {
      // A snapshot-unavailable lookup also leaves a stale name reservation.
      if (dispatcherAuthorized) {
        if (!this.facade.deleteByName)
          throw new Error('sandbox facade lacks dispatcher-authorized deleteByName')
        await this.facade.deleteByName(ref, this.operationSignal())
      }
      // An environment can vanish without its snapshots; the purge still
      // applies and only a confirmed empty list may forget the reference.
      try {
        const snapshots = await this.purgeOrRetryable(ref)
        this.forget(ref)
        return { outcome: 'absent', snapshots }
      } catch (error) {
        throw this.retryableCleanup(ref, error)
      }
    }
    try {
      try {
        await sandbox.stop({ signal: this.operationSignal() })
      } catch (error) {
        // A persistent sandbox that was resumed once can wedge so that stop
        // never returns while delete still succeeds within seconds. Absence
        // is proven below either way, so a timed-out stop is not fatal.
        if (!isInterruptedLongPoll(error)) throw error
      }
      // Purge between stop and delete: the sandbox still exists, so the exact
      // name filter is unambiguous, and after the explicit stop no new
      // snapshot can be created.
      const purged = await this.purgeOrRetryable(ref)
      if (dispatcherAuthorized) {
        if (!this.facade.deleteByName)
          throw new Error('sandbox facade lacks dispatcher-authorized deleteByName')
        await this.facade.deleteByName(ref, this.operationSignal())
      } else await sandbox.delete({ signal: this.operationSignal() })
      sandbox = await this.facade.get(ref, this.operationSignal())
      if (sandbox !== null)
        throw new Error(`sandbox ${ref} still exists after delete acknowledgement`)
      // The post-delete pass catches anything the delete itself created;
      // after the stop above it is normally empty.
      const postDelete = await this.purgeOrRetryable(ref)
      this.forget(ref)
      return {
        outcome: 'confirmed',
        snapshots: {
          outcome: 'confirmed',
          deleted: purged.deleted + postDelete.deleted,
        },
      }
    } catch (error) {
      this.uncertain.add(ref)
      this.sessions.delete(ref)
      throw this.retryableCleanup(ref, error)
    }
  }

  /** Purge one environment's snapshots, converting an unknown outcome into
   * the retryable cleanup failure the dispatcher already retries. */
  private async purgeOrRetryable(ref: string): Promise<VercelSnapshotPurge> {
    const purged = await purgeEnvironmentSnapshots(this.facade, ref, this.operationSignal())
    if (purged.outcome === 'unknown') {
      throw new Error(
        `snapshot purge for ${JSON.stringify(ref)} is unconfirmed: ${purged.error ?? 'unknown outcome'}`,
      )
    }
    return purged
  }

  private retryableCleanup(ref: string, error: unknown): Error {
    return new Error(
      `sandbox ${ref} cleanup outcome is unknown and remains retryable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  private forget(ref: string): void {
    this.active.delete(ref)
    this.uncertain.delete(ref)
    this.sessions.delete(ref)
    this.origins.delete(ref)
  }

  private guestEnvironment(): Record<string, string> {
    return accountGuestEnvironment(
      runtimeEnvironment(this.options.config, this.options.env),
      this.options.accounts?.() ?? {},
      this.options.env,
    )
  }

  private billingPolicy(base: NetworkPolicy, ref?: string): NetworkPolicy {
    if (ref?.startsWith('autobuild-sandbox-')) return base
    const accounts = this.options.accounts?.() ?? {}
    const required = this.options.executionAccounts?.() ?? accounts
    const result = accountPolicy(base, accounts, this.options.env, required)
    if (result.missing.length)
      throw new MissingAccountCredentialsError(
        missingAccountCredentials(required, this.options.env),
      )
    return result.policy
  }

  /** The upload-pack egress transform's authorization: the deployment egress
   * read credential when set, else the configured env pair, Basic-encoded.
   * Every policy write after creation goes through here, so a reset never
   * drops or widens the transform. */
  private uploadPackAuthorization(): string | undefined {
    const egress = this.options.egressReadCredential
    if (egress !== undefined) {
      return `Basic ${Buffer.from(`${egress.username}:${egress.password}`).toString('base64')}`
    }
    if (this.options.config.gitPasswordEnv === undefined) return undefined
    const username = requireVercelEnvironmentValue(
      this.options.env,
      this.options.config.gitUsernameEnv!,
    )
    const password = requireVercelEnvironmentValue(
      this.options.env,
      this.options.config.gitPasswordEnv,
    )
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }

  private async normalNetworkPolicy(ref: string): Promise<{
    origin: ReturnType<typeof cleanGithubOrigin>
    policy: NetworkPolicy
  }> {
    const origin = this.origins.get(ref) ?? cleanGithubOrigin(await this.origin())
    this.origins.set(ref, origin)
    return {
      origin,
      policy: this.billingPolicy(uploadPackPolicy(origin, this.uploadPackAuthorization()), ref),
    }
  }

  private async start(
    input: BuildExecutionStart,
    auth?: ExecutionLaunchAuth,
  ): Promise<BuildExecutionHandle> {
    const scopedToken =
      auth?.token ??
      (await (this.options.delegateCredential ?? delegateCredential)(
        this.options.storeRef,
        this.options.storeToken,
        { kind: 'build-runner', id: input.slug },
      ))
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
    // Restart (the lease sweep's re-attach) launches guest code in an existing
    // sandbox, so it must compare the distribution identity exactly as the
    // reuse paths do: a guest installed by an older dispatcher — including one
    // stranded by a protocol-only bump or a missing/unreadable marker — is
    // refreshed before the runner starts, or the hosted store would 409 its
    // heartbeat and the build would strand. Refresh failure retains the
    // sandbox for dispatcher-owned preservation and cleanup. Bun is brought
    // to the pin first, because the refresh and the runner both run with it.
    try {
      await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
    } catch (error) {
      throw new WorkspaceCleanupRequired(
        { provider: this.name, ref, path: VERCEL_WORKSPACE_PATH, branch: `ab/${input.slug}` },
        error,
      )
    }
    const distributionIdentity = await this.identityStamp()
    const installed = await readDistributionVersionMarker(sandbox, this.operationSignal())
    if (installed !== distributionIdentity) {
      try {
        const archive = await this.archiveBytes()
        await installDistribution(sandbox, archive, distributionIdentity, this.operationSignal())
      } catch (error) {
        throw new WorkspaceCleanupRequired(
          { provider: this.name, ref, path: VERCEL_WORKSPACE_PATH, branch: `ab/${input.slug}` },
          error,
        )
      }
    }
    await bootstrapRuntimes(
      sandbox,
      this.options.config,
      { ...this.guestEnvironment(), AB_TOKEN: scopedToken },
      currentRuntimeReferences(this.options.runtimeReferences),
      false,
    )
    this.sessions.set(ref, sandbox)
    const env: Record<string, string> = {
      AB_STORE: this.options.storeRef,
      AB_TOKEN: scopedToken,
      [BUILD_RUNNER_OPTIONS_ENV]: JSON.stringify({
        ...input,
        supervision: { kind: 'environment' },
      }),
    }
    Object.assign(env, this.guestEnvironment())
    // Guests hold no forge credential: their GitHub API requests fail typed
    // instead of going out anonymously. Applied last so no forwarded value
    // can disable it.
    env[GITHUB_REQUIRE_CREDENTIAL_ENV] = '1'
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
    return this.environmentSupervisedHandle(ref, sandbox, command)
  }

  /** Shared post-launch supervision of one detached guest command: command
   * wait with lifetime-bounded long-poll retries, environment-owned teardown,
   * and the durable identity a later process re-observes. Used by both the
   * build path and the hosted harvest path. */
  private environmentSupervisedHandle(
    ref: string,
    sandbox: VercelSandboxHandle,
    command: VercelCommand,
  ): BuildExecutionHandle {
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
    // Retry interrupted long-polls only within the environment's own
    // lifetime (plus a margin for stop/snapshot); past that the command
    // cannot still be running and the failure is real.
    const lifetimeDeadline =
      Date.now() + this.options.config.timeoutSeconds * 1000 + VERCEL_LIFETIME_MARGIN_MS
    // Detach (teardown of the LOCAL supervision only) aborts this wait so the
    // process can exit while the guest keeps running and heartbeating its
    // lease. A later invocation settles the execution from the Store plus
    // provider liveness.
    const localWait = new AbortController()
    let detached = false
    const completion = waitForCommandExit(command, () => Date.now() > lifetimeDeadline, {
      signal: localWait.signal,
    }).then(
      async (result): Promise<BuildExecutionExit> => {
        if (detached) return { exitCode: result.exitCode }
        await stopEnvironment()
        return { exitCode: result.exitCode }
      },
      async (error): Promise<BuildExecutionExit> => {
        if (detached) return { exitCode: null }
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
        ...(command.cmdId !== undefined && command.cmdId !== ''
          ? { commandId: command.cmdId }
          : {}),
      },
      supervision: 'environment',
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
      detach: async () => {
        detached = true
        localWait.abort()
      },
    }
  }

  /** Hosted harvest (AUT-305): provision (or reuse) the repository's one
   * disposable environment from the remote base head, launch the guest
   * harvest runner as one detached command, and supervise it exactly like a
   * build execution. Provisioning reuses the module-local build chain so a
   * harvest guest is identical to a build guest; release is the provider's
   * existing reap path (stop, snapshot purge, delete). */
  private async startHarvestExecution(
    input: HarvestExecutionStart,
    auth?: ExecutionLaunchAuth,
  ): Promise<BuildExecutionHandle> {
    if (!auth) throw new Error('harvest launch requires delegated authority')
    const scopedToken = auth.token
    const origin = cleanGithubOrigin(await this.origin())
    const name = harvestSandboxName(origin.url)
    if (this.active.has(name)) throw new Error(`sandbox ${name} already has a live execution`)
    // Resolved once, before the create/reuse branch: the identity stamp the
    // current archive source would deliver, against which both a fresh
    // install's marker and a reused environment's marker are compared.
    const distributionIdentity = await this.identityStamp()
    let sandbox = await this.facade.get(name, this.operationSignal())
    if (sandbox !== null) {
      const marker = await sandbox.runCommand({
        cmd: 'test',
        args: ['-f', VERCEL_PROVISIONED_MARKER],
      })
      if (marker.exitCode !== 0) {
        // A named VM without the marker is a crashed/legacy provisioning
        // attempt — e.g. a host that died mid-provision. Never expose its
        // potentially unscrubbed checkout to agents.
        await sandbox.delete({ signal: this.operationSignal() })
        sandbox = null
      } else {
        // A completed environment left by an earlier (interrupted) run is
        // stopped and reused. A reused guest whose installed distribution
        // disagrees with what the current system would deliver is refreshed
        // in place, mirroring the build reuse path.
        const installed = await readDistributionVersionMarker(sandbox, this.operationSignal())
        if (installed !== distributionIdentity) {
          try {
            await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
            const archive = await this.archiveBytes()
            await installDistribution(
              sandbox,
              archive,
              distributionIdentity,
              this.operationSignal(),
            )
          } catch (error) {
            try {
              this.sessions.set(name, sandbox)
              await this.reap(name)
            } catch (deleteError) {
              throw new AggregateError(
                [error, deleteError],
                `harvest sandbox ${name} distribution refresh failed and its incomplete environment could not be confirmed deleted`,
              )
            }
            throw error
          }
        }
        await sandbox.stop({ signal: this.operationSignal() })
      }
    }
    if (sandbox === null) {
      const head = await this.remoteBranchHead(input.baseBranch, `remote base ${input.baseBranch}`)
      if (head === null) {
        throw new Error(`remote base ${input.baseBranch} does not exist`)
      }
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
          revision: head,
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
        ...(this.options.config.snapshotExpirationSeconds === undefined
          ? {}
          : { snapshotExpiration: this.options.config.snapshotExpirationSeconds * 1000 }),
        networkPolicy: this.billingPolicy(uploadPackPolicy(origin, readAuth)),
        keepLastSnapshots: { count: VERCEL_KEEP_LAST_SNAPSHOTS, deleteEvicted: true },
        signal: this.operationSignal(),
      })
      try {
        await relocateCheckout(sandbox, origin.directory)
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
        const archive = await this.archiveBytes()
        await installDistribution(sandbox, archive, distributionIdentity, this.operationSignal())
        // Repository dependencies precede runtime preflight; the fixed
        // bootstrap is the same one build provisioning runs.
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
          { ...this.guestEnvironment(), AB_TOKEN: scopedToken },
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
            `harvest sandbox ${name} setup failed and its incomplete environment could not be confirmed deleted`,
          )
        }
        throw error
      }
    }
    this.origins.set(name, origin)
    // Launch: reassert the normal network policy, bring Bun to the pin and
    // preflight exactly as the build start path does, then one detached guest
    // runner command. A sandbox that cannot reach the pin is reaped.
    const { policy } = await this.normalNetworkPolicy(name)
    await sandbox.update({ networkPolicy: policy }, { signal: this.operationSignal() })
    if (this.uncertain.has(name)) {
      // A prior wait/stop failure may have left agent code alive. Confirm a
      // stop before starting another runner in the same environment.
      await sandbox.stop({ signal: this.operationSignal() })
      this.uncertain.delete(name)
    }
    try {
      await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
    } catch (error) {
      try {
        this.sessions.set(name, sandbox)
        await this.reap(name)
      } catch (deleteError) {
        throw new AggregateError(
          [error, deleteError],
          `harvest sandbox ${name} Bun pin refresh failed and its environment could not be confirmed deleted`,
        )
      }
      throw error
    }
    await bootstrapRuntimes(
      sandbox,
      this.options.config,
      { ...this.guestEnvironment(), AB_TOKEN: scopedToken },
      currentRuntimeReferences(this.options.runtimeReferences),
      false,
    )
    this.sessions.set(name, sandbox)
    const sessionId = sandbox.currentSession?.().sessionId
    const envelope: HarvestRunnerLaunch = {
      ...input,
      supervision: { kind: 'environment' },
      environment: {
        provider: this.name,
        environmentId: sandbox.name,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    }
    const env: Record<string, string> = {
      AB_STORE: this.options.storeRef,
      AB_TOKEN: scopedToken,
      ...(auth?.tickets
        ? { AB_TICKET_URL: auth.tickets.url, AB_TICKET_TOKEN: auth.tickets.token }
        : {}),
      [HARVEST_RUNNER_OPTIONS_ENV]: JSON.stringify(envelope),
    }
    Object.assign(env, this.guestEnvironment())
    // Guests hold no forge credential: their GitHub API requests fail typed
    // instead of going out anonymously. Applied last so no forwarded value
    // can disable it.
    env[GITHUB_REQUIRE_CREDENTIAL_ENV] = '1'
    const command = (await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-harvest-runner.ts`,
      ],
      cwd: VERCEL_WORKSPACE_PATH,
      env,
      detached: true,
      signal: this.operationSignal(),
    })) as VercelCommand
    return this.environmentSupervisedHandle(name, sandbox, command)
  }

  /** Observe a recovered execution and confirm whole-environment teardown
   * before exposing a terminal observation. Command exit alone does not prove
   * descendants have stopped writing to the shared workspace. Stop failures
   * propagate so settlement retains the execution and lease and retries. */
  private async observeExecution(identity: BuildExecutionIdentity): Promise<ExecutionObservation> {
    if (identity.commandId === undefined) {
      throw new Error(
        `execution on ${identity.workspaceRef} has no recorded command id and cannot be re-observed`,
      )
    }
    const sandbox = await this.facade.get(identity.workspaceRef, this.operationSignal())
    if (sandbox === null) return { state: 'lost' }
    const settled = async (observation: ExecutionObservation): Promise<ExecutionObservation> => {
      try {
        await sandbox.stop({ signal: this.operationSignal() })
      } catch (error) {
        if (!isMissingVercelSandbox(error)) {
          this.uncertain.add(identity.workspaceRef)
          this.sessions.delete(identity.workspaceRef)
          throw error
        }
      }
      this.active.delete(identity.workspaceRef)
      this.uncertain.delete(identity.workspaceRef)
      this.sessions.delete(identity.workspaceRef)
      return observation
    }
    const currentSession = sandbox.currentSession?.().sessionId
    if (
      identity.sessionId !== undefined &&
      currentSession !== undefined &&
      currentSession !== identity.sessionId
    )
      return { state: 'lost' }
    // Terminal provider status proves the recorded incarnation is stopped.
    // Never stop a newer resumed session or demand a second stop of one that
    // the provider already confirms stopped.
    if (
      sandbox.sessionStatus === 'stopped' ||
      sandbox.sessionStatus === 'aborted' ||
      sandbox.sessionStatus === 'failed'
    )
      return { state: 'lost' }
    if (sandbox.sessionStatus !== undefined && sandbox.sessionStatus !== 'running') {
      return settled({ state: 'lost' })
    }
    if (sandbox.sessionExpiresAt !== undefined) {
      const deadline = sandbox.sessionExpiresAt + VERCEL_LIFETIME_MARGIN_MS
      if (Date.now() > deadline) {
        throw new Error(
          `execution on sandbox ${identity.environmentId ?? identity.workspaceRef} cannot still be running: ` +
            `the environment expired — its session expiry (${new Date(sandbox.sessionExpiresAt).toISOString()}) plus ` +
            `the ${VERCEL_LIFETIME_MARGIN_MS} ms stop/snapshot margin passed at ${new Date(deadline).toISOString()}`,
        )
      }
    }
    let attention: string | undefined
    const accounts = this.options.accounts?.() ?? {}
    // Preserve legacy observation: without accounts there is no credential
    // policy to refresh, and no additional provider write or failure point.
    if (Object.keys(accounts).length) {
      const origin =
        this.origins.get(identity.workspaceRef) ?? cleanGithubOrigin(await this.origin())
      const base = uploadPackPolicy(origin, this.uploadPackAuthorization())
      const refreshed = accountPolicy(
        base,
        accounts,
        this.options.env,
        this.options.executionAccounts?.() ?? accounts,
      )
      try {
        await sandbox.update(
          { networkPolicy: refreshed.policy },
          { signal: this.operationSignal() },
        )
      } catch {
        await sandbox.stop({ signal: this.operationSignal() })
        return { state: 'lost', attention: 'Account policy renewal failed; sandbox stopped' }
      }
      if (refreshed.missing.length) {
        attention = `Missing credentials: ${refreshed.missing.join('; ')}`
        // The updated policy fences the missing account by removing its bearer
        // transform. Its next request fails authentication through the runtime's
        // account-specific recovery path. Keep other routes in this guest alive:
        // declarations include unused accounts and do not identify active sessions.
      }
    }
    const diagnosed = (observation: ExecutionObservation): ExecutionObservation =>
      attention === undefined ? observation : { ...observation, attention }
    let observation: ExecutionObservation
    try {
      const command = await sandbox.getCommand(identity.commandId, {
        signal: this.operationSignal(),
      })
      if (command.exitCode !== null) {
        observation = { state: 'ended', exitCode: command.exitCode }
      } else {
        try {
          const finished = await command.wait({
            signal: AbortSignal.any([
              AbortSignal.timeout(this.observeWaitMs),
              this.operationSignal(),
            ]),
          })
          observation = { state: 'ended', exitCode: finished.exitCode }
        } catch (error) {
          if (isMissingVercelSandbox(error)) observation = { state: 'lost' }
          else if (isInterruptedLongPoll(error)) return diagnosed({ state: 'running' })
          else throw error
        }
      }
    } catch (error) {
      if (isMissingVercelSandbox(error)) observation = { state: 'lost' }
      else throw error
    }
    // Deliberately outside the lookup/wait catch: an ambiguous stop must not
    // become proof of loss or command exit, even when its error resembles a
    // transport interruption.
    return settled(diagnosed(observation))
  }

  // ── Operator sandbox capability (AUT-340) ─────────────────────────
  //
  // One persistent, credential-free environment per operator × repository,
  // provisioned with the build workspace's chain and exposed only through
  // the registry's sandbox tools. The environment receives no store, forge,
  // ticket-provider, or model credential: the guest environment below is
  // built from an empty record plus forwarded names, and the git read
  // credential enters only as a network-policy header transform.

  /** The credential-free guest environment: one fresh record per call —
   * never the process environment — holding exactly the forwarded
   * `sandboxEnvironmentVariables`. A missing host value is a typed
   * `environment` failure rather than a silent absence. The toolchain PATH is
   * deliberately NOT part of the record: the SDK passes env values through
   * verbatim, so a literal `$PATH` there would never be expanded — the PATH
   * is prepended inside the guest shell instead (the same channel the build
   * runner uses). Shared by the setup command and every tool `exec`/`start`. */
  private sandboxEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of this.options.sandboxEnvironmentVariables ?? []) {
      const value = this.options.env[name]
      if (value === undefined || value === '') {
        throw new SandboxOperationError(
          'environment',
          `operator sandbox environment variable ${name} is not set in the host environment`,
        )
      }
      env[name] = value
    }
    return env
  }

  /** The toolchain PATH as a shell prefix: the guest shell expands `$PATH`
   * from its own ambient environment, so guests get the autobuild toolchain
   * ahead of the image's default PATH without the env record ever carrying an
   * unexpanded literal. */
  private sandboxPathPrefix(): string {
    return `PATH=${VERCEL_BUN_BIN_PATH}:${VERCEL_AUTOBUILD_PATH}/bin:$PATH; export PATH; `
  }

  private async describeOperatorSandbox(input: {
    operator: string
  }): Promise<SandboxEnvironmentIdentity> {
    const origin = cleanGithubOrigin(await this.origin())
    return {
      provider: this.name,
      environmentId: sandboxEnvironmentName(origin.url, input.operator),
      workspacePath: VERCEL_WORKSPACE_PATH,
    }
  }

  /** Provision-or-resume, blocking: the provider's own primitive for tests
   * and callers without a journal. A persistent sandbox auto-resumes on the
   * first SDK call that needs a running session, so the reuse path applies
   * the idle timeout and network policy, brings Bun to the pin and re-checks
   * the distribution marker as the build paths do. A fresh provision runs the
   * host phase, then waits for the detached tail and probes its outcome; a
   * failure reaps the environment, because `ensure` has no journal to
   * publish its evidence to and its caller holds the error. */
  private async ensureOperatorSandbox(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<SandboxEnvironmentIdentity> {
    const { origin, name } = await this.operatorName(input.operator)
    const distributionIdentity = await this.identityStamp()
    let sandbox = await this.facade.get(name, this.operationSignal())
    if (sandbox !== null) {
      await this.applyOperatorSession(sandbox, name)
      const marker = await sandbox.runCommand({
        cmd: 'test',
        args: ['-f', VERCEL_PROVISIONED_MARKER],
      })
      if (marker.exitCode !== 0) {
        // A named VM without the marker is a crashed/legacy provisioning
        // attempt. Never expose its potentially unscrubbed checkout.
        await sandbox.delete({ signal: this.operationSignal() })
        sandbox = null
      } else {
        // Bun is brought to the pin before anything runs with it; a reused
        // environment that cannot reach the pin is deleted.
        try {
          await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
        } catch (error) {
          try {
            this.sessions.set(name, sandbox)
            await this.reap(name)
          } catch (deleteError) {
            throw new AggregateError(
              [error, deleteError],
              `operator sandbox ${name} Bun pin refresh failed and its environment could not be confirmed deleted`,
            )
          }
          throw new SandboxOperationError(
            'provision',
            error instanceof Error ? error.message : String(error),
            { cause: error },
          )
        }
        const installed = await readDistributionVersionMarker(sandbox, this.operationSignal())
        if (installed !== distributionIdentity) {
          // A reused environment whose installed distribution disagrees with
          // what the current system would deliver is refreshed in place,
          // exactly as build guests are. Refresh failure deletes the
          // environment so the next call rematerializes it cleanly.
          try {
            const archive = await this.archiveBytes()
            await installDistribution(
              sandbox,
              archive,
              distributionIdentity,
              this.operationSignal(),
            )
          } catch (error) {
            try {
              this.sessions.set(name, sandbox)
              await this.reap(name)
            } catch (deleteError) {
              throw new AggregateError(
                [error, deleteError],
                `operator sandbox ${name} distribution refresh failed and its incomplete environment could not be confirmed deleted`,
              )
            }
            throw error
          }
        }
        const sessionId = sandbox.currentSession?.().sessionId
        this.sessions.set(name, sandbox)
        return {
          provider: this.name,
          environmentId: name,
          ...(sessionId !== undefined ? { sessionId } : {}),
          workspacePath: VERCEL_WORKSPACE_PATH,
        }
      }
    }
    const failEnsure = async (
      failure: { stage: SandboxProvisionStage; message: string },
      created: boolean,
      cause?: unknown,
    ): Promise<never> => {
      if (created) {
        // Nothing unrecorded or half-built survives a blocking provision.
        try {
          await this.reap(name)
        } catch (deleteError) {
          throw new AggregateError(
            [cause ?? new Error(failure.message), deleteError],
            `operator sandbox ${name} setup failed and its incomplete environment could not be confirmed deleted`,
          )
        }
      }
      throw new SandboxOperationError(
        failure.stage === 'environment' ? 'environment' : 'provision',
        failure.message,
        cause === undefined ? undefined : { cause },
      )
    }
    let launched: Awaited<ReturnType<typeof this.runOperatorHostPhase>>
    try {
      launched = await this.runOperatorHostPhase({ origin, name, baseBranch: input.baseBranch })
    } catch (error) {
      if (error instanceof OperatorHostFailure)
        return failEnsure(error.failure, error.created, error)
      throw error
    }
    if (launched.outcome === 'concurrent') {
      throw new SandboxOperationError(
        'provision',
        `operator sandbox ${name} is being provisioned by another process`,
      )
    }
    const deadline = Date.now() + this.idleMs()
    await waitForCommandExit(launched.command, () => Date.now() > deadline)
    const probe = await this.probeOperator(launched.sandbox)
    if (probe.kind !== 'ready') {
      return failEnsure(
        probe.kind === 'failed' ? this.probeFailure(probe) : this.interruptedFailure(),
        true,
      )
    }
    const sessionId = launched.sandbox.currentSession?.().sessionId
    return {
      provider: this.name,
      environmentId: name,
      ...(sessionId !== undefined ? { sessionId } : {}),
      workspacePath: VERCEL_WORKSPACE_PATH,
      baseSha: launched.baseSha,
    }
  }

  // ── Operator sandbox lifecycle (#1246) ─────────────────────────────────
  //
  // `open` returns after a `get`, at most one probe and one `update`; the
  // host phase runs as this process's background attempt (which a hosted
  // caller keeps alive with its background seam) and launches the detached
  // tail. `status` reads the session status first and never runs a guest
  // command on a session that is not running: a guest command would resume
  // it. Failure evidence in the guest is reaped only by `open` (after the
  // service recorded the failure), `release`, or a blocking `ensure`.

  private readonly operatorInflight = new Map<
    string,
    {
      kind: 'provision' | 'resume'
      promise: Promise<SandboxProviderStatus>
      abort: AbortController
    }
  >()
  private readonly operatorFailures = new Map<
    string,
    { stage: SandboxProvisionStage; message: string }
  >()

  /** The operator sandbox's provider idle timeout, in milliseconds. */
  private idleMs(): number {
    return (this.options.sandboxIdleMinutes ?? 30) * 60_000
  }

  private async operatorName(
    operator: string,
  ): Promise<{ origin: ReturnType<typeof cleanGithubOrigin>; name: string }> {
    const origin = cleanGithubOrigin(await this.origin())
    return { origin, name: sandboxEnvironmentName(origin.url, operator) }
  }

  /** Every credential value a provisioning message could carry, removed:
   * forwarded guest values, the upload-pack authorization and git password,
   * then the forbidden host names' values. */
  private redactOperatorMessage(message: string): string {
    let env: Record<string, string> = {}
    try {
      env = this.sandboxEnv()
    } catch {
      // A missing forwarded value has no value to redact.
    }
    let redacted = redactRuntimeError(message, env)
    const secrets: string[] = []
    try {
      const authorization = this.uploadPackAuthorization()
      if (authorization !== undefined) {
        secrets.push(authorization, authorization.slice('Basic '.length))
      }
    } catch {
      // An unresolvable credential pair cannot appear in the message.
    }
    if (this.options.egressReadCredential !== undefined) {
      secrets.push(this.options.egressReadCredential.password)
    }
    const passwordEnv = this.options.config.gitPasswordEnv
    if (passwordEnv !== undefined) secrets.push(this.options.env[passwordEnv] ?? '')
    for (const secret of secrets.sort((a, b) => b.length - a.length)) {
      if (secret !== '') redacted = redacted.split(secret).join('[REDACTED]')
    }
    return redactSandboxMessage(redacted)
  }

  /** Apply the idle timeout and the current network policy to an operator
   * sandbox: a resumed session then runs with the idle timeout, and the
   * upload-pack transform carries the deployment's current read credential. */
  private async applyOperatorSession(sandbox: VercelSandboxHandle, name: string): Promise<void> {
    const { policy } = await this.normalNetworkPolicy(name)
    await sandbox.update(
      { timeout: this.idleMs(), networkPolicy: policy },
      { signal: this.operationSignal() },
    )
  }

  /** Extend the running session so it outlives `max(idleMs, boundMs)` from
   * now. The SDK's `extendTimeout` adds to the lifetime, so only the deficit
   * is requested. A failed extension is swallowed: it can only let the
   * sandbox stop sooner, which is cost-safe, and the next call extends. */
  private async extendOperatorTimer(sandbox: VercelSandboxHandle, boundMs: number): Promise<void> {
    const expiresAt = sandbox.sessionExpiresAt
    if (expiresAt === undefined) return
    const deficit = Date.now() + Math.max(this.idleMs(), boundMs) - expiresAt
    if (deficit <= 0) return
    try {
      await sandbox.extendTimeout(deficit, { signal: this.operationSignal() })
    } catch {
      // Cost-safe: see above.
    }
  }

  private async probeOperator(sandbox: VercelSandboxHandle): Promise<VercelOperatorProbe> {
    const stdout = await readableCommand(sandbox, {
      cmd: 'sh',
      args: [
        '-c',
        VERCEL_OPERATOR_PROBE_SCRIPT,
        'probe',
        VERCEL_OPERATOR_PROVISION_DIR,
        VERCEL_PROVISIONED_MARKER,
        VERCEL_WORKSPACE_PATH,
        VERCEL_BUN_EXECUTABLE,
        VERCEL_DISTRIBUTION_VERSION_MARKER,
      ],
      signal: this.operationSignal(),
    })
    return parseVercelOperatorProbe(stdout)
  }

  private async heartbeat(sandbox: VercelSandboxHandle, step: OperatorHostStep): Promise<void> {
    await commandOrThrow(sandbox, {
      cmd: 'sh',
      args: [
        '-c',
        'printf "%s %s\\n" "$1" "$(date +%s)" > "$2"',
        'heartbeat',
        step,
        `${VERCEL_OPERATOR_PROVISION_DIR}/host`,
      ],
      signal: this.operationSignal(),
    })
  }

  /** Best-effort: record a failure in the guest `failed` file, the durable
   * evidence any later process reads. The message is already redacted. */
  private async writeOperatorFailure(
    sandbox: VercelSandboxHandle,
    failure: { stage: SandboxProvisionStage; message: string },
  ): Promise<void> {
    try {
      await sandbox.runCommand({
        cmd: 'sh',
        args: [
          '-c',
          'mkdir -p "$1" && printf "%s\\n%s\\n" "$2" "$3" > "$1/failed"',
          'failed',
          VERCEL_OPERATOR_PROVISION_DIR,
          failure.stage,
          failure.message,
        ],
        signal: this.operationSignal(),
      })
    } catch {
      // The in-process record and the journal remain.
    }
  }

  /** The failure a `failed` probe records: a host or resume record carries
   * its stage and message verbatim; a tail record names its step, mapped onto
   * the existing stages with the redacted log tail as detail. */
  private probeFailure(probe: Extract<VercelOperatorProbe, { kind: 'failed' }>): {
    stage: SandboxProvisionStage
    message: string
  } {
    const [first = '', ...rest] = probe.record.split('\n')
    const step = first.trim()
    const recorded = rest.join('\n').trim()
    if (recorded !== '') {
      return {
        stage: (PROVISION_STAGES as readonly string[]).includes(step)
          ? (step as SandboxProvisionStage)
          : 'provision',
        message: this.redactOperatorMessage(recorded),
      }
    }
    const detail = this.redactOperatorMessage(probe.log.trim()) || '(no output)'
    if (step === 'setup') {
      return { stage: 'setup', message: `operator sandbox setup failed: ${detail}` }
    }
    if (step === 'dependencies') {
      return { stage: 'provision', message: `dependency install failed: ${detail}` }
    }
    const runtime = /^runtime-(.+)-(install|preflight)$/.exec(step)
    if (runtime !== null) {
      const group = currentRuntimeReferences(this.options.runtimeReferences).find(
        (candidate) => tailRuntimeName(candidate.runtime) === runtime[1],
      )
      return {
        stage: 'provision',
        message:
          group === undefined
            ? `runtime ${runtime[1]} ${runtime[2]} failed: ${detail}`
            : `runtime ${displayName(group.runtime)} ${runtime[2]} failed (selected by ${group.references.join(', ')}); fix workspace.config.runtimeProvisioning.${group.runtime}.${runtime[2]}: ${detail}`,
      }
    }
    return {
      stage: 'provision',
      message: `operator sandbox provisioning step ${step || '(unknown)'} failed: ${detail}`,
    }
  }

  /** An interrupted provision: the host heartbeat's step names the stage. */
  private interruptedFailure(step?: string): {
    stage: SandboxProvisionStage
    message: string
  } {
    if (step === 'checkout' || step === 'provision') {
      return {
        stage: step,
        message: `provisioning was interrupted during ${step}; call sandbox.open to retry`,
      }
    }
    return { stage: 'provision', message: SANDBOX_INTERRUPTED_MESSAGE }
  }

  private readyStatus(
    name: string,
    sandbox: VercelSandboxHandle,
    probe: Extract<VercelOperatorProbe, { kind: 'ready' }>,
    kind?: 'provision' | 'resume',
  ): SandboxProviderStatus {
    const sessionId = sandbox.currentSession?.().sessionId
    return {
      state: 'ready',
      handle: {
        provider: this.name,
        environmentId: name,
        ...(sessionId !== undefined ? { sessionId } : {}),
        workspacePath: VERCEL_WORKSPACE_PATH,
        ...(probe.marker.baseSha !== undefined ? { baseSha: probe.marker.baseSha } : {}),
      },
      ...(probe.headSha !== undefined ? { headSha: probe.headSha } : {}),
      ...(kind !== undefined ? { kind } : {}),
    }
  }

  /** Classify a running session's probe. `inFlight` marks a provision some
   * process is still driving (a running tail, a fresh host heartbeat, or a
   * tail launched within its grace). */
  private classifyOperatorProbe(
    name: string,
    sandbox: VercelSandboxHandle,
    probe: VercelOperatorProbe,
  ): { status: SandboxProviderStatus; inFlight: boolean } {
    switch (probe.kind) {
      case 'failed':
        return { status: { state: 'failed', failure: this.probeFailure(probe) }, inFlight: false }
      case 'ready':
        return { status: this.readyStatus(name, sandbox, probe), inFlight: false }
      case 'resuming':
        // Some process is refreshing the toolchain under the old marker.
        if (probe.ageSeconds < VERCEL_OPERATOR_HOST_STALE_SECONDS) {
          return { status: { state: 'resuming' }, inFlight: true }
        }
        return {
          status: {
            state: 'failed',
            failure: {
              stage: 'resume',
              message: 'resuming was interrupted before it finished; call sandbox.open to retry',
            },
          },
          inFlight: false,
        }
      case 'running':
        return { status: { state: 'provisioning' }, inFlight: true }
      case 'host': {
        const grace =
          probe.step === 'launched'
            ? VERCEL_OPERATOR_LAUNCH_GRACE_SECONDS
            : VERCEL_OPERATOR_HOST_STALE_SECONDS
        if (probe.ageSeconds < grace) return { status: { state: 'provisioning' }, inFlight: true }
        return {
          status: { state: 'failed', failure: this.interruptedFailure(probe.step) },
          inFlight: false,
        }
      }
      case 'none':
        return {
          status: { state: 'failed', failure: this.interruptedFailure() },
          inFlight: false,
        }
    }
  }

  /** The detached tail's files: one stage script per step, then the runner.
   * Every stage command is byte-identical to the host-driven chain it
   * replaces; the files carry no environment values (forwarded values ride
   * only in the launch's env record). */
  private operatorTailFiles(baseSha: string): { path: string; content: Uint8Array }[] {
    const stages: { name: string; script: string }[] = [
      { name: 'dependencies', script: DEPENDENCY_INSTALL_COMMAND },
    ]
    const references = currentRuntimeReferences(this.options.runtimeReferences)
    for (const group of [...references].sort((left, right) =>
      left.runtime < right.runtime ? -1 : left.runtime > right.runtime ? 1 : 0,
    )) {
      const provisioning = this.options.config.runtimeProvisioning?.[group.runtime]
      if (provisioning === undefined) {
        throw new Error(
          `runtime ${displayName(group.runtime)} selected by ${group.references.join(', ')} has no provisioning; add [workspace.config.runtimeProvisioning.${tomlKey(group.runtime)}] with install and preflight commands`,
        )
      }
      for (const step of ['install', 'preflight'] as const) {
        stages.push({
          name: `runtime-${tailRuntimeName(group.runtime)}-${step}`,
          script: provisioning[step],
        })
      }
    }
    const setupCommand = this.options.setupCommand
    if (setupCommand !== undefined && setupCommand.trim() !== '') {
      stages.push({ name: 'setup', script: `${this.sandboxPathPrefix()}${setupCommand}` })
    }
    stages.push({
      name: 'marker',
      script: `printf '%s' ${shellQuote(JSON.stringify({ baseSha }))} > ${shellQuote(VERCEL_PROVISIONED_MARKER)}`,
    })
    const dir = VERCEL_OPERATOR_PROVISION_DIR
    const files = stages.map((stage, index) => ({
      name: stage.name,
      file: `stage-${String(index + 1).padStart(2, '0')}-${stage.name}.sh`,
      script: stage.script,
    }))
    const runner = [
      `d=${shellQuote(dir)}`,
      'echo $$ > "$d/pid"',
      'run() {',
      '  printf "%s\\n" "$1" > "$d/stage"',
      '  printf "== %s\\n" "$1" >> "$d/log"',
      '  if ! sh "$d/$2" >> "$d/log" 2>&1; then',
      '    printf "%s\\n" "$1" > "$d/failed"',
      '    exit 1',
      '  fi',
      '}',
      ...files.map((stage) => `run ${shellQuote(stage.name)} ${shellQuote(stage.file)}`),
      '',
    ].join('\n')
    return [
      ...files.map((stage) => ({
        path: `${dir}/${stage.file}`,
        content: new Uint8Array(Buffer.from(`${stage.script}\n`)),
      })),
      { path: `${dir}/tail.sh`, content: new Uint8Array(Buffer.from(runner)) },
    ]
  }

  /** The host phase of one fresh provision: create with the idle timeout,
   * check out and scrub, provision Bun, system steps and the distribution,
   * write the tail files and launch the detached tail. Each step rewrites
   * the guest heartbeat first. A failure after create writes the guest
   * `failed` record and leaves the sandbox for its idle timer — the evidence
   * must outlive this process until the journal holds it. */
  private async runOperatorHostPhase(input: {
    origin: ReturnType<typeof cleanGithubOrigin>
    name: string
    baseBranch: string
    signal?: AbortSignal
  }): Promise<
    | { outcome: 'launched'; sandbox: VercelSandboxHandle; command: VercelCommand; baseSha: string }
    | { outcome: 'concurrent' }
  > {
    const { origin, name, signal } = input
    const checkpoint = (): void => {
      if (signal?.aborted) throw new OperatorAttemptCancelled(sandbox !== undefined)
    }
    let step: OperatorHostStep = 'checkout'
    let sandbox: VercelSandboxHandle | undefined
    try {
      const distributionIdentity = await this.identityStamp()
      const head = await this.remoteBranchHead(input.baseBranch, `remote base ${input.baseBranch}`)
      if (head === null) throw new Error(`remote base ${input.baseBranch} does not exist`)
      // The deployment-fallback operator sandbox (egress read credential) is
      // created without a git source and clones in the guest: its credential
      // reaches only the upload-pack egress transform, never the Vercel
      // source API. Every other provision keeps the configured source clone.
      const guestClone = this.options.egressReadCredential !== undefined
      const username =
        guestClone || this.options.config.gitUsernameEnv === undefined
          ? undefined
          : requireVercelEnvironmentValue(this.options.env, this.options.config.gitUsernameEnv)
      const password =
        guestClone || this.options.config.gitPasswordEnv === undefined
          ? undefined
          : requireVercelEnvironmentValue(this.options.env, this.options.config.gitPasswordEnv)
      const readAuth = guestClone
        ? this.uploadPackAuthorization()
        : password === undefined
          ? undefined
          : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      checkpoint()
      try {
        sandbox = await this.facade.create({
          name,
          ...(guestClone
            ? {}
            : {
                source: {
                  type: 'git' as const,
                  url: origin.url,
                  revision: head,
                  ...(username !== undefined && password !== undefined
                    ? { username, password }
                    : {}),
                },
              }),
          image: this.options.config.image,
          resources: { vcpus: this.options.config.vcpus },
          timeout: this.idleMs(),
          persistent: true,
          ...(this.options.config.region !== undefined
            ? { region: this.options.config.region }
            : {}),
          ...(this.options.config.failoverRegions.length > 0
            ? { failoverRegions: this.options.config.failoverRegions }
            : {}),
          ...(this.options.config.snapshotExpirationSeconds === undefined
            ? {}
            : { snapshotExpiration: this.options.config.snapshotExpirationSeconds * 1000 }),
          networkPolicy: uploadPackPolicy(origin, readAuth),
          keepLastSnapshots: { count: VERCEL_KEEP_LAST_SNAPSHOTS, deleteEvicted: true },
          signal: this.operationSignal(),
        })
      } catch (error) {
        // A concurrent instance that created the same name first owns this
        // provision; anything else is this attempt's failure.
        const existing = await this.facade.get(name, this.operationSignal()).catch(() => null)
        if (existing !== null) return { outcome: 'concurrent' }
        throw error
      }
      this.origins.set(name, origin)
      this.sessions.set(name, sandbox)
      await commandOrThrow(sandbox, { cmd: 'mkdir', args: ['-p', VERCEL_OPERATOR_PROVISION_DIR] })
      await this.heartbeat(sandbox, 'checkout')
      checkpoint()
      if (guestClone) {
        await guestCloneCheckout(sandbox, origin.url, head)
      } else {
        await relocateCheckout(sandbox, origin.directory)
      }
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
      checkpoint()
      step = 'provision'
      await this.heartbeat(sandbox, 'provision')
      await provisionBun(sandbox, this.options.config.image, signal)
      checkpoint()
      await runSystemProvisioning(sandbox, this.options.config.provisioning ?? [], signal)
      checkpoint()
      await installDistribution(
        sandbox,
        await this.archiveBytes(),
        distributionIdentity,
        this.operationSignal(),
      )
      checkpoint()
      await sandbox.writeFiles(this.operatorTailFiles(head), { signal: this.operationSignal() })
      // Forwarded values are demanded only when a runtime or setup stage
      // runs, as in the host-driven chain this replaces.
      const setup = this.options.setupCommand
      const env =
        currentRuntimeReferences(this.options.runtimeReferences).length > 0 ||
        (setup !== undefined && setup.trim() !== '')
          ? this.sandboxEnv()
          : {}
      checkpoint()
      const command = (await sandbox.runCommand({
        cmd: 'sh',
        args: [`${VERCEL_OPERATOR_PROVISION_DIR}/tail.sh`],
        cwd: VERCEL_WORKSPACE_PATH,
        env,
        detached: true,
        signal: this.operationSignal(),
      })) as VercelCommand
      step = 'launched'
      await this.heartbeat(sandbox, 'launched')
      await this.extendOperatorTimer(sandbox, 0)
      return { outcome: 'launched', sandbox, command, baseSha: head }
    } catch (error) {
      if (error instanceof OperatorAttemptCancelled || signal?.aborted) {
        throw new OperatorAttemptCancelled(sandbox !== undefined)
      }
      const failure = {
        stage:
          error instanceof SandboxOperationError && error.stage === 'environment'
            ? ('environment' as const)
            : step === 'checkout'
              ? ('checkout' as const)
              : ('provision' as const),
        message:
          this.redactOperatorMessage(error instanceof Error ? error.message : String(error)) ||
          'operator sandbox provisioning failed',
      }
      if (sandbox !== undefined) await this.writeOperatorFailure(sandbox, failure)
      throw new OperatorHostFailure(failure, sandbox !== undefined, error)
    }
  }

  /** Register one background attempt; its body resolves, never rejects. */
  private startOperatorAttempt(
    name: string,
    kind: 'provision' | 'resume',
    body: (signal: AbortSignal) => Promise<SandboxProviderStatus>,
  ): { status: SandboxProviderStatus; settled: Promise<SandboxProviderStatus> } {
    const abort = new AbortController()
    const entry = {
      kind,
      abort,
      promise: Promise.resolve<SandboxProviderStatus>({ state: 'absent' }),
    }
    this.operatorInflight.set(name, entry)
    entry.promise = (async (): Promise<SandboxProviderStatus> => {
      try {
        return await body(abort.signal)
      } catch (error) {
        const failure = {
          stage: kind === 'resume' ? ('resume' as const) : ('provision' as const),
          message:
            this.redactOperatorMessage(error instanceof Error ? error.message : String(error)) ||
            'operator sandbox provisioning failed',
        }
        this.operatorFailures.set(name, failure)
        return { state: 'failed', failure }
      } finally {
        if (this.operatorInflight.get(name) === entry) this.operatorInflight.delete(name)
      }
    })()
    return {
      status: { state: kind === 'resume' ? 'resuming' : 'provisioning', kind },
      settled: entry.promise,
    }
  }

  /** A fresh provision, replacing `stale` first when given. Settles
   * `provisioning` once the tail is launched: the tail's outcome is observed
   * later through the probe. */
  private async freshOperatorAttempt(
    input: { baseBranch: string },
    origin: ReturnType<typeof cleanGithubOrigin>,
    name: string,
    stale: VercelSandboxHandle | undefined,
    signal: AbortSignal,
  ): Promise<SandboxProviderStatus> {
    if (stale !== undefined) {
      // The journal already records this environment's failure (the
      // service's precondition for calling open). Replace the evidence with
      // a checkout heartbeat first, so a concurrent probe reads the
      // replacement as in flight rather than as the old failure.
      try {
        await stale.runCommand({
          cmd: 'sh',
          args: [
            '-c',
            'mkdir -p "$1" && rm -f "$1/failed" "$1/resuming" "$1/pid" "$2" && printf "checkout %s\\n" "$(date +%s)" > "$1/host"',
            'replace',
            VERCEL_OPERATOR_PROVISION_DIR,
            VERCEL_PROVISIONED_MARKER,
          ],
          signal: this.operationSignal(),
        })
      } catch {
        // The reap below removes it either way.
      }
      this.sessions.set(name, stale)
      try {
        await this.reap(name)
      } catch (error) {
        const failure = {
          stage: 'checkout' as const,
          message: this.redactOperatorMessage(
            `could not replace the previous environment: ${describeError(error)}`,
          ),
        }
        this.operatorFailures.set(name, failure)
        return { state: 'failed', failure }
      }
    }
    if (signal.aborted) return { state: 'absent', cancelled: true }
    try {
      await this.runOperatorHostPhase({
        origin,
        name,
        baseBranch: input.baseBranch,
        signal,
      })
      return { state: 'provisioning', kind: 'provision' }
    } catch (error) {
      if (error instanceof OperatorAttemptCancelled) {
        if (error.created) await this.reap(name).catch(() => {})
        return { state: 'absent', cancelled: true }
      }
      if (error instanceof OperatorHostFailure) {
        this.operatorFailures.set(name, error.failure)
        return { state: 'failed', failure: error.failure }
      }
      throw error
    }
  }

  /** Bring a provisioned environment's Bun and distribution to the current
   * pin, then report it ready. A failure is recorded in the guest first
   * (stage `resume`), superseding the marker. */
  private async refreshOperatorRuntime(
    sandbox: VercelSandboxHandle,
    name: string,
    probe: Extract<VercelOperatorProbe, { kind: 'ready' }>,
  ): Promise<SandboxProviderStatus> {
    try {
      // Every process's probe reads the refresh as in flight (outranking the
      // old marker) until it succeeds; a failure supersedes it with `failed`.
      await commandOrThrow(sandbox, {
        cmd: 'sh',
        args: [
          '-c',
          'mkdir -p "$1" && printf "%s\\n" "$(date +%s)" > "$1/resuming"',
          'resuming',
          VERCEL_OPERATOR_PROVISION_DIR,
        ],
        signal: this.operationSignal(),
      })
      await ensurePinnedBun(sandbox, this.options.config.image, this.operationSignal())
      const identity = await this.identityStamp()
      if (probe.distribution !== identity) {
        await installDistribution(
          sandbox,
          await this.archiveBytes(),
          identity,
          this.operationSignal(),
        )
      }
      await commandOrThrow(sandbox, {
        cmd: 'sh',
        args: ['-c', 'rm -f "$1/resuming"', 'resumed', VERCEL_OPERATOR_PROVISION_DIR],
        signal: this.operationSignal(),
      })
    } catch (error) {
      const failure = {
        stage: 'resume' as const,
        message:
          this.redactOperatorMessage(error instanceof Error ? error.message : String(error)) ||
          'operator sandbox resume failed',
      }
      await this.writeOperatorFailure(sandbox, failure)
      this.operatorFailures.set(name, failure)
      return { state: 'failed', failure }
    }
    await this.extendOperatorTimer(sandbox, 0)
    this.sessions.set(name, sandbox)
    return this.readyStatus(name, sandbox, probe, 'resume')
  }

  /** Resume a stopped environment: the only path that recovers evidence
   * from a stopped sandbox, because status never resumes one. A recorded
   * failure settles with its recorded stage and message; nothing is reaped
   * here. */
  private async resumeOperatorAttempt(
    sandbox: VercelSandboxHandle,
    name: string,
  ): Promise<SandboxProviderStatus> {
    await this.applyOperatorSession(sandbox, name)
    let probe = await this.probeOperator(sandbox)
    if (probe.kind === 'resuming') {
      // The stop ended that refresh; this attempt redoes it.
      await commandOrThrow(sandbox, {
        cmd: 'sh',
        args: ['-c', 'rm -f "$1/resuming"', 'resumed', VERCEL_OPERATOR_PROVISION_DIR],
        signal: this.operationSignal(),
      })
      probe = await this.probeOperator(sandbox)
    }
    if (probe.kind === 'ready') return this.refreshOperatorRuntime(sandbox, name, probe)
    if (probe.kind === 'running') return { state: 'provisioning', kind: 'provision' }
    const failure =
      probe.kind === 'failed'
        ? this.probeFailure(probe)
        : this.interruptedFailure(probe.kind === 'host' ? probe.step : undefined)
    this.operatorFailures.set(name, failure)
    return { state: 'failed', failure }
  }

  private async openOperator(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<{ status: SandboxProviderStatus; settled?: Promise<SandboxProviderStatus> }> {
    const { origin, name } = await this.operatorName(input.operator)
    return this.withPolicyLock(name, async () => {
      const inflight = this.operatorInflight.get(name)
      if (inflight !== undefined) {
        return {
          status: {
            state: inflight.kind === 'resume' ? 'resuming' : 'provisioning',
            kind: inflight.kind,
          },
          settled: inflight.promise,
        }
      }
      this.operatorFailures.delete(name)
      const sandbox = await this.facade.get(name, this.operationSignal())
      if (sandbox === null) {
        return this.startOperatorAttempt(name, 'provision', (signal) =>
          this.freshOperatorAttempt(input, origin, name, undefined, signal),
        )
      }
      const session = sandbox.sessionStatus
      if (session === undefined || session === 'running') {
        await this.applyOperatorSession(sandbox, name)
        const probe = await this.probeOperator(sandbox)
        if (probe.kind === 'ready') {
          if (
            probe.bunVersion === VERCEL_BUN_VERSION &&
            probe.distribution === (await this.identityStamp())
          ) {
            await this.extendOperatorTimer(sandbox, 0)
            this.sessions.set(name, sandbox)
            return { status: this.readyStatus(name, sandbox, probe, 'resume') }
          }
          return this.startOperatorAttempt(name, 'resume', () =>
            this.refreshOperatorRuntime(sandbox, name, probe),
          )
        }
        if (this.classifyOperatorProbe(name, sandbox, probe).inFlight) {
          // Another process's provision or refresh is in flight.
          return {
            status:
              probe.kind === 'resuming'
                ? { state: 'resuming', kind: 'resume' }
                : { state: 'provisioning', kind: 'provision' },
          }
        }
        // A failed, interrupted or marker-less environment. The service
        // calls open only after the journal records its failure, so its
        // evidence may now be replaced.
        return this.startOperatorAttempt(name, 'provision', (signal) =>
          this.freshOperatorAttempt(input, origin, name, sandbox, signal),
        )
      }
      if (session === 'pending') return { status: { state: 'resuming', kind: 'resume' } }
      return this.startOperatorAttempt(name, 'resume', () =>
        this.resumeOperatorAttempt(sandbox, name),
      )
    })
  }

  private async statusOperator(input: {
    repo: string
    operator: string
  }): Promise<SandboxProviderStatus> {
    const { name } = await this.operatorName(input.operator)
    const inflight = this.operatorInflight.get(name)
    if (inflight !== undefined) {
      return { state: inflight.kind === 'resume' ? 'resuming' : 'provisioning' }
    }
    const failure = this.operatorFailures.get(name)
    if (failure !== undefined) return { state: 'failed', failure }
    const sandbox = await this.facade.get(name, this.operationSignal())
    if (sandbox === null) return { state: 'absent' }
    // Never a guest command on a session that is not running: it would
    // resume it.
    const session = sandbox.sessionStatus
    if (session === 'pending') return { state: 'resuming' }
    if (session !== undefined && session !== 'running') return { state: 'stopped' }
    const { status, inFlight } = this.classifyOperatorProbe(
      name,
      sandbox,
      await this.probeOperator(sandbox),
    )
    // Only a provision in flight keeps the timer alive; polling a ready,
    // idle environment never does.
    if (inFlight) await this.extendOperatorTimer(sandbox, 0)
    return status
  }

  private async closeOperator(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ outcome: 'closed' | 'absent'; attempt?: SandboxProviderStatus }> {
    const { name } = await this.operatorName(input.operator)
    let attempt: SandboxProviderStatus | undefined
    const inflight = this.operatorInflight.get(name)
    if (inflight !== undefined) {
      inflight.abort.abort()
      attempt = await inflight.promise
    }
    return this.withPolicyLock(name, async () => {
      const withAttempt = <T extends object>(result: T) =>
        attempt === undefined ? result : { ...result, attempt }
      const sandbox = await this.facade.get(name, this.operationSignal())
      if (sandbox === null) return withAttempt({ outcome: 'absent' as const })
      if (attempt?.cancelled === true) return withAttempt({ outcome: 'absent' as const })
      const session = sandbox.sessionStatus
      const running = session === undefined || session === 'running'
      if (running && attempt === undefined) {
        const probe = await this.probeOperator(sandbox)
        const { status, inFlight } = this.classifyOperatorProbe(name, sandbox, probe)
        if (inFlight && probe.kind !== 'resuming') {
          // Closing an in-flight provision is a user-requested cancel; a
          // refresh of a provisioned checkout is stopped, never discarded.
          this.sessions.set(name, sandbox)
          await this.reap(name)
          return { outcome: 'absent' as const, attempt: { state: 'absent', cancelled: true } }
        }
        if (status.state === 'failed') attempt = status
      }
      // Stopping releases capacity and keeps the snapshot — and with it any
      // failure evidence, which a later open recovers.
      if (running) {
        try {
          await sandbox.stop({ signal: this.operationSignal() })
        } catch (error) {
          if (!isInterruptedLongPoll(error)) {
            const after = await this.facade.get(name, this.operationSignal())
            if (after === null) return withAttempt({ outcome: 'absent' as const })
            if (after.sessionStatus === 'running') throw error
          }
        }
      }
      this.sessions.delete(name)
      return withAttempt({ outcome: 'closed' as const })
    })
  }

  private async refreshOperator(
    handle: SandboxEnvironmentIdentity,
    input: { repo: string; baseBranch: string },
  ): Promise<SandboxRefreshResult> {
    const base = await this.remoteBranchHead(input.baseBranch, `remote base ${input.baseBranch}`)
    if (base === null) {
      throw new SandboxOperationError('refresh', `remote base ${input.baseBranch} does not exist`)
    }
    const sandbox = await this.sandboxHandle(handle)
    const git = (args: string[], env?: Record<string, string>) =>
      sandbox.runCommand({
        cmd: 'git',
        args,
        cwd: VERCEL_WORKSPACE_PATH,
        ...(env !== undefined ? { env } : {}),
        signal: this.operationSignal(),
      }) as Promise<VercelCommand>
    const status = await readableCommand(sandbox, {
      cmd: 'git',
      args: ['status', '--porcelain'],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    if (status.trim() !== '') {
      return { outcome: 'refused', reason: 'dirty', message: SANDBOX_REFRESH_DIRTY_MESSAGE }
    }
    const head = (
      await readableCommand(sandbox, {
        cmd: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: VERCEL_WORKSPACE_PATH,
      })
    ).trim()
    // No credential rides the fetch: the upload-pack egress transform
    // authenticates it.
    const fetched = await git(['fetch', '--quiet', 'origin', input.baseBranch], {
      GIT_TERMINAL_PROMPT: '0',
    })
    if (fetched.exitCode !== 0) {
      const stderr = (await fetched.stderr?.().catch(() => '')) ?? ''
      throw new SandboxOperationError(
        'refresh',
        this.redactOperatorMessage(
          `git fetch origin ${input.baseBranch} exited ${fetched.exitCode}: ${stderr.trim() || '(no output)'}`,
        ),
      )
    }
    const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
      const result = await git(['merge-base', '--is-ancestor', ancestor, descendant])
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      throw new SandboxOperationError(
        'refresh',
        `git merge-base --is-ancestor ${ancestor} ${descendant} exited ${result.exitCode}`,
      )
    }
    if (head === base || (await isAncestor(base, head))) {
      return { outcome: 'current', headSha: head, baseSha: base, previousHeadSha: head }
    }
    if (!(await isAncestor(head, base))) {
      return {
        outcome: 'refused',
        reason: 'diverged',
        message: sandboxRefreshDivergedMessage(head, input.baseBranch, base),
      }
    }
    await readableCommand(sandbox, {
      cmd: 'git',
      args: ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', base],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    await commandOrThrow(sandbox, {
      cmd: 'sh',
      args: [
        '-c',
        'printf %s "$1" > "$2"',
        'marker',
        JSON.stringify({ baseSha: base }),
        VERCEL_PROVISIONED_MARKER,
      ],
    })
    return { outcome: 'refreshed', headSha: base, baseSha: base, previousHeadSha: head }
  }

  /** Resolve the live handle behind a journal-carried environment id. A
   * missing environment is a typed `not-found`; a session the provider timer
   * stopped refuses typed `not-ready` (`stopped`) rather than resuming
   * inline — `sandbox.open` resumes it. A running session's timer is
   * extended to cover `boundMs` (the call's own wait bound) or the idle
   * timeout, whichever is longer. */
  private async sandboxHandle(
    handle: SandboxEnvironmentIdentity,
    boundMs = 0,
  ): Promise<VercelSandboxHandle> {
    const sandbox = await this.facade.get(handle.environmentId, this.operationSignal())
    if (sandbox === null) {
      throw new SandboxOperationError(
        'not-found',
        `operator sandbox ${handle.environmentId} no longer exists`,
      )
    }
    const session = sandbox.sessionStatus
    if (session !== undefined && session !== 'running') {
      const state = session === 'pending' ? 'resuming' : 'stopped'
      throw new SandboxOperationError(
        'not-ready',
        state === 'resuming'
          ? 'operator sandbox is resuming; poll sandbox.status until it reports ready'
          : 'operator sandbox is stopped; call sandbox.open and poll sandbox.status until it reports ready',
        { state },
      )
    }
    await this.extendOperatorTimer(sandbox, boundMs)
    this.sessions.set(handle.environmentId, sandbox)
    return sandbox
  }

  /** One bounded-wait mechanism shared by `exec` and `wait` (the
   * `waitForCommandExit` pattern with the caller's deadline): interrupted
   * long-polls are re-issued until the explicit deadline; any other failure
   * propagates immediately. `operationTimeoutMs` bounds only handle lookups
   * and kill — never the wait itself, so a 300 s command is not cut off at
   * the 30 s operation timeout. */
  private async waitForSandboxExit(
    command: Pick<VercelCommand, 'wait'>,
    deadlineMs: number,
  ): Promise<{ exitCode: number }> {
    for (;;) {
      try {
        return await command.wait({})
      } catch (error) {
        if (!isInterruptedLongPoll(error) || Date.now() > deadlineMs) throw error
      }
    }
  }

  private async sandboxRootedPath(
    handle: SandboxEnvironmentIdentity,
    path: string,
  ): Promise<string> {
    if (path.includes('\\')) {
      throw new SandboxOperationError(
        'exec',
        `sandbox path ${JSON.stringify(path)} must use "/" separators`,
      )
    }
    return `${handle.workspacePath.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  }

  private async sandboxLaunch(
    sandbox: VercelSandboxHandle,
    request: SandboxCommandRequest,
  ): Promise<VercelCommand> {
    const command = (await sandbox.runCommand({
      cmd: 'sh',
      // The toolchain PATH is prepended inside the guest shell — the only
      // channel where `$PATH` expands (the sandbox env doc comment explains
      // why it cannot ride in the env record).
      args: ['-c', `${this.sandboxPathPrefix()}${request.command}`],
      ...(request.cwd !== undefined
        ? { cwd: `${VERCEL_WORKSPACE_PATH}/${request.cwd.replace(/^\/+/, '')}` }
        : { cwd: VERCEL_WORKSPACE_PATH }),
      env: this.sandboxEnv(),
      detached: true,
      signal: this.operationSignal(),
    })) as VercelCommand
    return command
  }

  private async sandboxExec(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult> {
    const timeoutSeconds = Math.min(
      Math.max(request.timeoutSeconds ?? 120, 1),
      SANDBOX_MAX_WAIT_SECONDS,
    )
    const sandbox = await this.sandboxHandle(handle, timeoutSeconds * 1000 + 60_000)
    const command = await this.sandboxLaunch(sandbox, request)
    const deadline = Date.now() + timeoutSeconds * 1000
    let exit: { exitCode: number }
    try {
      exit = await this.waitForSandboxExit(command, deadline)
    } catch (error) {
      if (Date.now() >= deadline) {
        try {
          await command.kill('SIGTERM', { abortSignal: this.operationSignal() })
        } catch {
          /* already exited */
        }
        throw new SandboxOperationError(
          'exec-timeout',
          `sandbox command exceeded its ${timeoutSeconds}s bound and was killed`,
          { cause: error },
        )
      }
      throw new SandboxOperationError(
        'exec',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    const [stdout, stderr] = await Promise.all([
      command.stdout?.() ?? Promise.resolve(''),
      command.stderr?.() ?? Promise.resolve(''),
    ])
    return { exitCode: exit.exitCode, stdout, stderr }
  }

  private async sandboxStart(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<{ commandId: string }> {
    const sandbox = await this.sandboxHandle(handle)
    const command = await this.sandboxLaunch(sandbox, request)
    return { commandId: command.cmdId }
  }

  private async sandboxWait(
    handle: SandboxEnvironmentIdentity,
    input: { commandId: string; waitSeconds: number },
  ): Promise<SandboxWaitResult> {
    const waitSeconds = Math.min(Math.max(input.waitSeconds, 0), SANDBOX_MAX_WAIT_SECONDS)
    const sandbox = await this.sandboxHandle(handle, waitSeconds * 1000 + 60_000)
    const lookup = await sandbox.getCommand(input.commandId, { signal: this.operationSignal() })
    if (lookup.exitCode !== null) {
      const [stdout, stderr] = await Promise.all([
        lookup.stdout?.() ?? Promise.resolve(''),
        lookup.stderr?.() ?? Promise.resolve(''),
      ])
      return { state: 'exited', exitCode: lookup.exitCode, stdout, stderr }
    }
    if (waitSeconds === 0) return { state: 'running' }
    const deadline = Date.now() + waitSeconds * 1000
    try {
      const exit = await this.waitForSandboxExit(lookup, deadline)
      const [stdout, stderr] = await Promise.all([
        lookup.stdout?.() ?? Promise.resolve(''),
        lookup.stderr?.() ?? Promise.resolve(''),
      ])
      return { state: 'exited', exitCode: exit.exitCode, stdout, stderr }
    } catch (error) {
      if (isMissingVercelSandbox(error)) {
        throw new SandboxOperationError(
          'not-found',
          `operator sandbox ${handle.environmentId} no longer exists`,
          { cause: error },
        )
      }
      // Interrupted-poll exhaustion at the deadline leaves the command
      // provably unobserved: still running, no output (Vercel reports
      // output only after exit). Any other failure is real.
      if (Date.now() >= deadline || isInterruptedLongPoll(error)) return { state: 'running' }
      throw new SandboxOperationError(
        'exec',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
  }

  private async sandboxReadFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
  ): Promise<Uint8Array> {
    const rooted = await this.sandboxRootedPath(handle, path)
    // Exec-mechanism read through a byte-preserving channel: `base64` on the
    // rooted path (the path rides as its own argv element), decoded after
    // exit. Reading the file through the string `stdout()` channel would
    // mangle arbitrary binary before the registry's utf8-else-base64 branch
    // could preserve it; base64 survives that channel exactly, and the
    // decoder strips the wrapping whitespace GNU base64 inserts.
    const sandbox = await this.sandboxHandle(handle)
    const command = (await sandbox.runCommand({
      cmd: 'base64',
      args: [rooted],
      cwd: VERCEL_WORKSPACE_PATH,
      detached: true,
      signal: this.operationSignal(),
    })) as VercelCommand
    const deadline = Date.now() + 120 * 1000
    let exit: { exitCode: number }
    try {
      exit = await this.waitForSandboxExit(command, deadline)
    } catch (error) {
      throw new SandboxOperationError(
        'exec',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    if (exit.exitCode !== 0) {
      const stderr = await command.stderr?.().catch(() => '')
      throw new SandboxOperationError(
        'not-found',
        `could not read sandbox file ${JSON.stringify(path)}: exit ${exit.exitCode}${stderr ? `: ${stderr.trim()}` : ''}`,
      )
    }
    const stdout = await command.stdout?.().catch(() => '')
    return new Uint8Array(Buffer.from((stdout ?? '').replace(/\s+/g, ''), 'base64'))
  }

  private async sandboxWriteFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    const sandbox = await this.sandboxHandle(handle)
    const rooted = await this.sandboxRootedPath(handle, path)
    try {
      await sandbox.writeFiles([{ path: rooted, content }], {
        signal: this.operationSignal(),
      })
    } catch (error) {
      throw new SandboxOperationError(
        'exec',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
  }

  private async sandboxStop(input: {
    operator: string
    environmentId: string
  }): Promise<{ outcome: 'stopped' | 'absent' | 'unsupported' }> {
    const sandbox = await this.facade.get(input.environmentId, this.operationSignal())
    if (sandbox === null) return { outcome: 'absent' }
    try {
      await sandbox.stop({ signal: this.operationSignal() })
    } catch (error) {
      // A stopped/expired session may reject a stop idempotently; absence is
      // proven by re-resolution, and any other failure propagates as typed.
      const stillThere = await this.facade.get(input.environmentId, this.operationSignal())
      if (stillThere === null) return { outcome: 'absent' }
      throw new SandboxOperationError(
        'exec',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    return { outcome: 'stopped' }
  }

  private async sandboxRelease(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{
    snapshots: { outcome: 'confirmed' | 'unknown'; deleted?: number; error?: string }
  }> {
    // An in-flight attempt is cancelled and awaited before the teardown.
    const inflight = this.operatorInflight.get(input.environmentId)
    if (inflight !== undefined) {
      inflight.abort.abort()
      await inflight.promise
    }
    this.operatorFailures.delete(input.environmentId)
    const reap = await this.reap(input.environmentId)
    return {
      snapshots: {
        outcome: reap.snapshots.outcome === 'unknown' ? 'unknown' : 'confirmed',
        ...(reap.snapshots.deleted !== undefined ? { deleted: reap.snapshots.deleted } : {}),
        ...(reap.snapshots.error !== undefined ? { error: reap.snapshots.error } : {}),
      },
    }
  }

  /** Host-seam fallbacks: the injected origin/branch-head readers when given
   * (checkout-less origin mode), otherwise host `git` executed from the
   * dispatcher-local checkout. */
  private async origin(): Promise<string> {
    if (this.options.origin !== undefined) return this.options.origin()
    return execOrThrow(this.exec, ['git', 'remote', 'get-url', 'origin'], this.options.repo)
  }

  /** Guest git transport whose refused archive pushes fall back to the host. */
  private archiveTransport(exec: Exec): ForgeRewrite {
    return gitRewrite(exec, false, undefined, this.options.refusedArchive)
  }

  private async remoteBranchHead(branch: string, _label: string): Promise<string | null> {
    if (this.options.remoteBranchHead !== undefined) {
      const head = (await this.options.remoteBranchHead(branch)) ?? null
      if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head))
        throw new Error('invalid authoritative remote branch head')
      return head
    }
    return parseRemoteHead(
      await execOrThrow(
        this.exec,
        ['git', 'ls-remote', '--refs', 'origin', `refs/heads/${branch}`],
        this.options.repo,
      ),
      `refs/heads/${branch}`,
    )
  }

  private async isPublished(input: { sha: string; branch: string }): Promise<boolean> {
    // Inspection must not resume a stopped persistent guest. Publication owns
    // its cache refresh before teardown; recovery needs only forge readback.
    const head = await this.remoteBranchHead(input.branch, `published branch ${input.branch}`)
    return head === input.sha
  }

  private async withTrustedGit<T>(
    sandbox: VercelSandboxHandle,
    ref: string,
    effect: (exec: Exec) => Promise<T>,
  ): Promise<T> {
    const { origin } = await this.normalNetworkPolicy(ref)
    const token = this.options.env.GITHUB_TOKEN || this.options.env.GH_TOKEN
    if (!token) throw new Error('workspace preservation requires GITHUB_TOKEN or GH_TOKEN')
    const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    const policy: NetworkPolicy = {
      allow: {
        [origin.host]: [
          {
            match: {
              method: ['GET'],
              path: { exact: `${origin.path}/info/refs` },
              queryString: [
                { key: { exact: 'service' }, value: { regex: '^git-(receive|upload)-pack$' } },
              ],
            },
            transform: [{ headers: { authorization } }],
          },
          {
            match: {
              method: ['POST'],
              path: {
                regex: `^${origin.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/git-(receive|upload)-pack$`,
              },
            },
            transform: [{ headers: { authorization } }],
          },
        ],
      },
    }
    try {
      await sandbox.update(
        { networkPolicy: this.billingPolicy(policy, ref) },
        { signal: this.operationSignal() },
      )
      return await effect(async (cmd) => {
        const result = await sandbox.runCommand({
          cmd: cmd[0]!,
          args: cmd.slice(1),
          cwd: VERCEL_WORKSPACE_PATH,
          signal: this.operationSignal(),
        })
        if (!('stdout' in result) || !('stderr' in result) || result.exitCode === null)
          throw new Error('trusted preservation requires captured command output')
        return {
          exitCode: result.exitCode,
          stdout: await result.stdout!(),
          stderr: await result.stderr!(),
        }
      })
    } finally {
      try {
        await sandbox.update(
          { networkPolicy: (await this.normalNetworkPolicy(ref)).policy },
          { signal: this.operationSignal() },
        )
      } finally {
        await sandbox.stop({ signal: this.operationSignal() })
      }
    }
  }

  private async publish(
    input: Parameters<NonNullable<WorkspacePublication['rewrite']>>[0],
  ): Promise<import('../types').RewriteResult>
  private async publish(input: { ref: string; sha: string; branch: string }): Promise<void>
  private async publish(input: {
    ref: string
    sha: string
    branch: string
    expected?: string
    localExpected?: string
    archives?: { ref: string; sha: string }[]
    retain?: Parameters<NonNullable<WorkspacePublication['rewrite']>>[0]['retain']
  }): Promise<void | import('../types').RewriteResult> {
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
    const { origin } = await this.normalNetworkPolicy(input.ref)
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
              queryString: [
                {
                  key: { exact: 'service' },
                  value:
                    input.expected === undefined
                      ? { exact: 'git-receive-pack' }
                      : { regex: '^git-(receive|upload)-pack$' },
                },
              ],
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
            match: {
              method: ['POST'],
              path:
                input.expected === undefined
                  ? { exact: `${origin.path}/git-receive-pack` }
                  : {
                      regex: `^${origin.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/git-(receive|upload)-pack$`,
                    },
            },
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
      await sandbox.update(
        { networkPolicy: this.billingPolicy(publicationPolicy, input.ref) },
        { signal: this.operationSignal() },
      )
      if (input.expected !== undefined) {
        const trustedExec: Exec = async (cmd) => {
          const result = await sandbox.runCommand({
            cmd: cmd[0]!,
            args: cmd.slice(1),
            cwd: VERCEL_WORKSPACE_PATH,
          })
          if (result.exitCode === null)
            throw new Error('trusted rewrite command has no exit status')
          if (!('stdout' in result) || !('stderr' in result))
            throw new Error('trusted rewrite requires command output capture')
          return {
            exitCode: result.exitCode,
            stdout: await result.stdout!(),
            stderr: await result.stderr!(),
          }
        }
        const capability = this.archiveTransport(trustedExec)
        for (const archive of input.archives ?? [])
          if (input.retain)
            await input.retain({
              exec: trustedExec,
              workspacePath: VERCEL_WORKSPACE_PATH,
              archive: capability.archive,
              ...archive,
            })
          else await capability.archive({ workspacePath: VERCEL_WORKSPACE_PATH, ...archive })
        return await capability.replace({
          workspacePath: VERCEL_WORKSPACE_PATH,
          branch: input.branch,
          expected: input.expected,
          ...(input.localExpected !== undefined ? { localExpected: input.localExpected } : {}),
          sha: input.sha,
        })
      }
      if (!(await this.isPublished(input))) {
        try {
          await commandOrThrow(sandbox, {
            cmd: 'git',
            args: ['push', '--no-verify', 'origin', `${input.sha}:refs/heads/${input.branch}`],
            cwd: VERCEL_WORKSPACE_PATH,
          })
        } catch (error) {
          if (!(await this.isPublished(input))) throw error
        }
      }
      // Post-push verification without host git: the injected branch-head
      // reader (origin mode) or the host ls-remote fallback answers.
      const published = await this.remoteBranchHead(input.branch, 'published branch')
      if (published !== input.sha)
        throw new Error(`published head ${published ?? '(missing)'} did not match ${input.sha}`)
      await commandOrThrow(sandbox, {
        cmd: 'git',
        args: ['update-ref', `refs/heads/${input.branch}`, input.sha],
        cwd: VERCEL_WORKSPACE_PATH,
      })
      await sandbox.stop({ signal: this.operationSignal() })
    } finally {
      try {
        await sandbox.update(
          { networkPolicy: (await this.normalNetworkPolicy(input.ref)).policy },
          { signal: this.operationSignal() },
        )
      } finally {
        await sandbox.stop({ signal: this.operationSignal() })
      }
    }
  }
}

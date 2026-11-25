import { WorkspaceCleanupRequired } from '../types'
function scopedProvider(options: ConstructorParameters<typeof VercelSandboxProvider>[0]) {
  const provider = new VercelSandboxProvider(options)
  const start = provider.harvestExecution.start
  provider.harvestExecution.start = (input, auth = { token: 'delegated-store-token' }) =>
    start(input, auth)
  return provider
}

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkPolicy } from '@vercel/sandbox'
import { parse as parseToml } from 'smol-toml'
import { distributionRoot } from '../../distribution'
import { REMOTE_STORE_PROTOCOL_VERSION } from '../../store/remote/version'
import type { DelegateCredentialTarget } from '../../store/remote/protocol'
import {
  distributionStampFor,
  packageAutobuildDistribution,
  readDistributionIdentity,
} from './distribution-archive'
import { spawnExec, type Exec } from './git-worktree'
import { HARVEST_RUNNER_OPTIONS_ENV } from './harvest-execution'
import {
  SANDBOX_FORBIDDEN_ENV,
  SANDBOX_INTERRUPTED_MESSAGE,
  SANDBOX_REFRESH_DIRTY_MESSAGE,
  SandboxOperationError,
} from './operator-sandbox'
import {
  sandboxEnvironmentName,
  VERCEL_AUTOBUILD_PATH,
  VERCEL_BUN_BIN_PATH,
  VERCEL_BUN_EXECUTABLE,
  VERCEL_BUN_PREFIX,
  VERCEL_BUN_VERSION,
  VERCEL_DISTRIBUTION_VERSION_MARKER,
  VERCEL_LIFETIME_MARGIN_MS,
  VERCEL_OPERATOR_PROBE_SCRIPT,
  VERCEL_OPERATOR_PROVISION_DIR,
  parseVercelOperatorProbe,
  VERCEL_PROVISIONED_MARKER,
  VERCEL_PROVISION_ESTIMATE_MS,
  VERCEL_WORKSPACE_PATH,
  VercelSandboxProvider,
  harvestSandboxName,
  validateVercelSandbox,
  isMissingVercelSandbox,
  isUnavailableVercelSnapshot,
  createVercelSdkFacade,
  vercelOidcTokenScope,
  vercelSdkCredentials,
  sourceCheckoutPath,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
  type VercelSnapshotInfo,
} from './vercel-sandbox'

import { settleOpenExecution } from '../../processes/execution-settlement'
import { settlePendingPublication } from '../../cli/publication-settlement'
import { agentActor, DISPATCHER } from '../../events/envelope'
import { sequentialIds } from '../../ids'
import { FakeForge } from '../forge/fake'
import { MemoryBuildStore } from '../../store/memory'
import {
  createOperatorSandboxService,
  SANDBOX_ORPHAN_MESSAGE,
  SANDBOX_PROVISION_ORPHAN_MS,
  SANDBOX_UNRECORDED_FAILURE_MESSAGE,
} from '../../operator/sandbox'

const SHA = 'a'.repeat(40)

class FakeSandbox implements VercelSandboxHandle {
  readonly name = 'sandbox'
  cwd: string | undefined
  readonly commands: Array<Record<string, unknown>> = []
  readonly policies: NetworkPolicy[] = []
  readonly policySignals: Array<AbortSignal | undefined> = []
  readonly killSignals: Array<AbortSignal | undefined> = []
  writes: Array<{ path: string; content: Uint8Array }> = []
  stops = 0
  stopFailures = 0
  deletes = 0
  remainAfterDelete = false
  deleteFailure: Error | undefined
  failPush = false
  failRestore = false
  failSetupCommand: string | undefined
  failCommand: ((params: Record<string, unknown>) => boolean) | undefined
  failureStdout = ''
  failureStderr = ''
  provisioned = false
  /** The version the guest's provisioned Bun reports; `undefined` models a
   * missing or unrunnable executable. */
  bunVersion: string | undefined = VERCEL_BUN_VERSION
  /** The version a pinned `npm install bun@X` actually yields; defaults to X. */
  bunInstallVersion: string | undefined
  /** The commit the guest checkout's HEAD is on. Creation sets it to the
   * source revision and `git checkout -B` moves it; a sandbox the test never
   * created starts at SHA. */
  head: string | undefined = SHA
  /** When set, the build branch ref resolves here instead of HEAD. */
  branchHead: string | undefined
  /** When set, `git checkout -B` lands HEAD here instead of the named commit. */
  checkoutLands: string | undefined
  /** Whether the guest holds a git checkout; `undefined` follows the
   * provisioned marker, `false` models a half-provisioned VM. */
  checkout: boolean | undefined
  /** Simulated content of the guest's `.distribution-version` marker;
   * `undefined` models an unreadable or absent marker (legacy guest). */
  distributionVersion: string | undefined
  /** When set, reading the marker returns this instead of the written value,
   * modeling a silent write/extraction failure. */
  markerReadback: string | undefined
  /** Simulated content of an arbitrary guest file, served by a detached
   * `base64` command (the operator sandbox's readFile channel). */
  fileContent: Uint8Array | undefined
  detachedWait: (params?: { signal?: AbortSignal }) => Promise<{ exitCode: number }> =
    async () => ({
      exitCode: 0,
    })
  /** Session status reported to `observe`; undefined models an SDK without it. */
  sessionStatus: VercelSandboxHandle['sessionStatus'] = 'running'
  /** Epoch-ms session expiry reported to `observe`; undefined models a facade
   * without the getter or with no running session (unbounded behavior). */
  sessionExpiresAt: number | undefined
  /** Recorded detached commands by id, for `getCommand` re-observation: the
   * OBSERVED state, which stays `exitCode: null` until some wait has resolved
   * an exit — exactly the provider's plain-lookup contract. */
  readonly detachedCommands = new Map<string, { exitCode: number | null }>()
  /** The guest's TRUE outcome per command id, settable by tests: a wait
   * resolves this exit when known even though the lookup still reports none
   * (the detached-guest case the observation's bounded wait exists for). */
  readonly detachedExits = new Map<string, number>()
  /** Command waits issued since construction, across supervision and
   * observation paths. */
  waitCalls = 0
  getCommandCalls = 0
  /** Automatic snapshots the environment has accumulated; a session stop
   * creates one, exactly as the provider's SDK contract describes. */
  readonly snapshots: VercelSnapshotInfo[] = []

  // ── Operator provisioning guest state (#1246) ──
  /** Every `update` carrying a timeout, in ms. */
  readonly timeoutUpdates: number[] = []
  /** Every `extendTimeout` duration, in ms. */
  readonly extensions: number[] = []
  extendFailure: Error | undefined
  /** The guest `failed` record; written by a host failure command or a
   * failing tail. */
  failedContent: string | undefined
  /** The provisioned marker's content (`provisioned` is its existence). */
  markerContent = ''
  /** Whether the detached tail is alive (`running`) when probed. */
  tailRunning = false
  /** A runtime refresh in progress (`resuming` record), by age. */
  resumingAgeSeconds: number | undefined
  /** When set, a matching command waits for the returned promise first: a
   * slow guest step another process can observe meanwhile. */
  commandGate: ((params: Record<string, unknown>) => Promise<void> | undefined) | undefined
  /** The `host` heartbeat: its step and age in guest seconds. */
  hostHeartbeat: { step: string; ageSeconds: number } | undefined
  /** The tail's log, read back by a failed probe. */
  logTail = ''
  /** How the next launched tail ends: completes (default), keeps running,
   * or fails at the named stage with `logTail` as its output. */
  tailOutcome: 'complete' | 'running' | { failAt: string } = 'complete'
  tailLaunches = 0
  probes = 0
  /** When set, any guest command on a session that is not running fails
   * the test: a guest command would resume a persistent sandbox. */
  guardStopped = false
  /** When set, a guest command on a stopped session resumes it, as the
   * SDK's persistent sandboxes do. */
  autoResume = false
  /** The command count at each `update`: an update before any guest
   * command of a resume shows the idle timeout applied first. */
  readonly updateAtCommand: number[] = []
  /** Answers a `git` command before the defaults (refresh's guest git). */
  gitResponder:
    | ((args: string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined)
    | undefined

  /** The probe's output for the current guest state, in the real script's
   * precedence: failed, marker, running tail, host heartbeat, none. */
  private probeOutput(): string {
    const b64 = (value: string) => Buffer.from(value).toString('base64')
    if (this.failedContent !== undefined)
      return `result failed\nfailed ${b64(this.failedContent)}\nlog ${b64(this.logTail)}\n`
    if (this.resumingAgeSeconds !== undefined)
      return `result resuming\nresuming 1000\nnow ${1000 + this.resumingAgeSeconds}\n`
    if (this.provisioned)
      return [
        'result ready',
        `marker ${b64(this.markerContent)}`,
        `head ${this.head ?? ''}`,
        `bun ${this.bunVersion ?? ''}`,
        `distribution ${this.distributionVersion ?? ''}`,
        '',
      ].join('\n')
    if (this.tailRunning) return 'result running\nstage dependencies\n'
    if (this.hostHeartbeat !== undefined)
      return `result host\nhost ${this.hostHeartbeat.step} 1000\nnow ${1000 + this.hostHeartbeat.ageSeconds}\n`
    return 'result none\n'
  }

  /** The base head the written marker stage records. */
  private writtenMarker(): string {
    const stage = [...this.writes].reverse().find((write) => write.path.endsWith('-marker.sh'))
    const match = /\{"baseSha":"[0-9a-f]+"\}/.exec(
      Buffer.from(stage?.content ?? new Uint8Array()).toString('utf8'),
    )
    return match?.[0] ?? ''
  }

  /** Reset the guest state a fresh create starts from. */
  resetGuest(): void {
    this.failedContent = undefined
    this.resumingAgeSeconds = undefined
    this.markerContent = ''
    this.tailRunning = false
    this.hostHeartbeat = undefined
    this.logTail = ''
    this.provisioned = false
  }

  async extendTimeout(duration: number) {
    this.extensions.push(duration)
    if (this.extendFailure !== undefined) throw this.extendFailure
    if (this.sessionExpiresAt !== undefined) this.sessionExpiresAt += duration
  }

  currentSession() {
    return { sessionId: 'session-1' }
  }

  async getCommand(cmdId: string, _opts?: { signal?: AbortSignal }) {
    this.getCommandCalls += 1
    const command = this.detachedCommands.get(cmdId)
    if (command === undefined) {
      throw Object.assign(new Error('command not found'), { response: { status: 404 } })
    }
    return {
      exitCode: command.exitCode,
      wait: (waitParams?: { signal?: AbortSignal }) => this.waitDetached(cmdId, waitParams),
    }
  }

  /** A command wait resolves the guest's true exit when it is known — the
   * `detachedExits` lever if set, otherwise the injected `detachedWait` —
   * records it into the observed state (after which the plain lookup reports
   * it, exactly as the provider does), and rejects when its signal aborts
   * unless the true outcome is already known. */
  private waitDetached(
    cmdId: string,
    waitParams?: { signal?: AbortSignal },
  ): Promise<{ exitCode: number }> {
    this.waitCalls += 1
    const known = this.detachedExits.get(cmdId)
    if (known !== undefined) {
      this.detachedCommands.set(cmdId, { exitCode: known })
      return Promise.resolve({ exitCode: known })
    }
    const signal = waitParams?.signal
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason ?? new Error('aborted'))
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal!.reason ?? new Error('aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.detachedWait(waitParams).then(
        (result) => {
          signal?.removeEventListener('abort', onAbort)
          this.detachedCommands.set(cmdId, { exitCode: result.exitCode })
          resolve(result)
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  async runCommand(params: Record<string, unknown>) {
    if (this.guardStopped && this.sessionStatus !== undefined && this.sessionStatus !== 'running') {
      throw new Error(`guest command ${String(params.cmd)} on a ${this.sessionStatus} session`)
    }
    if (this.autoResume && this.sessionStatus === 'stopped') this.sessionStatus = 'running'
    this.commands.push(params)
    const gate = this.commandGate?.(params)
    if (gate !== undefined) await gate
    const label = (params.args as string[] | undefined)?.[2]
    if (params.cmd === 'sh' && (params.args as string[])?.[0] === '-c') {
      const args = params.args as string[]
      if (label === 'probe') {
        this.probes += 1
        const output = this.probeOutput()
        return { exitCode: 0, stdout: async () => output, stderr: async () => '' }
      }
      if (label === 'resuming') {
        this.resumingAgeSeconds = 0
        return { exitCode: 0 }
      }
      if (label === 'resumed') {
        this.resumingAgeSeconds = undefined
        return { exitCode: 0 }
      }
      if (label === 'heartbeat') {
        this.hostHeartbeat = { step: args[3]!, ageSeconds: 0 }
        return { exitCode: 0 }
      }
      if (label === 'failed') {
        this.failedContent = `${args[4]}\n${args[5]}\n`
        return { exitCode: 0 }
      }
      if (label === 'replace') {
        this.failedContent = undefined
        this.resumingAgeSeconds = undefined
        this.provisioned = false
        this.hostHeartbeat = { step: 'checkout', ageSeconds: 0 }
        return { exitCode: 0 }
      }
      if (label === 'marker') {
        this.markerContent = args[3]!
        this.provisioned = true
        return { exitCode: 0 }
      }
    }
    if (
      params.cmd === 'sh' &&
      params.detached === true &&
      ((params.args as string[])?.[0] ?? '').endsWith('/tail.sh')
    ) {
      this.tailLaunches += 1
      const outcome = this.tailOutcome
      if (outcome === 'running') this.tailRunning = true
      else if (outcome === 'complete') {
        this.markerContent = this.writtenMarker()
        this.provisioned = true
      } else this.failedContent = `${outcome.failAt}\n`
    }
    if (params.cmd === 'git' && this.gitResponder !== undefined) {
      const answer = this.gitResponder(params.args as string[])
      if (answer !== undefined)
        return {
          exitCode: answer.exitCode,
          stdout: async () => answer.stdout ?? '',
          stderr: async () => answer.stderr ?? '',
        }
    }
    if (this.failCommand?.(params))
      return {
        exitCode: 1,
        stdout: async () => this.failureStdout,
        stderr: async () => this.failureStderr,
      }
    if (params.cmd === VERCEL_BUN_EXECUTABLE && (params.args as string[])?.[0] === '--version') {
      const version = this.bunVersion
      if (version === undefined) return { exitCode: 1 }
      return { exitCode: 0, stdout: async () => `${version}\n` }
    }
    if (params.cmd === 'npm' && (params.args as string[])?.[0] === 'install') {
      const requested = (params.args as string[]).find((arg) => arg.startsWith('bun@'))
      if (requested !== undefined)
        this.bunVersion = this.bunInstallVersion ?? requested.slice('bun@'.length)
    }
    if (params.cmd === 'cat') {
      const content = this.markerReadback ?? this.distributionVersion
      if ((params.args as string[])?.[0] === VERCEL_DISTRIBUTION_VERSION_MARKER) {
        if (content === undefined) return { exitCode: 1 }
        return { exitCode: 0, stdout: async () => content }
      }
    }
    if (
      params.cmd === 'sh' &&
      (params.args as string[])?.[1] === 'printf %s "$1" > "$2"' &&
      (params.args as string[])?.[4] === VERCEL_DISTRIBUTION_VERSION_MARKER
    ) {
      this.distributionVersion = (params.args as string[])![3] as string
      return { exitCode: 0 }
    }
    if (params.cmd === 'git' && (params.args as string[])?.[0] === 'checkout') {
      const args = params.args as string[]
      if (args[1] === '-B') this.head = this.checkoutLands ?? args[3]
    }
    if (
      params.cmd === 'git' &&
      (params.args as string[])?.[0] === 'rev-parse' &&
      (params.args as string[])?.[1] === 'HEAD^{commit}'
    ) {
      const head = this.head
      if (head === undefined) return { exitCode: 128, stderr: async () => 'no checkout' }
      return { exitCode: 0, stdout: async () => `${head}\n${this.branchHead ?? head}\n` }
    }
    if (params.cmd === 'test' && (params.args as string[])?.[1] === `${VERCEL_WORKSPACE_PATH}/.git`)
      return { exitCode: (this.checkout ?? this.provisioned) ? 0 : 1 }
    if (params.cmd === 'test') return { exitCode: this.provisioned ? 0 : 1 }
    if (params.cmd === this.failSetupCommand) return { exitCode: 1 }
    if (params.cmd === 'touch') this.provisioned = true
    if (params.detached === true) {
      const cmdId = `cmd-${this.commands.length}`
      this.detachedCommands.set(cmdId, { exitCode: null })
      // A `base64` read returns the file lever's bytes through the string
      // channel with GNU-style wrapping, exactly as the real guest would.
      const content = this.fileContent
      return {
        exitCode: null,
        cmdId,
        ...(params.cmd === 'base64'
          ? {
              stdout: async () =>
                Buffer.from(content ?? new Uint8Array())
                  .toString('base64')
                  .replace(/(.{76})/g, '$1\n'),
            }
          : {}),
        wait: (waitParams?: { signal?: AbortSignal }) => this.waitDetached(cmdId, waitParams),
        kill: async (_signal?: 'SIGTERM' | 'SIGKILL', opts?: { abortSignal?: AbortSignal }) => {
          this.killSignals.push(opts?.abortSignal)
        },
      }
    }
    return {
      exitCode:
        params.cmd === 'git' && (params.args as string[])?.includes('--unset-all')
          ? 5
          : this.failPush && (params.args as string[])?.includes('push')
            ? 1
            : 0,
    }
  }
  async writeFiles(files: Array<{ path: string; content: Uint8Array }>) {
    this.writes.push(...files)
  }
  stopTimeouts = 0
  async stop() {
    this.stops += 1
    if (this.stopTimeouts > 0) {
      this.stopTimeouts -= 1
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    }
    if (this.stopFailures > 0) {
      this.stopFailures -= 1
      throw new Error('sandbox stop failed')
    }
    this.snapshots.push({
      id: `snap-${this.stops}`,
      sourceSessionId: 'session-1',
      status: 'created',
    })
  }
  async delete() {
    this.deletes += 1
    if (this.deleteFailure !== undefined) throw this.deleteFailure
  }
  async update(
    params: { networkPolicy?: NetworkPolicy; timeout?: number },
    opts?: { signal?: AbortSignal },
  ) {
    if (params.timeout !== undefined) this.timeoutUpdates.push(params.timeout)
    this.updateAtCommand.push(this.commands.length)
    if (params.networkPolicy === undefined) return
    this.policies.push(params.networkPolicy)
    this.policySignals.push(opts?.signal)
    const isPublicationPolicy = JSON.stringify(params.networkPolicy).includes('git-receive-pack')
    if (this.failRestore && !isPublicationPolicy) throw new Error('restore failed')
  }
}

function runtimeReferenceFixtures() {
  return [
    {
      runtime: 'pi',
      references: ['role "implement" primary'],
      models: [],
      usesRuntimeDefaultModel: true,
    },
    {
      runtime: 'plugin',
      references: ['role "plan" alternate[0]'],
      models: [],
      usesRuntimeDefaultModel: true,
    },
  ]
}

function harness(
  options: {
    accounts?: () => import('../../config/accounts').Accounts
    accountEnv?: Record<string, string | undefined>
    /** Extra forwarded `environmentVariables` names. */
    forwarded?: string[]
    publishedSha?: string | null | (() => string | null)
    /** The target branch head `ls-remote refs/heads/main` reports; SHA by default. */
    mainSha?: string | (() => string)
    existingSha?: string | null
    provisionRuntimes?: boolean
    runtimeReferences?: () => ReturnType<typeof runtimeReferenceFixtures>
    provisioning?: Array<{ name: string; command: string }>
    /** The session cwd the fake reports; undefined models an SDK without one. */
    cwd?: string
    /** Overrides the facade's get; e.g. to model an unreachable provider. */
    facadeGet?: () => Promise<VercelSandboxHandle | null>
    /** The archive fetch rejects after its first success (models an origin-mode
     * release fetch failing during a reuse-path refresh). */
    failArchiveAfterFirst?: boolean
    /** Forces the guest's version-marker readback to return this value. */
    markerReadback?: string
    /** Optional snapshot-expiry bound threaded to creation. */
    snapshotExpirationSeconds?: number
    /** Operator-sandbox options threaded to the provider constructor. */
    setupCommand?: string
    sandboxEnvironmentVariables?: readonly string[]
    sandboxIdleMinutes?: number
    /** Construct the provider WITHOUT the `distributionIdentity` seam, so
     * `identityStamp()`'s default path — `distributionStampFor(archiveBytes())`
     * over the injected `packageArchive` — executes and the provider's default
     * identity resolution is pinned at the wiring site under test. The seam
     * lever and the returned `distributionIdentity` getter/setter stay (they
     * are simply inert in this mode). */
    defaultIdentityStamp?: boolean
    /** Host-side fallback after a refused guest archive push. */
    refusedArchive?: (ref: string, sha: string) => Promise<void>
    /** The deployment-fallback egress read credential. */
    egressReadCredential?: { username: string; password: string }
    /** A configured private-clone credential pair. */
    gitCredentialEnv?: { username: string; password: string }
    /** Overrides the store's credential delegation; e.g. to record targets. */
    delegateCredential?: (
      storeRef: string,
      token: string | undefined,
      target: DelegateCredentialTarget,
    ) => Promise<string>
  } = {},
) {
  const sandbox = new FakeSandbox()
  sandbox.cwd = options.cwd
  if (options.markerReadback !== undefined) sandbox.markerReadback = options.markerReadback
  let archiveFetches = 0
  let buildBranchLookups = 0
  let createInput: Record<string, unknown> | undefined
  let created = false
  let creates = 0
  /** Deletes before the latest create: a recreated environment is live. */
  let deletesAtCreate = 0
  let createFailure: Error | undefined
  /** The identity stamp the provider's seam currently resolves; mutable so a
   * test can model a dispatcher upgrade after provisioning. */
  const identityState = { current: '1.2.3' }
  /** Snapshot rows keyed by the exact environment name the purge uses. */
  const snapshotLists = new Map<string, VercelSnapshotInfo[]>()
  const facade: VercelSandboxFacade = {
    deleteByName: async () => {
      await sandbox.delete()
      return 'confirmed'
    },
    get:
      options.facadeGet ??
      (async () =>
        created && (sandbox.deletes === deletesAtCreate || sandbox.remainAfterDelete)
          ? sandbox
          : null),
    create: async (input) => {
      if (createFailure !== undefined) throw createFailure
      if (sandbox.deletes !== deletesAtCreate) sandbox.resetGuest()
      deletesAtCreate = sandbox.deletes
      created = true
      creates += 1
      createInput = input
      sandbox.head = (input.source as { revision?: string } | undefined)?.revision
      snapshotLists.set(input.name, sandbox.snapshots)
      return sandbox
    },
    listSnapshots: async (name) => [...(snapshotLists.get(name) ?? [])],
    deleteSnapshot: async (id) => {
      for (const list of snapshotLists.values()) {
        const index = list.findIndex((snapshot) => snapshot.id === id)
        if (index !== -1) {
          list.splice(index, 1)
          return
        }
      }
      throw new Error(`snapshot ${id} not found`)
    },
  }
  const exec: Exec = async (cmd) => {
    if (cmd.includes('get-url'))
      return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
    if (cmd.includes('ls-remote')) {
      const ref = cmd.at(-1)
      const buildBranch = ref === 'refs/heads/ab/remote-build'
      if (buildBranch) buildBranchLookups += 1
      const sha =
        ref === 'refs/heads/main'
          ? options.mainSha === undefined
            ? SHA
            : typeof options.mainSha === 'function'
              ? options.mainSha()
              : options.mainSha
          : buildBranch && buildBranchLookups === 1
            ? (options.existingSha ?? null)
            : buildBranch
              ? options.publishedSha === undefined
                ? SHA
                : typeof options.publishedSha === 'function'
                  ? options.publishedSha()
                  : options.publishedSha
              : null
      return {
        stdout: sha === null ? '' : `${sha}\t${ref}\n`,
        stderr: '',
        exitCode: 0,
      }
    }
    throw new Error(`unexpected host command: ${cmd.join(' ')}`)
  }
  const makeProvider = () =>
    scopedProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        ...(options.snapshotExpirationSeconds === undefined
          ? {}
          : { snapshotExpirationSeconds: options.snapshotExpirationSeconds }),
        failoverRegions: [],
        environmentVariables: ['ANTHROPIC_API_KEY', 'AB_TOKEN', ...(options.forwarded ?? [])],
        provisioning: options.provisioning ?? [],
        ...(options.gitCredentialEnv !== undefined
          ? {
              gitUsernameEnv: options.gitCredentialEnv.username,
              gitPasswordEnv: options.gitCredentialEnv.password,
            }
          : {}),
        ...(options.provisionRuntimes
          ? {
              runtimeProvisioning: {
                plugin: { install: 'install-plugin@abc123', preflight: 'plugin --version 1.2.3' },
                pi: { install: 'install-pi@0.84.4', preflight: 'pi --version 0.84.4' },
              },
            }
          : {}),
      },
      accounts: options.accounts,
      env: options.accountEnv ?? {
        ANTHROPIC_API_KEY: 'runtime-secret',
        AB_TOKEN: 'scoped-store-token',
        GITHUB_TOKEN: 'forge-secret',
        VERCEL_TOKEN: 'provider-secret',
        UNDECLARED_SECRET: 'never-copy',
      },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      delegateCredential: options.delegateCredential ?? (async () => 'delegated-store-token'),
      repo: '/repo',
      facade,
      exec,
      packageArchive: async () => {
        archiveFetches += 1
        if (options.failArchiveAfterFirst === true && archiveFetches > 1) {
          throw new Error('archive fetch failed')
        }
        return new Uint8Array([1, 2, 3])
      },
      // Seam-less mode omits the seam entirely (the point of
      // `defaultIdentityStamp`): the provider falls through to its default
      // `distributionStampFor(archiveBytes())` resolution.
      ...(options.defaultIdentityStamp
        ? {}
        : { distributionIdentity: async () => identityState.current }),
      // Bounded observation waits resolve in milliseconds, never the 5 s default.
      observeWaitMs: 25,
      ...(options.setupCommand !== undefined ? { setupCommand: options.setupCommand } : {}),
      ...(options.sandboxEnvironmentVariables !== undefined
        ? { sandboxEnvironmentVariables: options.sandboxEnvironmentVariables }
        : {}),
      ...(options.sandboxIdleMinutes !== undefined
        ? { sandboxIdleMinutes: options.sandboxIdleMinutes }
        : {}),
      runtimeReferences:
        options.runtimeReferences ?? (options.provisionRuntimes ? runtimeReferenceFixtures() : []),
      ...(options.refusedArchive !== undefined ? { refusedArchive: options.refusedArchive } : {}),
      ...(options.egressReadCredential !== undefined
        ? { egressReadCredential: options.egressReadCredential }
        : {}),
    })
  const provider = makeProvider()
  return {
    restart: makeProvider,
    provider,
    sandbox,
    facade,
    get createInput() {
      return createInput
    },
    get creates() {
      return creates
    },
    /** Make the next creates reject (a provider failure before any sandbox
     * exists). */
    set createFailure(error: Error | undefined) {
      createFailure = error
    },
    /** Model a concurrent instance's environment: `get` resolves it while
     * this instance's create fails. */
    adoptExisting() {
      created = true
      deletesAtCreate = sandbox.deletes
    },
    /** The seam's current identity stamp; assign to model a dispatcher
     * upgrade between provider calls. */
    get distributionIdentity() {
      return identityState.current
    },
    set distributionIdentity(value: string) {
      identityState.current = value
    },
  }
}

describe('VercelSandboxProvider', () => {
  test('the packed distribution carries only the files set, no tests, and never the web app', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-package-members-'))
    const archivePath = join(tmp, 'autobuild.tgz')
    try {
      await writeFile(archivePath, await packageAutobuildDistribution())
      const listing = await spawnExec(['tar', '-tzf', archivePath], { cwd: tmp })
      expect(listing).toMatchObject({ exitCode: 0, stderr: '' })
      const members = listing.stdout.split('\n').filter((entry) => entry.length > 0)
      // The root `files` array excludes test files with a negated glob; the
      // packer stages the positive entries and `bun pm pack` applies the
      // negation from the staged manifest.
      expect(members.some((entry) => entry.endsWith('.test.ts'))).toBe(false)

      // The operator web app lives in the hosted store service package
      // (AUT-409). The root `files` list has never carried it; pin the
      // absence so a future files edit cannot silently ship the web app in
      // the CLI tarball.
      const forbidden = [
        /^package\/app\//,
        /^package\/server\.ts$/,
        /^package\/next\.config/,
        /^package\/next-env\.d\.ts$/,
        /^package\/vercel\.json$/,
      ]
      for (const pattern of forbidden) {
        expect(members.filter((member) => pattern.test(member))).toEqual([])
      }

      // Every member stays inside the root manifest's positive `files` set
      // (directories contribute their whole subtree) plus the manifest itself.
      const manifest = JSON.parse(
        await readFile(join(distributionRoot(), 'package.json'), 'utf8'),
      ) as { files: string[] }
      const positive = manifest.files.filter((entry) => !entry.startsWith('!'))
      const covered = (member: string) =>
        member === 'package/package.json' ||
        positive.some(
          (entry) => member === `package/${entry}` || member.startsWith(`package/${entry}/`),
        )
      expect(members.filter((member) => !covered(member))).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('classifies the real SDK not-found and stale-snapshot response shapes only', () => {
    expect(isMissingVercelSandbox({ response: { status: 404 } })).toBe(true)
    expect(
      isMissingVercelSandbox({
        response: { status: 410 },
        json: { error: { code: 'snapshot_not_found' } },
      }),
    ).toBe(true)
    expect(
      isUnavailableVercelSnapshot({
        response: { status: 410 },
        json: { error: { code: 'snapshot_not_found' } },
      }),
    ).toBe(true)
    expect(isMissingVercelSandbox({ response: { status: 410 } })).toBe(false)
    expect(isMissingVercelSandbox({ code: 'not_found' })).toBe(false)
  })

  test('provisions from an exact authoritative revision and returns a remote-only location', async () => {
    const h = harness()
    const result = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(result.path).toBe(VERCEL_WORKSPACE_PATH)
    expect(result.localPath).toBeUndefined()
    expect(result.base).toEqual({ source: 'remote', sha: SHA })
    expect((h.createInput!.source as { revision: string }).revision).toBe(SHA)
    expect(h.createInput!.timeout).toBe(2_700_000)
    expect(h.sandbox.commands).toContainEqual(
      expect.objectContaining({
        cmd: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'],
        cwd: VERCEL_WORKSPACE_PATH,
      }),
    )
    expect(JSON.stringify(h.sandbox.commands)).not.toContain('forge-secret')

    const npmInstall = h.sandbox.commands.findIndex((command) => command.cmd === 'npm')
    const verification = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === '--version',
    )
    const distributionInstall = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === 'install',
    )
    const marker = h.sandbox.commands.findIndex((command) => command.cmd === 'touch')
    expect(h.sandbox.commands[npmInstall]).toEqual({
      cmd: 'npm',
      args: ['install', '--prefix', VERCEL_BUN_PREFIX, '--no-save', `bun@${VERCEL_BUN_VERSION}`],
    })
    expect(npmInstall).toBeGreaterThan(-1)
    expect(verification).toBeGreaterThan(npmInstall)
    expect(distributionInstall).toBeGreaterThan(verification)
    expect(marker).toBeGreaterThan(distributionInstall)
    const repositoryBootstrap = h.sandbox.commands.find(
      (command) => command.cmd === 'sh' && command.cwd === VERCEL_WORKSPACE_PATH,
    )
    expect(repositoryBootstrap).toBeDefined()
    expect((repositoryBootstrap!.args as string[])[1]).toContain(
      `${VERCEL_BUN_EXECUTABLE} install --frozen-lockfile`,
    )
  })

  test('runs named provisioning serially as root between Bun verification and bootstrap', async () => {
    const steps = [
      { name: 'packages', command: 'apt-get update && apt-get install -y chromium' },
      { name: 'browser smoke', command: './scripts/browser-smoke.sh' },
    ]
    const h = harness({ provisioning: steps })
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    const system = h.sandbox.commands.filter(
      (command) => command.cmd === 'sh' && command.sudo === true,
    )
    expect(system).toEqual(
      steps.map((step) => ({
        cmd: 'sh',
        args: ['-c', step.command],
        cwd: VERCEL_WORKSPACE_PATH,
        sudo: true,
      })),
    )
    const verification = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === '--version',
    )
    const firstSystem = h.sandbox.commands.indexOf(system[0]!)
    const distribution = h.sandbox.commands.findIndex(
      (command) => command.cmd === 'mkdir' && command.cwd !== VERCEL_WORKSPACE_PATH,
    )
    expect(firstSystem).toBeGreaterThan(verification)
    expect(distribution).toBeGreaterThan(firstSystem)
  })

  test('reuses a completed sandbox without rerunning declared provisioning', async () => {
    const h = harness({
      provisioning: [{ name: 'browser packages', command: 'install browser packages' }],
    })
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const commandCount = h.sandbox.commands.length
    const provisioningCount = h.sandbox.commands.filter(
      (command) => command.cmd === 'sh' && command.sudo === true,
    ).length

    const reused = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect(reused.ref).toBe(first.ref)
    expect(h.creates).toBe(1)
    expect(h.sandbox.writes).toHaveLength(1)
    // The matching version marker is read and nothing else runs: no archive
    // fetch, no reinstall, no declared provisioning.
    expect(h.sandbox.commands.slice(commandCount)).toEqual([
      { cmd: 'test', args: ['-f', VERCEL_PROVISIONED_MARKER] },
      {
        cmd: 'git',
        args: ['rev-parse', 'HEAD^{commit}', 'refs/heads/ab/remote-build^{commit}'],
        cwd: VERCEL_WORKSPACE_PATH,
        signal: expect.any(AbortSignal),
      },
      {
        cmd: 'cat',
        args: [VERCEL_DISTRIBUTION_VERSION_MARKER],
        signal: expect.any(AbortSignal),
      },
    ])
    expect(h.sandbox.distributionVersion).toBe('1.2.3')
    expect(
      h.sandbox.commands.filter((command) => command.cmd === 'sh' && command.sudo === true),
    ).toHaveLength(provisioningCount)

    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-reused',
      workspaceRef: reused.ref,
    })
    expect(await execution.completion).toEqual({ exitCode: 0 })
    await h.provider.release(reused)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('a retried provisioning that reuses a completed sandbox records its checked-out commit, not a target that moved (AUT-1252)', async () => {
    const before = 'a'.repeat(40)
    const after = 'b'.repeat(40)
    let current = before
    const h = harness({ mainSha: () => current, publishedSha: null })
    const opts = { repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }
    // The first attempt completes the sandbox and then fails before any
    // provisioning fact is recorded; its result is simply discarded.
    await h.provider.provision(opts)
    expect(h.sandbox.head).toBe(before)
    current = after
    const commandsBefore = h.sandbox.commands.length
    const stopsBefore = h.sandbox.stops

    const reused = await h.provider.provision(opts)

    expect(h.creates).toBe(1)
    expect(reused.base).toEqual({ source: 'remote', sha: before })
    expect(reused.base.sha).toBe(h.sandbox.head!)
    const since = h.sandbox.commands.slice(commandsBefore)
    expect(
      since.findIndex(
        (command) => command.cmd === 'git' && (command.args as string[])[0] === 'rev-parse',
      ),
    ).toBe(1)
    expect(h.sandbox.stops).toBe(stopsBefore + 1)
  })

  test('fresh provisioning records the commit it checked out even when the target moves after it is read', async () => {
    const before = 'a'.repeat(40)
    const after = 'b'.repeat(40)
    let reads = 0
    const h = harness({ mainSha: () => (++reads === 1 ? before : after) })

    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect((h.createInput?.source as { revision?: string } | undefined)?.revision).toBe(before)
    expect(workspace.base).toEqual({ source: 'remote', sha: before })
    expect(h.sandbox.head).toBe(before)
  })

  test('a reused sandbox whose HEAD and build branch disagree is cleanup-required', async () => {
    const h = harness({ publishedSha: null })
    const opts = { repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }
    await h.provider.provision(opts)
    h.sandbox.branchHead = 'c'.repeat(40)

    const reused = h.provider.provision(opts)

    await expect(reused).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
    await expect(reused).rejects.toThrow('disagrees with ab/remote-build')
  })

  test('fresh checkout that lands off the selected base fails closed', async () => {
    const h = harness()
    h.sandbox.checkoutLands = 'c'.repeat(40)

    const provisioned = h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    await expect(provisioned).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
  })

  test.each([
    // The resumed guest predates the current distribution (e.g. legacy 0.6.0
    // guest vs an upgraded dispatcher's 1.2.3).
    ['an older marker version', '0.6.0'],
    // A guest provisioned before the marker existed.
    ['no version marker (legacy)', undefined],
  ])('reinstalls the distribution on a reused sandbox with %s', async (_name, staleMarker) => {
    const h = harness()
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.distributionVersion = staleMarker
    const commandsBefore = h.sandbox.commands.length
    const writesBefore = h.sandbox.writes.length

    const reused = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect(reused.ref).toBe(first.ref)
    expect(h.creates).toBe(1)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.writes).toHaveLength(writesBefore + 1)
    const refreshed = h.sandbox.commands.slice(commandsBefore)
    expect(refreshed.map((command) => command.cmd)).toEqual([
      'test',
      'git',
      'cat',
      VERCEL_BUN_EXECUTABLE,
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
    // No declared provisioning and no runtime work re-ran for the refresh.
    expect(refreshed.some((command) => command.sudo === true)).toBe(false)
  })

  test('a failed distribution refresh retains the reused sandbox and launches no execution', async () => {
    const h = harness({ failArchiveAfterFirst: true })
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.distributionVersion = '0.6.0'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(/archive fetch failed/)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)

    // A subsequent start also refuses the failed refresh without deleting it.
    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-refresh-failed',
        workspaceRef: first.ref,
      }),
    ).rejects.toThrow(/requires dispatcher-authorized cleanup/)
  })

  test('a fresh-provision marker readback mismatch retains the sandbox', async () => {
    const mismatch = harness({ markerReadback: 'corrupted' })
    await expect(
      mismatch.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      }),
    ).rejects.toThrow(
      /distribution identity marker readback mismatch.*wrote "1\.2\.3" but read "corrupted"/s,
    )
    expect(mismatch.sandbox.deletes).toBe(0)
    expect(mismatch.sandbox.provisioned).toBe(false)
    expect(mismatch.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('without the identity seam provisioning records the default stamp and a restart refreshes a bare-version marker', async () => {
    // obs_8266d6a3 pin (provision and start / build-restart sites): every
    // sibling test injects the `distributionIdentity` seam, so the provider's
    // DEFAULT identity resolution — `identityStamp()` falling through to
    // `distributionStampFor(archiveBytes())` — never runs for them. Wiring the
    // default to bare `readDistributionIdentity()` (dropping the protocol and
    // digest terms) writes the bare version at provision and, at restart,
    // matches the bare-version marker so no refresh runs.
    const h = harness({ defaultIdentityStamp: true })
    const provisioned = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const defaultStamp = await distributionStampFor(new Uint8Array([1, 2, 3]))
    const marker = h.sandbox.distributionVersion
    expect(marker).toBe(defaultStamp)
    expect(marker).not.toBe(await readDistributionIdentity())
    expect(marker).toMatch(
      new RegExp(`\\+protocol${REMOTE_STORE_PROTOCOL_VERSION}\\+sha256-[0-9a-f]{64}$`),
    )
    // Model the legacy bare-version guest marker (pre-AUT-521 shape).
    h.sandbox.distributionVersion = await readDistributionIdentity()
    const commandsBefore = h.sandbox.commands.length

    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-seamless-restart',
      workspaceRef: provisioned.ref,
    })
    expect(await execution.completion).toEqual({ exitCode: 0 })

    const restart = h.sandbox.commands.slice(commandsBefore)
    const runner = restart.findIndex((command) => command.detached === true)
    expect(runner).toBeGreaterThan(0)
    expect(restart.slice(0, runner).map((command) => command.cmd)).toEqual([
      VERCEL_BUN_EXECUTABLE,
      'cat',
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(h.sandbox.distributionVersion).toBe(defaultStamp)
  })

  test.each([
    {
      // AUT-521, the 2026-09-24 incident: a protocol bump without a package
      // version bump left every bare-version guest marker matching.
      name: 'a protocol-only bump',
      identity: '1.2.3+protocol3',
    },
    { name: 'a version-only bump', identity: '2.0.0+protocol3' },
    {
      // obs_6981ba1d: a PURE version-only change, the provisioned marker
      // already carrying the current protocol (AUT-540).
      name: 'a version-only bump on a current-protocol marker',
      provisionedIdentity: '1.2.3+protocol3',
      identity: '2.0.0+protocol3',
    },
    {
      // AUT-600, the 2026-09-24 13:46 UTC incident: a code-only deploy with
      // version and protocol unchanged left every pre-digest marker matching.
      name: 'a code-only deploy (same version and protocol, new archive digest)',
      staleMarker: '1.2.3+protocol3',
      identity: `1.2.3+protocol3+sha256-${'a'.repeat(64)}`,
    },
  ])(
    'restart after $name reinstalls the distribution before the runner starts',
    async (row: {
      name: string
      provisionedIdentity?: string
      staleMarker?: string
      identity: string
    }) => {
      const h = harness()
      if (row.provisionedIdentity !== undefined) h.distributionIdentity = row.provisionedIdentity
      const provisioned = await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
      if (row.provisionedIdentity !== undefined)
        expect(h.sandbox.distributionVersion).toBe(row.provisionedIdentity)
      if (row.staleMarker !== undefined) h.sandbox.distributionVersion = row.staleMarker
      h.distributionIdentity = row.identity
      const commandsBefore = h.sandbox.commands.length
      const writesBefore = h.sandbox.writes.length

      const execution = await h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-stale-marker',
        workspaceRef: provisioned.ref,
      })
      expect(await execution.completion).toEqual({ exitCode: 0 })

      const restart = h.sandbox.commands.slice(commandsBefore)
      const runner = restart.findIndex((command) => command.detached === true)
      expect(runner).toBeGreaterThan(0)
      // The refresh sequence strictly precedes the detached runner launch, with
      // Bun's pin check before the reinstall that runs with it.
      expect(restart.slice(0, runner).map((command) => command.cmd)).toEqual([
        VERCEL_BUN_EXECUTABLE,
        'cat',
        'mkdir',
        'tar',
        VERCEL_BUN_EXECUTABLE,
        'sh',
        'cat',
      ])
      expect((restart[0] as { args?: string[] }).args).toEqual(['--version'])
      expect(h.sandbox.distributionVersion).toBe(row.identity)
      // Exactly one new write — the archive into /tmp — never the workspace.
      expect(h.sandbox.writes).toHaveLength(writesBefore + 1)
      expect(h.sandbox.writes.at(-1)!.path).toBe('/tmp/autobuild.tgz')
      // No git command and no command with or naming the workspace before the
      // runner: the checkout and its unpushed commits are untouched.
      for (const command of restart.slice(0, runner)) {
        expect(command.cmd).not.toBe('git')
        expect(command.cwd).not.toBe(VERCEL_WORKSPACE_PATH)
        expect(JSON.stringify(command)).not.toContain(VERCEL_WORKSPACE_PATH)
      }
    },
  )

  test.each([
    { name: 'an unchanged bare identity stamp' },
    {
      // An identical archive must not reinstall: the guest marker carries the
      // full current stamp, digest included.
      name: 'a marker equal to the full digest stamp',
      stamp: `1.2.3+protocol3+sha256-${'b'.repeat(64)}`,
    },
  ])('restart with $name reinstalls nothing', async (row: { name: string; stamp?: string }) => {
    const h = harness()
    const provisioned = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    if (row.stamp !== undefined) {
      h.sandbox.distributionVersion = row.stamp
      h.distributionIdentity = row.stamp
    }
    const markerBefore = h.sandbox.distributionVersion
    const commandsBefore = h.sandbox.commands.length
    const writesBefore = h.sandbox.writes.length

    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-unchanged',
      workspaceRef: provisioned.ref,
    })
    expect(await execution.completion).toEqual({ exitCode: 0 })

    const restart = h.sandbox.commands.slice(commandsBefore)
    const runner = restart.findIndex((command) => command.detached === true)
    expect(runner).toBeGreaterThan(0)
    // Bun's pin check, then one marker read (the comparison itself) — no
    // archive fetch, no writes, no tar, no reinstall.
    expect(restart.slice(0, runner).map((command) => command.cmd)).toEqual([
      VERCEL_BUN_EXECUTABLE,
      'cat',
    ])
    expect(h.sandbox.writes).toHaveLength(writesBefore)
    expect(h.sandbox.distributionVersion).toBe(markerBefore)
  })

  test('retains provisioning output and remediation while deleting an unready sandbox', async () => {
    const h = harness({
      provisioning: [
        { name: 'packages', command: 'install browser' },
        { name: 'browser smoke', command: 'run browser smoke' },
      ],
    })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[] | undefined)?.[1] === 'run browser smoke'
    h.sandbox.failureStdout = 'server started\n'
    h.sandbox.failureStderr = 'chromium missing\n'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(
      /browser smoke[\s\S]*exit status: 1[\s\S]*server started[\s\S]*chromium missing[\s\S]*ab init --validate/,
    )
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'mkdir')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('moves the checkout from the session cwd the image actually uses', async () => {
    const universal = harness({ cwd: '/vercel' })
    await universal.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(universal.sandbox.commands[0]).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        expect.stringContaining('mkdir -p'),
        'relocate',
        '/vercel/app',
        VERCEL_WORKSPACE_PATH,
      ],
    })

    const legacy = harness()
    await legacy.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(legacy.sandbox.commands[0]).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        expect.stringContaining('mv "$1" "$2"'),
        'relocate',
        '/vercel/sandbox/app',
        VERCEL_WORKSPACE_PATH,
      ],
    })

    expect(sourceCheckoutPath({ cwd: '/vercel/sandbox/' } as VercelSandboxHandle, 'app')).toBe(
      '/vercel/sandbox/app',
    )
    expect(sourceCheckoutPath({ cwd: '  ' } as VercelSandboxHandle, 'app')).toBe(
      '/vercel/sandbox/app',
    )
  })

  test('provision delegates the build-runner credential for the build slug, for leaf and node branches', async () => {
    const recorder = () => {
      const targets: DelegateCredentialTarget[] = []
      return {
        targets,
        delegate: async (
          _storeRef: string,
          _token: string | undefined,
          target: DelegateCredentialTarget,
        ) => {
          targets.push(target)
          return 'delegated-store-token'
        },
      }
    }
    const leafTargets = recorder()
    const leaf = harness({ delegateCredential: leafTargets.delegate })
    await leaf.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })
    expect(leafTargets.targets).toEqual([{ kind: 'build-runner', id: 'remote-build' }])

    // A node branch is `ab-node/<slug>`; the store only knows the build by its slug (#969).
    const nodeTargets = recorder()
    const node = harness({ delegateCredential: nodeTargets.delegate })
    await node.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab-node/remote-node',
    })
    expect(nodeTargets.targets).toEqual([{ kind: 'build-runner', id: 'remote-node' }])

    // Sandbox names are unchanged, so live leaf and node sandboxes are still reused.
    expect(leaf.createInput?.name).toBe('autobuild-remote-build-g0-e61874178a')
    expect(node.createInput?.name).toBe('autobuild-ab-node-remote-node-g0-05f6e15b57')
  })

  test('uses generation-scoped names and the supplied checkpoint when the branch is absent', async () => {
    const h = harness()
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
      revision: 'b'.repeat(40),
      generation: 2,
    })
    expect(h.createInput?.name).toMatch(/^autobuild-remote-build-g2-/)
    expect((h.createInput!.source as { revision: string }).revision).toBe('b'.repeat(40))
    expect(h.createInput?.signal).toBeInstanceOf(AbortSignal)
  })

  test('prefers the authoritative remote build head over an older supplied checkpoint', async () => {
    const remoteHead = 'c'.repeat(40)
    const h = harness({ existingSha: remoteHead })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
      revision: 'b'.repeat(40),
      generation: 3,
    })
    expect((h.createInput!.source as { revision: string }).revision).toBe(remoteHead)
    expect(workspace.base).toEqual({ source: 'existing', sha: remoteHead })
  })

  test('retains a partial setup as cleanup-required, and the next provisioning pass rematerializes cleanly', async () => {
    const first = new FakeSandbox()
    first.failSetupCommand = 'tar'
    const second = new FakeSandbox()
    let creates = 0
    const facade: VercelSandboxFacade = {
      get: async () => (creates === 1 && first.deletes === 0 ? first : null),
      create: async () => {
        creates += 1
        return creates === 1 ? first : second
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const exec: Exec = async (cmd) => {
      const ref = cmd.at(-1)
      if (cmd.includes('get-url'))
        return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
      return {
        stdout: ref === 'refs/heads/main' ? `${SHA}\t${ref}\n` : '',
        stderr: '',
        exitCode: 0,
      }
    }
    const provider = scopedProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: { GITHUB_TOKEN: 'forge-secret' },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      delegateCredential: async () => 'delegated-store-token',
      repo: '/repo',
      facade,
      exec,
      packageArchive: async () => new Uint8Array([1, 2, 3]),
    })

    const rejection = provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The setup diagnostics are retained and no destructive cleanup runs.
    await expect(rejection).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
    await expect(rejection).rejects.toThrow(/tar exited 1/)
    expect(first.deletes).toBe(0)
    expect(first.provisioned).toBe(false)
    // Recovery cleanup stops before deleting and confirming absence.
    expect(first.stops).toBe(0)
    await first.delete()

    const workspace = await provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.provider).toBe('vercel-sandbox')
    expect(creates).toBe(2)
    expect(second.provisioned).toBe(true)
    expect(second.stops).toBe(1)
    expect(second.commands.map((command) => command.cmd)).toEqual([
      'sh',
      'git',
      'git',
      'git',
      'git',
      'git',
      'git',
      'npm',
      VERCEL_BUN_EXECUTABLE,
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
      'sh',
      'touch',
    ])
  })

  test('reports Bun provisioning failure, deletes the partial sandbox, and never marks or launches it', async () => {
    const h = harness()
    h.sandbox.failCommand = (command) => command.cmd === 'npm'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(/could not provision Bun 1\.4\.4.*universal managed image/)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  describe('finishing a teardown-abandoned attempt', () => {
    const request = { repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }
    /** A fresh create's commands, then the same sandbox left marker-less as a
     * dispatcher teardown would leave it. */
    async function abandoned(h: ReturnType<typeof harness>) {
      await h.provider.provision(request)
      const fresh = h.sandbox.commands.splice(0)
      h.sandbox.provisioned = false
      h.sandbox.checkout = true
      h.sandbox.stops = 0
      return fresh
    }
    const fromCheckout = (commands: Array<Record<string, unknown>>) =>
      commands.slice(
        commands.findIndex(
          (command) => command.cmd === 'git' && (command.args as string[])[0] === 'checkout',
        ),
      )
    const isDiff = (command: Record<string, unknown>) =>
      command.cmd === 'git' && (command.args as string[])[0] === 'diff'

    test('quiesces, verifies, and finishes the same sandbox with the fresh-create sequence', async () => {
      const h = harness()
      const fresh = await abandoned(h)
      let firstGitAtStop: number | undefined
      const stop = h.sandbox.stop.bind(h.sandbox)
      h.sandbox.stop = async () => {
        firstGitAtStop ??= h.sandbox.commands.filter((command) => command.cmd === 'git').length
        await stop()
      }

      const workspace = await h.restart().provision({ ...request, adoptAbandoned: true })

      expect(h.creates).toBe(1)
      expect(firstGitAtStop).toBe(0)
      expect(workspace.ref).toBe(h.createInput?.name as string)
      expect(workspace.base.sha).toBe(SHA)
      expect(h.sandbox.provisioned).toBe(true)
      const finished = fromCheckout(h.sandbox.commands)
      expect(finished.filter((command) => !isDiff(command))).toEqual(fromCheckout(fresh))
      const touch = finished.findIndex((command) => command.cmd === 'touch')
      expect(finished.findIndex(isDiff)).toBeGreaterThan(-1)
      expect(finished.findIndex(isDiff)).toBeLessThan(touch)
    })

    test('reports cleanup-required and never marks a sandbox with no checkout', async () => {
      const h = harness()
      await abandoned(h)
      h.sandbox.checkout = false

      await expect(
        h.restart().provision({ ...request, adoptAbandoned: true }),
      ).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
      expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
      expect(h.sandbox.provisioned).toBe(false)
      expect(h.creates).toBe(1)
    })

    test('reports cleanup-required when the checkout carries tracked modifications', async () => {
      const h = harness()
      await abandoned(h)
      h.sandbox.failCommand = isDiff

      await expect(
        h.restart().provision({ ...request, adoptAbandoned: true }),
      ).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
      expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
      expect(h.sandbox.provisioned).toBe(false)
    })

    test('without adoption the same marker-less sandbox is still cleanup-required', async () => {
      const h = harness()
      await abandoned(h)

      await expect(h.restart().provision(request)).rejects.toBeInstanceOf(WorkspaceCleanupRequired)
      expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
      expect(h.sandbox.stops).toBe(0)
      // Neither deleted nor replaced: no second create, nothing provisioned.
      expect(h.sandbox.deletes).toBe(0)
      expect(h.creates).toBe(1)
      expect(h.sandbox.provisioned).toBe(false)
    })

    test('an absent sandbox is simply created under the same generation', async () => {
      const h = harness()
      const workspace = await h.provider.provision({ ...request, adoptAbandoned: true })
      expect(h.creates).toBe(1)
      expect(workspace.ref).toBe(h.createInput?.name as string)
      expect(h.sandbox.commands.some(isDiff)).toBe(false)
    })
  })

  test('declares its provisioning estimate, overridable as a test seam', () => {
    const base = {
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: {},
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      repo: '/repo',
      facade: harness().facade,
    }
    expect(scopedProvider(base).provisionEstimateMs).toBe(VERCEL_PROVISION_ESTIMATE_MS)
    expect(scopedProvider({ ...base, provisionEstimateMs: 1_000 }).provisionEstimateMs).toBe(1_000)
  })

  test('installs and preflights every referenced runtime before the marker and preflights again before launch', async () => {
    const h = harness({ provisionRuntimes: true })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const runtimeCommands = h.sandbox.commands.filter(
      (command) =>
        command.cmd === 'sh' &&
        [
          'install-plugin@abc123',
          'plugin --version 1.2.3',
          'install-pi@0.84.4',
          'pi --version 0.84.4',
        ].includes((command.args as string[])[1]!),
    )
    expect(runtimeCommands.map((command) => (command.args as string[])[1])).toEqual([
      'install-pi@0.84.4',
      'pi --version 0.84.4',
      'install-plugin@abc123',
      'plugin --version 1.2.3',
    ])
    expect(runtimeCommands.every((command) => command.cwd === VERCEL_WORKSPACE_PATH)).toBe(true)
    expect(
      runtimeCommands.every(
        (command) => (command.env as Record<string, string>).ANTHROPIC_API_KEY === 'runtime-secret',
      ),
    ).toBe(true)
    expect(JSON.stringify(runtimeCommands)).not.toContain('forge-secret')
    expect(JSON.stringify(runtimeCommands)).not.toContain('provider-secret')
    expect(JSON.stringify(runtimeCommands)).not.toContain('never-copy')
    const marker = h.sandbox.commands.findIndex((command) => command.cmd === 'touch')
    expect(marker).toBeGreaterThan(h.sandbox.commands.indexOf(runtimeCommands.at(-1)!))

    await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-runtime-preflight',
      workspaceRef: workspace.ref,
    })
    const commands = h.sandbox.commands
    const detached = commands.findIndex((command) => command.detached === true)
    expect((commands[detached - 2]!.args as string[])[1]).toBe('pi --version 0.84.4')
    expect((commands[detached - 1]!.args as string[])[1]).toBe('plugin --version 1.2.3')
  })

  test('runner preflight reads runtime references updated after provisioning', async () => {
    let references = runtimeReferenceFixtures().filter((group) => group.runtime === 'pi')
    const h = harness({
      provisionRuntimes: true,
      runtimeReferences: () => references,
    })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    references = runtimeReferenceFixtures().filter((group) => group.runtime === 'plugin')
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'plugin --version 1.2.3'

    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-hot-runtime-preflight',
        workspaceRef: workspace.ref,
      }),
    ).rejects.toThrow(/runtime "plugin" preflight failed.*role "plan" alternate\[0\]/)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('missing provisioning remediation round-trips exotic runtime names as TOML keys', async () => {
    const cases = [
      ['pi', 'pi'],
      ['plugin.runtime', '"plugin.runtime"'],
      ['plugin"runtime', '"plugin\\"runtime"'],
      ['plugin\\runtime', '"plugin\\\\runtime"'],
      ['plugin\u0001runtime', '"plugin\\u0001runtime"'],
      ['plugin\u007fruntime', '"plugin\\u007Fruntime"'],
      ['插件', '"\\u63D2\\u4EF6"'],
      ['plugin😀', '"plugin\\U0001F600"'],
    ] as const

    for (const [runtime, renderedKey] of cases) {
      // Direct construction deliberately bypasses schema cross-validation so this
      // defensive bootstrap branch remains covered without claiming production reachability.
      const h = harness({
        runtimeReferences: () => [
          {
            runtime,
            references: ['role "plan" primary'],
            models: [],
            usesRuntimeDefaultModel: true,
          },
        ],
      })
      let rejection: unknown
      try {
        await h.provider.provision({
          repo: '/repo',
          baseBranch: 'main',
          branch: 'ab/remote-build',
        })
      } catch (error) {
        rejection = error
      }
      expect(rejection).toBeInstanceOf(Error)
      const header = (rejection as Error).message.match(
        /add (\[workspace\.config\.runtimeProvisioning\..+?\]) with/,
      )?.[1]

      expect(header, `missing remediation header for ${JSON.stringify(runtime)}`).toBe(
        `[workspace.config.runtimeProvisioning.${renderedKey}]`,
      )
      const parsed = parseToml(header!) as {
        workspace: { config: { runtimeProvisioning: Record<string, unknown> } }
      }
      expect(Object.keys(parsed.workspace.config.runtimeProvisioning)).toEqual([runtime])
      expect(h.sandbox.provisioned).toBe(false)
      expect(h.sandbox.deletes).toBe(0)
      expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
      expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
    }
  })

  test('runtime failure redacts an allowlisted secret while preserving provisioning context', async () => {
    const h = harness({ provisionRuntimes: true })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'plugin --version 1.2.3'
    h.sandbox.failureStderr =
      'plugin registry denied credential runtime-secret; manifest unavailable'

    let rejection: unknown
    try {
      await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    const message = (rejection as Error).message
    const failedCommand = h.sandbox.commands.find((command) => h.sandbox.failCommand?.(command))
    expect(failedCommand).toBeDefined()
    expect((failedCommand!.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(message).not.toContain('runtime-secret')
    expect(message).toContain('[REDACTED]')
    expect(message).toContain('plugin registry denied credential')
    expect(message).toContain('manifest unavailable')
    expect(message).toContain('runtime "plugin" preflight failed')
    expect(message).toContain('role "plan" alternate[0]')
    expect(message).toContain('workspace.config.runtimeProvisioning.plugin.preflight')
    // The route and field are named in order on the failure's first line.
    expect(message).toMatch(
      /runtime "plugin" preflight failed.*role "plan" alternate\[0\].*runtimeProvisioning\.plugin\.preflight/,
    )
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('launches the environment-supervised child with only allowlisted and Store values', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const handle = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-1',
      workspaceRef: workspace.ref,
    })
    const launch = h.sandbox.commands.find((command) => command.detached === true)!
    expect(handle.identity).toEqual({
      provider: 'vercel-sandbox',
      workspaceRef: workspace.ref,
      environmentId: 'sandbox',
      sessionId: 'session-1',
      commandId: `cmd-${h.sandbox.commands.indexOf(launch) + 1}`,
    })
    expect(await handle.completion).toEqual({ exitCode: 0 })
    const env = launch.env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(env.AB_TOKEN).toBe('delegated-store-token')
    expect(JSON.stringify(h.sandbox.commands)).not.toContain('scoped-store-token')
    for (const file of h.sandbox.writes)
      expect(Buffer.from(file.content).toString()).not.toContain('scoped-store-token')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.VERCEL_TOKEN).toBeUndefined()
    expect(env.UNDECLARED_SECRET).toBeUndefined()
    // Credential-free guests refuse anonymous GitHub API requests.
    expect(env.AB_GITHUB_REQUIRE_CREDENTIAL).toBe('1')
    expect(JSON.parse(env.AB_BUILD_RUNNER_OPTIONS!).supervision).toEqual({ kind: 'environment' })
    expect(h.sandbox.policySignals).toHaveLength(1)
    expect(h.sandbox.policySignals[0]).toBeInstanceOf(AbortSignal)
    expect(launch).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-build-runner.ts`,
      ],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    const launchIndex = h.sandbox.commands.indexOf(launch)
    expect(
      h.sandbox.commands
        .slice(0, launchIndex)
        .findLast((command) => command.cmd === VERCEL_BUN_EXECUTABLE),
    ).toEqual({
      cmd: VERCEL_BUN_EXECUTABLE,
      args: ['--version'],
      signal: expect.any(AbortSignal),
    })
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('a forwarded variable cannot disable the guest credential requirement', async () => {
    const h = harness({
      forwarded: ['AB_GITHUB_REQUIRE_CREDENTIAL'],
      accountEnv: {
        ANTHROPIC_API_KEY: 'runtime-secret',
        AB_TOKEN: 'scoped-store-token',
        AB_GITHUB_REQUIRE_CREDENTIAL: '0',
      },
    })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const handle = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-1',
      workspaceRef: workspace.ref,
    })
    const launch = h.sandbox.commands.find((command) => command.detached === true)!
    expect((launch.env as Record<string, string>).AB_GITHUB_REQUIRE_CREDENTIAL).toBe('1')
    expect(await handle.completion).toEqual({ exitCode: 0 })
    await h.provider.release(workspace)
  })

  test('bounds the command kill acknowledgement during graceful stop', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-bounded-kill',
      workspaceRef: workspace.ref,
    })

    expect(await execution.stop()).toEqual({ outcome: 'confirmed' })
    expect(h.sandbox.killSignals).toHaveLength(1)
    expect(h.sandbox.killSignals[0]).toBeInstanceOf(AbortSignal)
  })

  test('release deletes a sandbox whose stop times out and still proves absence', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopTimeouts = 1
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('re-issues an interrupted wait long-poll until the detached runner exits', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    let waits = 0
    h.sandbox.detachedWait = async () => {
      waits += 1
      if (waits < 3) {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
      }
      return { exitCode: 0 }
    }
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-long-poll',
      workspaceRef: workspace.ref,
    })

    expect(await execution.completion).toEqual({ exitCode: 0 })
    expect(waits).toBe(3)
  })

  test('observes a recorded execution from provider state within two bounded round trips', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Hold the wait open so the detached command stays provably running.
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!
    expect(identity.commandId).toBeDefined()
    // The harness facade carries no session expiry: observation is unbounded.
    expect(h.sandbox.sessionExpiresAt).toBeUndefined()
    const waitsAtLaunch = h.sandbox.waitCalls

    // A null exit code from the lookup proves nothing: the observation issues
    // its bounded wait, which times out against a guest that never exits, and
    // only then concludes running.
    const started = Date.now()
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'running',
    })
    // One observation never approaches the tick's operation timeout (30 s).
    expect(Date.now() - started).toBeLessThan(1000)
    expect(h.sandbox.getCommandCalls).toBe(1)
    expect(h.sandbox.waitCalls).toBe(waitsAtLaunch + 1)

    // The next tick's observation repeats the bounded attempt unchanged.
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'running',
    })
    expect(h.sandbox.getCommandCalls).toBe(2)
    expect(h.sandbox.waitCalls).toBe(waitsAtLaunch + 2)

    // The guest exits while detached: the true outcome exists but no client
    // has waited, so the plain lookup still reports no exit code. A wait that
    // observes it is a proved end carrying that code.
    h.sandbox.detachedExits.set(identity.commandId!, 7)
    expect(h.sandbox.detachedCommands.get(identity.commandId!)).toEqual({ exitCode: null })
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'ended',
      exitCode: 7,
    })
    expect(h.sandbox.getCommandCalls).toBe(3)
    expect(h.sandbox.waitCalls).toBe(waitsAtLaunch + 3)

    // The resolved wait is recorded provider state: the lookup alone now
    // reports the exit, so a repeat observation needs no further wait.
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'ended',
      exitCode: 7,
    })
    expect(h.sandbox.getCommandCalls).toBe(4)
    expect(h.sandbox.waitCalls).toBe(waitsAtLaunch + 3)
  })

  test('observes lost executions: stopped session, a wait that finds the sandbox gone, a resumed session 404, and an absent sandbox', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe-lost',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!

    // A session that is no longer running proves the execution cannot be
    // observed, even before re-fetching the command.
    h.sandbox.sessionStatus = 'stopped'
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })
    expect(h.sandbox.getCommandCalls).toBe(0)
    h.sandbox.sessionStatus = 'running'

    // The environment vanishes between the command lookup and the bounded
    // wait: the wait rejects with the provider's not-found shape.
    h.sandbox.detachedWait = async () => {
      throw Object.assign(new Error('Status code 404 is not ok: sandbox not found'), {
        response: { status: 404 },
      })
    }
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })

    // A command the current (resumed) session no longer knows 404s: lost.
    h.sandbox.detachedCommands.delete(identity.commandId!)
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })

    // A sandbox the facade can no longer resolve at all is lost.
    await h.sandbox.delete()
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })
  })

  test('recovered guest exit settles only after whole-environment stop, retrying failed teardown', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'recovered',
      workspaceRef: workspace.ref,
    })
    await execution.detach()
    const identity = execution.identity!
    h.sandbox.detachedExits.set(identity.commandId!, 0)
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'remote-build', repo: 'repo' })
    await store.claimLease('remote-build', 'recovered', 60_000)
    const open = { ...identity, instance: 'recovered' }
    let publications = 0
    const deps = {
      store,
      execution: h.restart().buildExecution,
      settlePublication: async () => {
        publications += 1
      },
    }
    const stops = h.sandbox.stops
    h.sandbox.stopFailures = 1
    expect(await settleOpenExecution(deps, 'remote-build', open)).toBe('running')
    expect(h.sandbox.stops).toBe(stops + 1)
    expect(await store.getEvents('remote-build')).toEqual([])
    expect((await store.getBuild('remote-build'))?.lease?.holder).toBe('recovered')
    expect(publications).toBe(0)
    // A fresh supervisor has no in-memory launch handle; durable identity and
    // provider proof are sufficient, including retry after an ambiguous stop.
    expect(await settleOpenExecution(deps, 'remote-build', open)).toBe('settled')
    expect(h.sandbox.stops).toBe(stops + 2)
    expect((await store.getEvents('remote-build')).map((e) => e.type)).toEqual(['execution.ended'])
    expect((await store.getBuild('remote-build'))?.lease).toBeUndefined()
    expect(publications).toBe(1)
  })

  test('recovered observation never stops a newer sandbox session', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const stops = h.sandbox.stops
    h.sandbox.stopFailures = 1
    expect(
      await h.restart().buildExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: workspace.ref,
        sessionId: 'previous-session',
        commandId: 'previous-command',
      }),
    ).toEqual({ state: 'lost' })
    expect(h.sandbox.stops).toBe(stops)
  })

  test('observe stops re-issuing polls once the environment lifetime plus margin has passed', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe-expired',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!

    // Past session expiry plus the stop/snapshot margin the environment
    // itself is gone: the observation fails naming it instead of issuing
    // another long-poll that would end in a generic transport timeout.
    const expiredAt = Date.now() - VERCEL_LIFETIME_MARGIN_MS - 1000
    h.sandbox.sessionExpiresAt = expiredAt
    await expect(h.provider.buildExecution.observe!(identity)).rejects.toThrow(
      /cannot still be running[\s\S]*expired[\s\S]*session expiry/s,
    )
    await expect(h.provider.buildExecution.observe!(identity)).rejects.toThrow(
      identity.environmentId!,
    )
    expect(h.sandbox.getCommandCalls).toBe(0)

    // Just before the bound the alive normal path is unchanged: the poll is
    // issued and a null exit code still reports running.
    h.sandbox.sessionExpiresAt = Date.now() + VERCEL_LIFETIME_MARGIN_MS + 60_000
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'running',
    })
    expect(h.sandbox.getCommandCalls).toBe(1)
  })

  test('an execution without a recorded command id cannot be re-observed', async () => {
    const h = harness()
    await expect(
      h.provider.buildExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: 'never-provisioned',
      }),
    ).rejects.toThrow(/no recorded command id/)
  })

  test('unresolvable provider errors propagate from observe — callers treat them as running', async () => {
    const h = harness({
      facadeGet: async (): Promise<VercelSandboxHandle | null> => {
        throw new Error('provider unreachable')
      },
    })
    await expect(
      h.provider.buildExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: 'unreachable',
        commandId: 'cmd-1',
      }),
    ).rejects.toThrow('provider unreachable')
  })

  test('detach resolves the wait without touching the guest and publication still refuses', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The fake long-poll rejects with the abort reason, honouring the widened
    // wait signature: a detached wait is abort, not failure.
    h.sandbox.detachedWait = (params?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        params?.signal?.addEventListener('abort', () => {
          reject(params.signal!.reason ?? new Error('aborted'))
        })
      })
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-detach',
      workspaceRef: workspace.ref,
    })
    const completion = execution.completion
    // Provisioning itself stops the setup shell once; only a stop beyond that
    // baseline would be the completion chain tearing the guest down.
    const stopsBeforeDetach = h.sandbox.stops
    const deletesBeforeDetach = h.sandbox.deletes
    await execution.detach()

    // The abandoned completion chain resolves without an error and never
    // stops, kills, or deletes the guest the next supervisor is supervising.
    await expect(completion).resolves.toEqual({ exitCode: null })
    expect(h.sandbox.killSignals).toHaveLength(0)
    expect(h.sandbox.stops).toBe(stopsBeforeDetach)
    expect(h.sandbox.deletes).toBe(deletesBeforeDetach)

    // The execution is still provider-live: publication remains forbidden.
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: 'ab/remote-build' }),
    ).rejects.toThrow(/publication is forbidden until sandbox execution teardown is confirmed/)
  })

  test('a non-transient wait failure still rejects the completion', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = async () => {
      throw new Error('Status code 404 is not ok: session not found')
    }
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-real-failure',
      workspaceRef: workspace.ref,
    })

    await expect(execution.completion).rejects.toThrow('404')
  })

  test.each([
    {
      name: 'is missing',
      breakBun: (sandbox: FakeSandbox) => {
        sandbox.failCommand = (command) =>
          command.cmd === VERCEL_BUN_EXECUTABLE &&
          (command.args as string[] | undefined)?.[0] === '--version'
      },
      messages: [/found no version \(pin 1\.4\.4\).*release and reprovision/],
    },
    {
      name: 'cannot reach the pin',
      breakBun: (sandbox: FakeSandbox) => {
        sandbox.bunVersion = '1.4.0'
        sandbox.bunInstallVersion = '1.4.0'
      },
      messages: [
        /found 1\.4\.0 \(pin 1\.4\.4\)/,
        /reports 1\.4\.0 but the pin is 1\.4\.4/,
        /release and reprovision/,
      ],
    },
  ])(
    'a reused sandbox whose Bun $name fails preflight closed and is never launched, now or later',
    async ({ breakBun, messages }) => {
      const h = harness()
      const workspace = await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
      breakBun(h.sandbox)
      const commandsBefore = h.sandbox.commands.length
      const start = () =>
        h.provider.buildExecution
          .start({
            slug: 'remote-build',
            storeRef: 'https://store.example.test',
            instance: 'i-broken-bun',
            workspaceRef: workspace.ref,
          })
          .catch((error: unknown) => error)

      const rejection = await start()
      expect(rejection).toBeInstanceOf(WorkspaceCleanupRequired)
      for (const message of messages) expect((rejection as Error).message).toMatch(message)
      // The pin refresh was attempted before giving up.
      const since = h.sandbox.commands.slice(commandsBefore)
      expect(since.some((command) => command.cmd === 'npm')).toBe(true)
      // A later preflight compares exactly, so the failed upgrade is not accepted.
      expect(await start()).toBeInstanceOf(WorkspaceCleanupRequired)
      expect(h.sandbox.commands.filter((command) => command.detached === true)).toHaveLength(0)
    },
  )

  test('a fresh sandbox installs and verifies Bun at the pin', async () => {
    expect(VERCEL_BUN_VERSION).toBe('1.4.4')
    const h = harness()
    await h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })
    const install = h.sandbox.commands.findIndex((command) => command.cmd === 'npm')
    expect(h.sandbox.commands[install]!.args).toEqual([
      'install',
      '--prefix',
      VERCEL_BUN_PREFIX,
      '--no-save',
      'bun@1.4.4',
    ])
    expect(h.sandbox.commands[install + 1]).toMatchObject({
      cmd: VERCEL_BUN_EXECUTABLE,
      args: ['--version'],
    })
    expect(h.sandbox.bunVersion).toBe('1.4.4')
  })

  test('fresh provisioning whose Bun reports another version fails naming both versions', async () => {
    const h = harness()
    h.sandbox.bunInstallVersion = '1.4.0'

    const rejection = await h.provider
      .provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })
      .catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(WorkspaceCleanupRequired)
    expect((rejection as Error).message).toContain('could not verify provisioned Bun 1.4.4')
    const cause = ((rejection as Error).cause as Error).cause as Error
    expect(cause.message).toContain('reports 1.4.0 but the pin is 1.4.4')
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
  })

  test('a reused sandbox reporting Bun 1.4.0 is brought to the pin before the runner starts', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.bunVersion = '1.4.0'
    // A distribution refresh is also due, so the order proves the pin comes
    // first: the refresh's `bun install` must run on the pinned Bun.
    h.distributionIdentity = '1.2.3+protocol3'
    const commandsBefore = h.sandbox.commands.length

    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stale-bun',
      workspaceRef: workspace.ref,
    })
    expect(await execution.completion).toEqual({ exitCode: 0 })

    const restart = h.sandbox.commands.slice(commandsBefore)
    const runner = restart.findIndex((command) => command.detached === true)
    expect(runner).toBeGreaterThan(0)
    expect(restart.slice(0, runner).map((command) => command.cmd)).toEqual([
      VERCEL_BUN_EXECUTABLE,
      'npm',
      VERCEL_BUN_EXECUTABLE,
      'cat',
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(restart[1]!.args).toContain('bun@1.4.4')
    expect(h.sandbox.bunVersion).toBe(VERCEL_BUN_VERSION)
  })

  test('reused build provisioning refreshes a stale Bun before reinstalling the distribution', async () => {
    const h = harness()
    await h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })
    h.sandbox.bunVersion = '1.4.0'
    h.sandbox.distributionVersion = '0.0.1'
    const commandsBefore = h.sandbox.commands.length

    await h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })

    expect(h.sandbox.commands.slice(commandsBefore).map((command) => command.cmd)).toEqual([
      'test',
      'git',
      'cat',
      VERCEL_BUN_EXECUTABLE,
      'npm',
      VERCEL_BUN_EXECUTABLE,
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(h.sandbox.bunVersion).toBe(VERCEL_BUN_VERSION)
  })

  test('a transient environment stop failure does not poison future starts or release', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopFailures = 1
    const failed = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-fails',
      workspaceRef: workspace.ref,
    })
    await expect(failed.completion).rejects.toThrow(/sandbox stop failed/)
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch }),
    ).rejects.toThrow(/teardown is confirmed/)

    const retried = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-retry',
      workspaceRef: workspace.ref,
    })
    expect(await retried.completion).toEqual({ exitCode: 0 })
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)

    const aborted = harness()
    const abortWorkspace = await aborted.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    aborted.sandbox.stopFailures = 1
    const abortExecution = await aborted.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-abort',
      workspaceRef: abortWorkspace.ref,
    })
    await expect(abortExecution.completion).rejects.toThrow(/sandbox stop failed/)
    await aborted.provider.release(abortWorkspace)
    expect(aborted.sandbox.deletes).toBe(1)
  })

  test('creation binds one-snapshot retention and maps snapshotExpirationSeconds to SDK milliseconds, omitting it when unset', async () => {
    const set = harness({ snapshotExpirationSeconds: 86_400 })
    await set.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(set.createInput?.snapshotExpiration).toBe(86_400_000)
    // Creation always binds the one-snapshot retention bound.
    expect(set.createInput?.keepLastSnapshots).toEqual({ count: 1, deleteEvicted: true })

    const unset = harness()
    await unset.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The key must be absent entirely: the SDK reads `0` as "no expiration".
    expect(unset.createInput?.snapshotExpiration).toBeUndefined()
    expect('snapshotExpiration' in (unset.createInput ?? {})).toBe(false)
  })

  test('reap purges every live snapshot under the exact environment name and never touches dead rows', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Snapshots left by earlier sessions of the same environment, plus dead
    // rows that hold no storage.
    h.sandbox.snapshots.push(
      { id: 'snap-older', sourceSessionId: 'session-0', status: 'created' },
      { id: 'snap-dead', sourceSessionId: 'session-0', status: 'deleted' },
      { id: 'snap-failed', sourceSessionId: 'session-0', status: 'failed' },
    )
    const stopSnapshots = h.sandbox.snapshots.filter(
      (snapshot) => snapshot.status === 'created',
    ).length
    expect(stopSnapshots).toBe(2)

    const outcome = await h.provider.recovery.reap(workspace)
    // The reap's own stop also materializes a snapshot; the purge removes
    // every storage-holding row under the exact name.
    expect(outcome).toEqual({
      outcome: 'confirmed',
      snapshots: { outcome: 'confirmed', deleted: 3 },
    })
    // Only the storage-holding rows were purged.
    expect(h.sandbox.snapshots.map((snapshot) => snapshot.id).sort()).toEqual([
      'snap-dead',
      'snap-failed',
    ])
  })

  test('reap rejects unknown deletion, then on the absent environment still purges its leftover snapshots and becomes a no-op', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Fence a reap so the provider drops its session handle, then make the
    // environment vanish out-of-band with snapshots left behind.
    h.sandbox.remainAfterDelete = true
    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(
      /still exists after delete acknowledgement/,
    )
    h.sandbox.remainAfterDelete = false
    h.sandbox.snapshots.push({
      id: 'snap-orphan',
      sourceSessionId: 'session-9',
      status: 'created',
    })

    const outcome = await h.provider.recovery.reap(workspace)
    expect(outcome).toEqual({
      outcome: 'absent',
      snapshots: { outcome: 'confirmed', deleted: 1 },
    })
    // Authorized cleanup also clears a possible stale name reservation.
    expect(h.sandbox.deletes).toBe(2)
    expect(h.sandbox.snapshots).toEqual([])
    // A further reap is an absence no-op with nothing left to purge.
    expect(await h.provider.recovery.reap(workspace)).toEqual({
      outcome: 'absent',
      snapshots: { outcome: 'confirmed', deleted: 0 },
    })
  })

  test('a snapshot purge failure rejects reap as retryable and a retry completes', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const originalDelete = h.facade.deleteSnapshot.bind(h.facade)
    h.facade.deleteSnapshot = async () => {
      throw new Error('snapshot delete denied')
    }

    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(
      /cleanup outcome is unknown and remains retryable: snapshot purge for .* is unconfirmed: snapshot delete denied/,
    )
    // The purge runs before the sandbox delete, so the retry converges.
    expect(h.sandbox.deletes).toBe(0)

    h.facade.deleteSnapshot = originalDelete
    const outcome = await h.provider.recovery.reap(workspace)
    expect(outcome.outcome).toBe('confirmed')
    expect(outcome.snapshots.outcome).toBe('confirmed')
    expect(outcome.snapshots.deleted).toBeGreaterThan(0)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.snapshots).toEqual([])
  })

  test('reap retains an interrupted stop for a later confirmed retry', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopFailures = 1
    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(/outcome is unknown/)
    expect(h.sandbox.deletes).toBe(0)
    const retry = await h.provider.recovery.reap(workspace)
    expect(retry.outcome).toBe('confirmed')
    expect(retry.snapshots.outcome).toBe('confirmed')
    expect(h.sandbox.deletes).toBe(1)
  })

  test('observes an exact durable branch head without requiring the old sandbox', async () => {
    const landed = harness({ publishedSha: SHA })
    const workspace = await landed.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await landed.provider.recovery.reap(workspace)
    expect(
      await landed.provider.publication.isPublished({ sha: SHA, branch: workspace.branch }),
    ).toBe(true)
    expect(
      await landed.provider.publication.isPublished({
        sha: 'b'.repeat(40),
        branch: workspace.branch,
      }),
    ).toBe(false)
  })

  test('trusted restack archives before exact leased replacement and restores network policy', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const old = 'c'.repeat(40)
    const archive = `refs/autobuild/archive/remote-build/${old}`
    const refs = new Map<string, string>([['refs/heads/ab/remote-build', old]])
    const original = h.sandbox.runCommand.bind(h.sandbox)
    h.sandbox.runCommand = async (params) => {
      if (params.cmd !== 'git') return original(params)
      h.sandbox.commands.push(params)
      const args = params.args as string[]
      let stdout = ''
      if (args[0] === 'ls-remote') {
        const ref = args.at(-1)!
        const sha = refs.get(ref)
        if (sha !== undefined) stdout = `${sha}\t${ref}\n`
      } else if (args[0] === 'push') {
        const [sha, ref] = args.at(-1)!.split(':')
        refs.set(ref!, sha!)
      } else if (args[0] === 'rev-parse') stdout = old
      return { exitCode: 0, stdout: async () => stdout, stderr: async () => '' }
    }
    expect(
      await h.provider.publication.rewrite!({
        ref: workspace.ref,
        sha: SHA,
        branch: workspace.branch,
        expected: old,
        archives: [{ ref: archive, sha: old }],
      }),
    ).toEqual({ kind: 'published' })
    const pushes = h.sandbox.commands.filter(
      (command) => command.cmd === 'git' && (command.args as string[])[0] === 'push',
    )
    expect(pushes.map((command) => command.args)).toEqual([
      ['push', `--force-with-lease=${archive}:`, 'origin', `${old}:${archive}`],
      [
        'push',
        `--force-with-lease=refs/heads/ab/remote-build:${old}`,
        'origin',
        `${SHA}:refs/heads/ab/remote-build`,
      ],
    ])
    expect(h.sandbox.policies).toHaveLength(2)
    expect(JSON.stringify(h.sandbox.policies[1])).not.toContain('forge-secret')
  })

  test.each([false, true])(
    'settlement keeps the guest stopped after authoritative inspection (already published=%s)',
    async (alreadyPublished) => {
      let remoteHead: string | null = alreadyPublished ? SHA : null
      const h = harness({ publishedSha: () => remoteHead })
      const workspace = await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
      let running = false
      let resumes = 0
      const resume = () => {
        if (!running) resumes++
        running = true
      }
      const command = h.sandbox.runCommand.bind(h.sandbox)
      h.sandbox.runCommand = async (params) => {
        resume()
        if (params.cmd === 'git' && (params.args as string[])[0] === 'push') remoteHead = SHA
        return command(params)
      }
      const stop = h.sandbox.stop.bind(h.sandbox)
      h.sandbox.stop = async (...args) => {
        await stop(...args)
        running = false
      }

      const store = new MemoryBuildStore()
      await store.createBuild({ slug: 'remote-build', repo: '/repo', branch: workspace.branch })
      await store.append('remote-build', {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: h.provider.name,
          ref: workspace.ref,
          path: workspace.path,
          branch: workspace.branch,
          base: { source: 'remote', sha: 'b'.repeat(40) },
          remote: true,
        },
      })
      const notes = await store.putArtifact('remote-build', {
        kind: 'implement-notes',
        content: 'implemented',
      })
      await store.append('remote-build', {
        actor: agentActor('implement', 'guest'),
        type: 'publication.requested',
        payload: {
          operation: 'implement',
          branch: workspace.branch,
          sha: SHA,
          round: 1,
          base: 'b'.repeat(40),
          artifact: { kind: notes.kind, rev: notes.revision },
        },
      })
      const deps = {
        store,
        storeRef: 'https://store.example.test',
        publication: h.provider.publication,
        forge: new FakeForge(),
        workspacePath: '/missing-vercel-settlement-cache',
        exec: spawnExec,
        ids: sequentialIds(),
        runId: 'settlement',
      }
      await settlePendingPublication(deps, 'remote-build')
      expect(
        (await store.getEvents('remote-build')).filter((e) => e.type === 'implement.completed'),
      ).toHaveLength(1)
      expect(running).toBe(false)
      expect(resumes).toBe(alreadyPublished ? 0 : 1)
      const commandsAfterSettlement = h.sandbox.commands.length
      const stopsAfterSettlement = h.sandbox.stops
      await settlePendingPublication(deps, 'remote-build')
      expect(h.sandbox.commands).toHaveLength(commandsAfterSettlement)
      expect(h.sandbox.stops).toBe(stopsAfterSettlement)
      expect(running).toBe(false)
    },
  )

  test('publishes only the exact SHA/branch under a temporary credential transform', async () => {
    let reads = 0
    const h = harness({ publishedSha: () => (++reads === 1 ? null : SHA) })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch })
    expect(h.sandbox.commands).toContainEqual({
      cmd: 'git',
      args: ['push', '--no-verify', 'origin', `${SHA}:refs/heads/ab/remote-build`],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    expect(h.sandbox.policies).toHaveLength(2)
    const temporary = JSON.stringify(h.sandbox.policies[0])
    expect(temporary).toContain('git-receive-pack')
    expect(temporary).toContain(Buffer.from('x-access-token:forge-secret').toString('base64'))
    expect(JSON.stringify(h.sandbox.policies[1])).not.toContain('forge-secret')
    expect(h.sandbox.policySignals).toHaveLength(2)
    expect(h.sandbox.policySignals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })

  test('restores the normal policy when push fails and rejects mismatched remote heads', async () => {
    const failed = harness({ publishedSha: null })
    const workspace = await failed.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    failed.sandbox.failPush = true
    await expect(
      failed.provider.publication.publish({
        ref: workspace.ref,
        sha: SHA,
        branch: workspace.branch,
      }),
    ).rejects.toThrow(/git exited 1/)
    expect(failed.sandbox.policies).toHaveLength(2)

    const restore = harness()
    const restoreWorkspace = await restore.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    restore.sandbox.failRestore = true
    await expect(
      restore.provider.publication.publish({
        ref: restoreWorkspace.ref,
        sha: SHA,
        branch: restoreWorkspace.branch,
      }),
    ).rejects.toThrow(/restore failed/)
    expect(restore.sandbox.stops).toBe(3)

    const commandsBeforeRestart = restore.sandbox.commands.length
    await expect(
      restore.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-stale-policy',
        workspaceRef: restoreWorkspace.ref,
      }),
    ).rejects.toThrow(/restore failed/)
    expect(restore.sandbox.commands).toHaveLength(commandsBeforeRestart)
    restore.sandbox.failRestore = false
    const safeRetry = await restore.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-safe-policy',
      workspaceRef: restoreWorkspace.ref,
    })
    expect(await safeRetry.completion).toEqual({ exitCode: 0 })
    expect(JSON.stringify(restore.sandbox.policies.at(-1))).not.toContain('git-receive-pack')

    const mismatch = harness({ publishedSha: 'b'.repeat(40) })
    const other = await mismatch.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await expect(
      mismatch.provider.publication.publish({ ref: other.ref, sha: SHA, branch: other.branch }),
    ).rejects.toThrow(/did not match/)
    expect(mismatch.sandbox.policies).toHaveLength(2)
  })

  test('fails closed for local Stores and missing scoped authority', () => {
    expect(
      () =>
        new VercelSandboxProvider({
          config: {
            image: 'x',
            vcpus: 1,
            timeoutSeconds: 60,
            failoverRegions: [],
            environmentVariables: [],
          },
          env: {},
          storeRef: '/tmp/store',
          storeToken: '',
          repo: '/repo',
          facade: {
            get: async () => null,
            create: async () => {
              throw new Error('unused')
            },
            listSnapshots: async () => [],
            deleteSnapshot: async () => {},
          },
        }),
    ).toThrow(/HTTPS BuildStore/)
  })
})

describe('VercelSandboxProvider origin mode (no checkout)', () => {
  const SHA = 'a'.repeat(40)
  const BASE_SHA = 'b'.repeat(40)

  /** Origin-mode harness: injected origin/remoteBranchHead seams and an exec
   * that THROWS on any host command — proving the provider never shells git
   * on the host when the seams are present. */
  function originHarness(
    options: { remoteBranches?: Record<string, string>; postPushHead?: boolean } = {},
  ) {
    const branches = new Map(Object.entries(options.remoteBranches ?? {}))
    const sandbox = new FakeSandbox()
    let createInput: Record<string, unknown> | undefined
    const facade: VercelSandboxFacade = {
      get: async () => (createInput ? sandbox : null),
      create: async (input) => {
        createInput = input as Record<string, unknown>
        return sandbox
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const throwingExec: Exec = async (cmd) => {
      throw new Error(`host exec must not run in origin mode: ${cmd.join(' ')}`)
    }
    const provider = scopedProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: { GITHUB_TOKEN: 'forge-secret' },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      delegateCredential: async () => 'delegated-store-token',
      repo: '/this/checkout/does/not/exist',
      facade,
      exec: throwingExec,
      packageArchive: async () => new Uint8Array([1, 2, 3]),
      origin: async () => 'https://github.com/acme/app',
      remoteBranchHead: async (branch) =>
        branches.get(branch) ??
        (options.postPushHead !== false &&
        branch === 'ab/remote-build' &&
        sandbox.commands.some((command) => (command.args as string[])?.includes('push'))
          ? SHA
          : undefined),
    })
    return {
      provider,
      sandbox,
      createInput: () => createInput as { source: { url: string; revision: string } },
    }
  }

  test('provisions from the injected origin and remote branch heads with no host exec, preferring an existing build branch', async () => {
    const h = originHarness({ remoteBranches: { main: BASE_SHA } })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.provider).toBe('vercel-sandbox')
    expect(workspace.base).toEqual({ source: 'remote', sha: BASE_SHA })
    // The sandbox source pins the injected origin's https spelling.
    expect(h.createInput().source.url).toBe('https://github.com/acme/app.git')
    expect(h.createInput().source.revision).toBe(BASE_SHA)

    // An existing build branch head wins over the base branch.
    const existing = originHarness({ remoteBranches: { main: BASE_SHA, 'ab/remote-build': SHA } })
    const reused = await existing.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(reused.base).toEqual({ source: 'existing', sha: SHA })
  })

  test('the full publish path, including its post-push verification, runs without host git', async () => {
    // The seam only starts reporting the build branch after the guest's push
    // command ran — exactly what the real forge-backed reader observes once
    // the guest lands the branch.
    const h = originHarness({ remoteBranches: { main: BASE_SHA } })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(await h.provider.publication.isPublished({ sha: SHA, branch: workspace.branch })).toBe(
      false,
    )
    await h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch })
    expect(await h.provider.publication.isPublished({ sha: SHA, branch: workspace.branch })).toBe(
      true,
    )
  })

  test('a publication whose seam never shows the head still fails closed', async () => {
    const h = originHarness({ remoteBranches: { main: BASE_SHA }, postPushHead: false })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The guest push "succeeds" but the seam keeps reporting the branch
    // absent — the verification must reject, never assume.
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch }),
    ).rejects.toThrow(/published head \(missing\) did not match/)
  })
})

describe('VercelSandboxProvider harvestExecution', () => {
  const ORIGIN = 'https://github.com/acme/app.git'
  const HARVEST_NAME = harvestSandboxName(ORIGIN)
  /** The fake handle's provider-native name, which is what the SDK reports on
   * the returned sandbox and what identity/envelope stamp. */
  const LAUNCH_NAME = 'sandbox'

  test('provisions a fresh disposable environment from the remote base head and launches the guest runner', async () => {
    const h = harness({ provisionRuntimes: true })
    const handle = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
      leaseHolder: 'host-dispatch-i0',
      workspaceRef: HARVEST_NAME,
    })

    // One named disposable environment, provisioned from the remote base head
    // with the build shape (persistent, same image/resources/timeout/snapshots).
    expect(h.creates).toBe(1)
    expect(h.createInput).toMatchObject({
      name: HARVEST_NAME,
      source: { type: 'git', url: ORIGIN, revision: SHA },
      persistent: true,
      networkPolicy: 'allow-all',
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    })
    expect((h.createInput!.timeout as number) / 1000).toBe(2700)

    // Fresh provisioning chain, in the build order.
    const commands = h.sandbox.commands
    const labels = commands.map((command) =>
      command.cmd === 'sh'
        ? `sh:${((command.args as string[])[1] ?? '').slice(0, 24)}`
        : command.cmd,
    )
    expect(
      commands.some(
        (command) =>
          command.cmd === 'sh' && String((command.args as string[])[1]).includes('mv "$1" "$2"'),
      ),
    ).toBe(true)
    expect(labels.indexOf('npm')).toBeGreaterThan(
      commands.findIndex(
        (command) => command.cmd === 'sh' && (command.args as string[]).includes('relocate'),
      ),
    )
    expect(labels.lastIndexOf('touch')).toBeGreaterThan(labels.indexOf('npm'))
    expect(h.sandbox.provisioned).toBe(true)
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
    // Runtime runtimes were INSTALLED on the fresh path (not preflight only).
    const runtimeInstalls = commands.filter(
      (command) =>
        command.cmd === 'sh' &&
        ['install-pi@0.84.4', 'install-plugin@abc123'].includes(
          (command.args as string[])[1] ?? '',
        ),
    )
    expect(runtimeInstalls).toHaveLength(2)
    expect(runtimeInstalls[0]!.cwd).toBe(VERCEL_WORKSPACE_PATH)

    // Launch: one detached ab-harvest-runner command carrying the envelope.
    const detached = commands.filter((command) => command.detached === true)
    expect(detached).toHaveLength(1)
    expect(String((detached[0]!.args as string[])[1])).toContain('bin/ab-harvest-runner.ts')
    expect(detached[0]!.cwd).toBe(VERCEL_WORKSPACE_PATH)
    const env = detached[0]!.env as Record<string, string>
    expect(env.AB_STORE).toBe('https://store.example.test')
    expect(env.AB_TOKEN).toBe('delegated-store-token')
    expect(env.ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(JSON.stringify(env)).not.toContain('forge-secret')
    expect(JSON.stringify(env)).not.toContain('never-copy')
    expect(env.AB_GITHUB_REQUIRE_CREDENTIAL).toBe('1')
    expect(env[HARVEST_RUNNER_OPTIONS_ENV]).toBeDefined()
    expect(JSON.parse(env[HARVEST_RUNNER_OPTIONS_ENV]!)).toEqual({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
      leaseHolder: 'host-dispatch-i0',
      workspaceRef: HARVEST_NAME,
      supervision: { kind: 'environment' },
      environment: {
        provider: 'vercel-sandbox',
        environmentId: LAUNCH_NAME,
        sessionId: 'session-1',
      },
    })

    // Supervision identity mirrors the build path.
    expect(handle.supervision).toBe('environment')
    expect(handle.identity).toMatchObject({
      provider: 'vercel-sandbox',
      workspaceRef: HARVEST_NAME,
      environmentId: LAUNCH_NAME,
      sessionId: 'session-1',
    })
    expect(handle.identity?.commandId).toMatch(/^cmd-/)

    // Completion stops the environment; release reaps with a proven snapshot purge.
    expect(await handle.completion).toEqual({ exitCode: 0 })
    const reap = await h.provider.recovery.reap({
      provider: 'vercel-sandbox',
      ref: HARVEST_NAME,
      path: VERCEL_WORKSPACE_PATH,
      branch: 'main',
    })
    expect(reap.outcome).toBe('confirmed')
    expect(reap.snapshots.outcome).toBe('confirmed')
    expect(reap.snapshots.deleted ?? 0).toBeGreaterThan(0)
    expect(h.sandbox.deletes).toBe(1)
    expect(await h.facade.listSnapshots(HARVEST_NAME)).toEqual([])
  })

  test('stops and reuses a marked harvest environment without re-provisioning', async () => {
    const h = harness({ provisionRuntimes: true })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    expect(await first.completion).toEqual({ exitCode: 0 })

    const commandsBefore = h.sandbox.commands.length
    const second = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i2',
      baseBranch: 'main',
    })
    expect(h.creates).toBe(1)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.provisioned).toBe(true)
    const since = h.sandbox.commands.slice(commandsBefore)
    // Marker read, distribution version read, policy reassert, preflights,
    // then the launch — no provisioning chain re-ran.
    expect(since[0]!.cmd).toBe('test')
    expect(since.some((command) => command.sudo === true)).toBe(false)
    expect(since.filter((command) => command.detached === true)).toHaveLength(1)
    expect(await second.completion).toEqual({ exitCode: 0 })
    const envelope = JSON.parse(
      (since.find((command) => command.detached === true)!.env as Record<string, string>)[
        HARVEST_RUNNER_OPTIONS_ENV
      ] as string,
    )
    expect(envelope.instance).toBe('host-harvest-i2')
    expect(envelope.supervision).toEqual({ kind: 'environment' })
  })

  test('a reused harvest environment reporting Bun 1.4.0 is brought to the pin before launch', async () => {
    const h = harness({ provisionRuntimes: true })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    expect(await first.completion).toEqual({ exitCode: 0 })
    h.sandbox.bunVersion = '1.4.0'
    const commandsBefore = h.sandbox.commands.length

    const second = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i2',
      baseBranch: 'main',
    })
    expect(await second.completion).toEqual({ exitCode: 0 })
    const since = h.sandbox.commands.slice(commandsBefore)
    const install = since.findIndex((command) => command.cmd === 'npm')
    const runner = since.findIndex((command) => command.detached === true)
    expect(install).toBeGreaterThan(0)
    expect(since[install]!.args).toContain('bun@1.4.4')
    expect(install).toBeLessThan(runner)
    expect(h.sandbox.bunVersion).toBe(VERCEL_BUN_VERSION)
  })

  test('a reused harvest environment that cannot reach the Bun pin is reaped and never launched', async () => {
    const h = harness({ provisionRuntimes: true })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    expect(await first.completion).toEqual({ exitCode: 0 })
    h.sandbox.bunVersion = '1.4.0'
    h.sandbox.bunInstallVersion = '1.4.0'
    const detachedBefore = h.sandbox.commands.filter((command) => command.detached === true).length
    const deletesBefore = h.sandbox.deletes

    await expect(
      h.provider.harvestExecution.start({
        storeRef: 'https://store.example.test',
        repo: ORIGIN,
        instance: 'host-harvest-i2',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/found 1\.4\.0 \(pin 1\.4\.4\)/)
    expect(h.sandbox.deletes).toBe(deletesBefore + 1)
    expect(h.sandbox.commands.filter((command) => command.detached === true)).toHaveLength(
      detachedBefore,
    )
  })

  test('harvest reuse refreshes a stale distribution marker before launch', async () => {
    const h = harness()
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    expect(await first.completion).toEqual({ exitCode: 0 })
    h.sandbox.distributionVersion = '0.0.1'
    const commandsBefore = h.sandbox.commands.length
    const writesBefore = h.sandbox.writes.length

    const second = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i2',
      baseBranch: 'main',
    })
    expect(await second.completion).toEqual({ exitCode: 0 })

    const since = h.sandbox.commands.slice(commandsBefore)
    const runner = since.findIndex((command) => command.detached === true)
    expect(runner).toBeGreaterThan(0)
    // The stale marker is read, Bun's pin is checked, then the full refresh
    // sequence runs before the detached runner (the launch rechecks the pin).
    expect(since.slice(0, runner).map((command) => command.cmd)).toEqual([
      'test',
      'cat',
      VERCEL_BUN_EXECUTABLE,
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
      VERCEL_BUN_EXECUTABLE,
    ])
    // Exactly one new write — the archive into /tmp — and the marker was
    // refreshed to the current identity.
    expect(h.sandbox.writes).toHaveLength(writesBefore + 1)
    expect(h.sandbox.writes.at(-1)!.path).toBe('/tmp/autobuild.tgz')
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
  })

  test('deletes and recreates an unmarked leftover harvest environment', async () => {
    const leftover = new FakeSandbox()
    leftover.cwd = '/vercel/sandbox'
    const h = harness({ facadeGet: async () => leftover })
    await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    // The crashed/legacy attempt was deleted before the fresh create.
    expect(leftover.deletes).toBe(1)
    expect(h.creates).toBe(1)
    expect(h.sandbox.provisioned).toBe(true)
  })

  test('a second start while one harvest execution is live is refused', async () => {
    const h = harness()
    let resolveWait: ((result: { exitCode: number }) => void) | undefined
    h.sandbox.detachedWait = () =>
      new Promise((resolve) => {
        resolveWait = resolve
      })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    await expect(
      h.provider.harvestExecution.start({
        storeRef: 'https://store.example.test',
        repo: ORIGIN,
        instance: 'host-harvest-i2',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/already has a live execution/)
    resolveWait!({ exitCode: 0 })
    expect(await first.completion).toEqual({ exitCode: 0 })
  })

  test('observe is wired to provider state: running, then ended with the exit code', async () => {
    const h = harness()
    // One resolver per issued wait, in call order: the launch supervision
    // long-poll first, then the observation path's bounded wait.
    const resolvers: Array<(result: { exitCode: number }) => void> = []
    h.sandbox.detachedWait = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const execution = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    const identity = execution.identity!
    // A running detached command is running.
    expect(await h.provider.harvestExecution.observe!(identity)).toEqual({ state: 'running' })
    // A non-null command exit code is ended with that code.
    h.sandbox.detachedCommands.set(identity.commandId!, { exitCode: 3 })
    expect(await h.provider.harvestExecution.observe!(identity)).toEqual({
      state: 'ended',
      exitCode: 3,
    })
    // The first wait belongs to the launch supervision; the observation's
    // own wait already timed out against the never-exiting guest.
    resolvers[0]!({ exitCode: 0 })
    await execution.completion
  })

  test('a missing remote base branch refuses to provision', async () => {
    const h = harness()
    await expect(
      h.provider.harvestExecution.start({
        storeRef: 'https://store.example.test',
        repo: ORIGIN,
        instance: 'host-harvest-i1',
        baseBranch: 'nope',
      }),
    ).rejects.toThrow(/remote base nope does not exist/)
    expect(h.creates).toBe(0)
  })
})

describe('vercelSdkCredentials', () => {
  const oidc = (claims: Record<string, unknown>): string =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

  test('an OIDC token is passed explicitly with the team and project from its claims', () => {
    const token = oidc({ owner_id: 'team_123', project_id: 'prj_456', exp: 1 })
    expect(vercelOidcTokenScope(token)).toEqual({ teamId: 'team_123', projectId: 'prj_456' })
    // The token wins over a durable token in the same environment, and the
    // SDK receives all three fields so it never consults the process env.
    expect(
      vercelSdkCredentials({
        VERCEL_OIDC_TOKEN: token,
        VERCEL_TOKEN: 'durable',
        VERCEL_TEAM_ID: 'other-team',
        VERCEL_PROJECT_ID: 'other-project',
      }),
    ).toEqual({ token, teamId: 'team_123', projectId: 'prj_456' })
  })

  test('an OIDC token whose claims cannot be read is left to the SDK', () => {
    expect(vercelOidcTokenScope('not-a-jwt')).toBeNull()
    expect(
      vercelOidcTokenScope(`a.${Buffer.from('{"sub":"x"}').toString('base64url')}.c`),
    ).toBeNull()
    expect(vercelOidcTokenScope('a.!!!.c')).toBeNull()
    expect(vercelSdkCredentials({ VERCEL_OIDC_TOKEN: 'not-a-jwt' })).toEqual({})
  })

  test('durable credentials require all three variables', () => {
    expect(
      vercelSdkCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'prj' }),
    ).toEqual({ token: 't', teamId: 'team', projectId: 'prj' })
    expect(() => vercelSdkCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team' })).toThrow(
      /requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID/,
    )
  })
})

describe('operator sandbox capability', () => {
  const OPERATOR = 'ops'
  /** The toolchain PATH prefix every guest `sh -c` command must carry: the
   * guest shell expands `$PATH` there — the env record never holds a literal
   * (the SDK passes env values through verbatim, so nothing in that channel
   * would expand it). */
  const PATH_PREFIX = `PATH=${VERCEL_BUN_BIN_PATH}:${VERCEL_AUTOBUILD_PATH}/bin:$PATH; export PATH; `

  function expectCredentialFree(commands: Array<Record<string, unknown>>): void {
    for (const name of SANDBOX_FORBIDDEN_ENV) {
      expect(JSON.stringify(commands)).not.toContain(name)
    }
    for (const value of ['forge-secret', 'provider-secret', 'never-copy']) {
      expect(JSON.stringify(commands)).not.toContain(value)
    }
    for (const command of commands) {
      if (command.env === undefined) continue
      const env = command.env as Record<string, string>
      for (const name of SANDBOX_FORBIDDEN_ENV) expect(Object.keys(env)).not.toContain(name)
      // PATH never rides in the env record: an unexpanded literal there broke
      // guest toolchain resolution (the finding that moved it into the shell).
      expect(Object.keys(env)).not.toContain('PATH')
    }
  }

  test('describe resolves the deterministic identity without provisioning', async () => {
    const h = harness()
    const identity = await h.provider.orchestratorSandbox.describe({
      repo: '/repo',
      operator: OPERATOR,
    })
    expect(identity).toEqual({
      provider: 'vercel-sandbox',
      environmentId: sandboxEnvironmentName('https://github.com/acme/app.git', OPERATOR),
      workspacePath: VERCEL_WORKSPACE_PATH,
    })
    expect(h.creates).toBe(0)
  })

  const NAME = sandboxEnvironmentName('https://github.com/acme/app.git', OPERATOR)
  const IDLE_MS = 30 * 60_000
  type Provider = ReturnType<typeof harness>['provider']
  const open = (provider: Provider) =>
    provider.orchestratorSandbox.open({ repo: '/repo', operator: OPERATOR, baseBranch: 'main' })
  const status = (provider: Provider) =>
    provider.orchestratorSandbox.status({ repo: '/repo', operator: OPERATOR })
  const ensure = (provider: Provider) =>
    provider.orchestratorSandbox.ensure({ repo: '/repo', operator: OPERATOR, baseBranch: 'main' })
  /** The text of every file the provider wrote into the guest. */
  const written = (h: ReturnType<typeof harness>) =>
    h.sandbox.writes.map((write) => ({
      path: write.path,
      text: Buffer.from(write.content).toString('utf8'),
    }))

  test('open on an absent environment returns at once, runs the host phase and launches one detached tail', async () => {
    const h = harness({ provisionRuntimes: true, setupCommand: 'echo setup-ran' })
    h.sandbox.tailOutcome = 'running'
    expect(h.provider.orchestratorSandbox.lifecycleSupported).toBe(true)
    const opened = await open(h.provider)
    expect(opened.status).toEqual({ state: 'provisioning', kind: 'provision' })
    expect(await opened.settled).toEqual({ state: 'provisioning', kind: 'provision' })
    expect(h.createInput!.timeout).toBe(IDLE_MS)
    expect((h.createInput!.source as { revision: string }).revision).toBe(SHA)
    expect(h.sandbox.tailLaunches).toBe(1)
    const launch = h.sandbox.commands.find((command) => command.detached === true)!
    expect(launch).toMatchObject({
      cmd: 'sh',
      args: [`${VERCEL_OPERATOR_PROVISION_DIR}/tail.sh`],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    // Stage files in order: dependencies, runtimes sorted (install before
    // preflight), the setup command behind the PATH prefix, then the marker.
    const stages = written(h).filter((file) => /\/stage-\d+-/.test(file.path))
    expect(stages.map((file) => file.path.split('/').at(-1))).toEqual([
      'stage-01-dependencies.sh',
      'stage-02-runtime-pi-install.sh',
      'stage-03-runtime-pi-preflight.sh',
      'stage-04-runtime-plugin-install.sh',
      'stage-05-runtime-plugin-preflight.sh',
      'stage-06-setup.sh',
      'stage-07-marker.sh',
    ])
    expect(stages[1]!.text).toBe('install-pi@0.84.4\n')
    expect(stages[5]!.text).toBe(`${PATH_PREFIX}echo setup-ran\n`)
    expect(stages[6]!.text).toContain(JSON.stringify({ baseSha: SHA }))
    // Nothing of the tail runs host-driven; build-workspace variables never
    // enter the guest.
    const hostDriven = JSON.stringify(h.sandbox.commands.filter((c) => c.detached !== true))
    for (const needle of ['install-pi', 'echo setup-ran', 'frozen-lockfile'])
      expect(hostDriven).not.toContain(needle)
    expect(launch.env ?? {}).not.toHaveProperty('ANTHROPIC_API_KEY')
    expectCredentialFree([...h.sandbox.commands, ...written(h)])

    // While the tail runs, status reports provisioning and extends the timer.
    h.sandbox.sessionExpiresAt = Date.now() + 1_000
    expect(await status(h.provider)).toEqual({ state: 'provisioning' })
    expect(h.sandbox.extensions).toHaveLength(1)
    // Once the tail wrote the marker, any instance reports ready.
    h.sandbox.tailRunning = false
    h.sandbox.provisioned = true
    h.sandbox.markerContent = JSON.stringify({ baseSha: SHA })
    for (const provider of [h.provider, h.restart()]) {
      expect(await status(provider)).toMatchObject({
        state: 'ready',
        handle: { environmentId: NAME, baseSha: SHA },
        headSha: SHA,
      })
    }
    expect(h.sandbox.extensions).toHaveLength(1)
  })

  test('a tail failure reports its mapped stage and a redacted log tail', async () => {
    for (const [failAt, stage, prefix] of [
      ['dependencies', 'provision', 'dependency install failed: '],
      ['runtime-pi-install', 'provision', 'runtime "pi" install failed (selected by '],
      ['setup', 'setup', 'operator sandbox setup failed: '],
    ] as const) {
      const h = harness({
        provisionRuntimes: true,
        setupCommand: 'echo setup',
        sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'],
        accountEnv: { MY_TOOL_CONFIG: 'forwarded-value', ANTHROPIC_API_KEY: 'runtime-secret' },
      })
      h.sandbox.tailOutcome = { failAt }
      h.sandbox.logTail = 'boom forwarded-value'
      await (await open(h.provider)).settled
      const reported = await h.restart().orchestratorSandbox.status({
        repo: '/repo',
        operator: OPERATOR,
      })
      expect(reported.state).toBe('failed')
      expect(reported.failure?.stage).toBe(stage)
      expect(reported.failure?.message).toStartWith(prefix)
      expect(reported.failure?.message).toContain('boom [REDACTED]')
    }
  })

  test('a host-phase failure is recorded in the guest and never reaped', async () => {
    for (const [fail, stage] of [
      [(params: Record<string, unknown>) => params.cmd === 'npm', 'provision'],
      [
        (params: Record<string, unknown>) => (params.args as string[])?.[2] === 'relocate',
        'checkout',
      ],
      [undefined, 'environment'],
    ] as const) {
      const h = harness(
        fail === undefined
          ? { setupCommand: 'echo setup', sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'] }
          : {},
      )
      h.sandbox.failCommand = fail
      const settled = await (await open(h.provider)).settled
      expect(settled).toMatchObject({ state: 'failed', failure: { stage } })
      expect(h.sandbox.failedContent).toStartWith(`${stage}\n`)
      expect(h.sandbox.deletes).toBe(0)
      expect(h.sandbox.stops).toBe(0)
      expect(await status(h.restart())).toEqual(settled!)
    }
  })

  test('an interrupted host phase maps its heartbeat step; a fresh heartbeat is in flight', async () => {
    const h = harness()
    h.adoptExisting()
    const cases = [
      [{ step: 'provision', ageSeconds: 601 }, 'failed', 'provision'],
      [{ step: 'checkout', ageSeconds: 601 }, 'failed', 'checkout'],
      [{ step: 'provision', ageSeconds: 5 }, 'provisioning', undefined],
      [{ step: 'launched', ageSeconds: 5 }, 'provisioning', undefined],
      [{ step: 'launched', ageSeconds: 31 }, 'failed', 'provision'],
    ] as const
    for (const [heartbeat, state, stage] of cases) {
      h.sandbox.hostHeartbeat = { ...heartbeat }
      const reported = await status(h.provider)
      expect(reported.state).toBe(state)
      expect(reported.failure?.stage).toBe(stage)
    }
    h.sandbox.hostHeartbeat = { step: 'checkout', ageSeconds: 601 }
    expect((await status(h.provider)).failure?.message).toContain('interrupted during checkout')
    h.sandbox.hostHeartbeat = undefined
    expect((await status(h.provider)).failure?.message).toBe(SANDBOX_INTERRUPTED_MESSAGE)
  })

  test('a create that loses to a concurrent instance settles provisioning without a reap', async () => {
    const h = harness()
    h.facade.create = async () => {
      h.adoptExisting()
      throw new Error('sandbox name already exists')
    }
    expect(await (await open(h.provider)).settled).toEqual({
      state: 'provisioning',
      kind: 'provision',
    })
    expect(h.sandbox.deletes).toBe(0)
  })

  test('open resumes a stopped environment with the idle timeout first and never re-provisions it', async () => {
    const h = harness()
    await ensure(h.provider)
    h.sandbox.sessionStatus = 'stopped'
    h.sandbox.autoResume = true
    const before = h.sandbox.commands.length
    const opened = await open(h.restart())
    expect(opened.status).toEqual({ state: 'resuming', kind: 'resume' })
    expect(await opened.settled).toMatchObject({
      state: 'ready',
      kind: 'resume',
      handle: { baseSha: SHA },
    })
    expect(h.sandbox.timeoutUpdates.at(-1)).toBe(IDLE_MS)
    expect(h.sandbox.updateAtCommand.at(-1)).toBe(before)
    expect(h.creates).toBe(1)
    const resumed = JSON.stringify(h.sandbox.commands.slice(before))
    for (const needle of ['clone', 'relocate', 'checkout', 'reset']) {
      expect(resumed).not.toContain(needle)
    }
    // A stopped environment without a marker or a failure record settles
    // the interrupted failure its heartbeat names, and is not reaped.
    h.sandbox.sessionStatus = 'stopped'
    h.sandbox.provisioned = false
    h.sandbox.hostHeartbeat = { step: 'provision', ageSeconds: 5 }
    expect(await (await open(h.restart())).settled).toMatchObject({
      state: 'failed',
      failure: { stage: 'provision', message: expect.stringContaining('interrupted during') },
    })
    expect(h.sandbox.deletes).toBe(0)
  })

  test('a provider-timer stop reports stopped and refuses tool calls without a guest command', async () => {
    const h = harness()
    const identity = await ensure(h.provider)
    h.sandbox.sessionStatus = 'stopped'
    h.sandbox.guardStopped = true
    const before = h.sandbox.commands.length
    expect(await status(h.provider)).toEqual({ state: 'stopped' })
    for (const call of [
      h.provider.orchestratorSandbox.exec(identity, { command: 'true' }),
      h.provider.orchestratorSandbox.readFile(identity, 'a.txt'),
    ]) {
      expect(await call.catch((error: unknown) => error)).toMatchObject({
        stage: 'not-ready',
        state: 'stopped',
      })
    }
    expect(h.sandbox.commands.length).toBe(before)
  })

  test('each tool call extends the timer by its deficit, never past need, and survives a failed extension', async () => {
    const h = harness({ sandboxIdleMinutes: 1 })
    const identity = await ensure(h.provider)
    h.sandbox.extensions.length = 0
    h.sandbox.sessionExpiresAt = Date.now() + 10_000
    await h.provider.orchestratorSandbox.exec(identity, { command: 'true', timeoutSeconds: 300 })
    // The exec bound (300 s + 60 s) outranks the 60 s idle timeout.
    expect(h.sandbox.extensions).toHaveLength(1)
    expect(h.sandbox.extensions[0]!).toBeGreaterThanOrEqual(350_000)
    expect(h.sandbox.extensions[0]!).toBeLessThan(351_000)
    // Already extended past the idle need: nothing more is requested.
    await h.provider.orchestratorSandbox.writeFile(identity, 'a.txt', new Uint8Array([1]))
    expect(h.sandbox.extensions).toHaveLength(1)
    h.sandbox.sessionExpiresAt = Date.now() + 10_000
    await h.provider.orchestratorSandbox.writeFile(identity, 'a.txt', new Uint8Array([1]))
    expect(h.sandbox.extensions[1]!).toBeGreaterThanOrEqual(50_000)
    expect(h.sandbox.extensions[1]!).toBeLessThan(51_000)
    h.sandbox.sessionExpiresAt = Date.now()
    h.sandbox.extendFailure = new Error('extension refused')
    expect(await h.provider.orchestratorSandbox.exec(identity, { command: 'true' })).toMatchObject({
      exitCode: 0,
    })
  })

  test('close stops a ready or failed environment, cancels an in-flight provision, and reports absence', async () => {
    const ready = harness()
    await ensure(ready.provider)
    expect(
      await ready.provider.orchestratorSandbox.close({
        repo: '/repo',
        operator: OPERATOR,
        environmentId: NAME,
      }),
    ).toEqual({ outcome: 'closed' })
    expect([ready.sandbox.stops, ready.sandbox.deletes]).toEqual([1, 0])

    const close = (provider: Provider) =>
      provider.orchestratorSandbox.close({ repo: '/repo', operator: OPERATOR, environmentId: NAME })
    expect(await close(harness().provider)).toEqual({ outcome: 'absent' })

    // This process's attempt: aborted before it created anything.
    const inProcess = harness()
    const opening = await open(inProcess.provider)
    expect(await close(inProcess.provider)).toEqual({
      outcome: 'absent',
      attempt: { state: 'absent', cancelled: true },
    })
    expect(await opening.settled).toEqual({ state: 'absent', cancelled: true })

    // Another process's tail in flight: a user-requested cancel reaps it.
    const elsewhere = harness()
    elsewhere.adoptExisting()
    elsewhere.sandbox.tailRunning = true
    expect(await close(elsewhere.provider)).toEqual({
      outcome: 'absent',
      attempt: { state: 'absent', cancelled: true },
    })
    expect(elsewhere.sandbox.deletes).toBe(1)

    // Another process's resume still pending: stopped, with no guest command.
    const pending = harness()
    pending.adoptExisting()
    pending.sandbox.sessionStatus = 'pending'
    pending.sandbox.guardStopped = true
    expect(await close(pending.restart())).toEqual({ outcome: 'closed' })
    expect([pending.sandbox.stops, pending.sandbox.deletes]).toEqual([1, 0])
    expect(pending.sandbox.commands).toEqual([])

    // A failed environment is stopped, never reaped: its record survives.
    const failed = harness()
    failed.adoptExisting()
    failed.sandbox.failedContent = 'setup\n'
    expect(await close(failed.provider)).toMatchObject({
      outcome: 'closed',
      attempt: { state: 'failed', failure: { stage: 'setup' } },
    })
    expect([failed.sandbox.stops, failed.sandbox.deletes]).toEqual([1, 0])
    expect(failed.sandbox.failedContent).toBe('setup\n')
  })

  test('refresh fetches in the guest without a credential and fast-forwards a clean checkout', async () => {
    const NEW = 'b'.repeat(40)
    let main = SHA
    const h = harness({ mainSha: () => main })
    const identity = await ensure(h.provider)
    main = NEW
    let porcelain = ''
    let head = SHA
    let ancestry: Record<string, number> = { [`${NEW} ${SHA}`]: 1, [`${SHA} ${NEW}`]: 0 }
    h.sandbox.gitResponder = (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: porcelain }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { exitCode: 0, stdout: `${head}\n` }
      if (args[0] === 'fetch') return { exitCode: 0 }
      if (args[0] === 'merge-base') return { exitCode: ancestry[`${args[2]} ${args[3]}`] ?? 1 }
      return undefined
    }
    const refresh = () =>
      h.provider.orchestratorSandbox.refresh(identity, { repo: '/repo', baseBranch: 'main' })
    expect(await refresh()).toEqual({
      outcome: 'refreshed',
      headSha: NEW,
      baseSha: NEW,
      previousHeadSha: SHA,
    })
    const fetch = h.sandbox.commands.find((command) => (command.args as string[])?.[0] === 'fetch')!
    expect(fetch.args).toEqual(['fetch', '--quiet', 'origin', 'main'])
    expect(fetch.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    expect(h.sandbox.markerContent).toBe(JSON.stringify({ baseSha: NEW }))
    head = NEW
    expect((await refresh()).outcome).toBe('current')
    head = 'c'.repeat(40)
    ancestry = {}
    expect(await refresh()).toMatchObject({ outcome: 'refused', reason: 'diverged' })
    porcelain = ' M src/a.ts\n'
    expect(await refresh()).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      message: SANDBOX_REFRESH_DIRTY_MESSAGE,
    })
  })

  test('a private repository fetch rides the upload-pack transform on create and on every open', async () => {
    for (const credential of ['configured', 'egress'] as const) {
      const secret = 'read-secret'
      const basic = Buffer.from(`x-access-token:${secret}`).toString('base64')
      const h = harness(
        credential === 'configured'
          ? {
              gitCredentialEnv: { username: 'READ_USER', password: 'READ_PASSWORD' },
              accountEnv: { READ_USER: 'x-access-token', READ_PASSWORD: secret },
            }
          : { egressReadCredential: { username: 'x-access-token', password: secret } },
      )
      await (await open(h.provider)).settled
      await open(h.provider)
      for (const policy of [h.createInput!.networkPolicy, h.sandbox.policies.at(-1)]) {
        const routes = (policy as { allow: Record<string, unknown[]> }).allow['github.com']!
        expect(JSON.stringify(routes)).toContain(`Basic ${basic}`)
        expect(routes.map((route) => JSON.stringify((route as { match: unknown }).match))).toEqual([
          expect.stringContaining('/acme/app.git/info/refs'),
          expect.stringContaining('/acme/app.git/git-upload-pack'),
        ])
      }
      const guest = [...h.sandbox.commands, ...written(h)]
      for (const value of [secret, basic]) expect(JSON.stringify(guest)).not.toContain(value)
      expectCredentialFree(guest)
    }
  })

  // ── Service over the provider: durable evidence across processes ──
  const REPO_ID = 'https://github.com/acme/app.git'
  const serviceOver = (provider: Provider, store: MemoryBuildStore, clock?: () => Date) =>
    createOperatorSandboxService({
      store,
      repo: REPO_ID,
      provider,
      sandbox: { idleMinutes: 30, environmentVariables: [] },
      baseBranch: 'main',
      sleep: async () => {},
      ...(clock !== undefined ? { clock } : {}),
    })
  /** Every settlement append on `store` throws (a store outage) or misses
   * (a journal that keeps advancing) until the returned restore runs. */
  const breakSettlements = (store: MemoryBuildStore, mode: 'throw' | 'miss') => {
    const real = store.appendRepoIfCurrent.bind(store)
    store.appendRepoIfCurrent = (async () => {
      if (mode === 'throw') throw new Error('store unavailable')
      return null
    }) as typeof store.appendRepoIfCurrent
    return () => {
      store.appendRepoIfCurrent = real
    }
  }
  const journal = async (store: MemoryBuildStore) =>
    (await store.getRepoEvents(REPO_ID)).map((event) =>
      event.type.replace('orchestrator.sandbox.', ''),
    )
  const failures = async (store: MemoryBuildStore) =>
    (await store.getRepoEvents(REPO_ID))
      .filter((event) => event.type === 'orchestrator.sandbox.provision-failed')
      .map((event) => {
        const { stage, message } = event.payload as { stage: string; message: string }
        return { stage, message }
      })
  const ref = { repo: REPO_ID }

  test('a host failure whose journal append was lost is settled once by a fresh instance, then replaced by open', async () => {
    const h = harness()
    h.sandbox.failCommand = (params) => params.cmd === 'npm'
    const store = new MemoryBuildStore()
    const restore = breakSettlements(store, 'throw')
    const first = await serviceOver(h.provider, store)
    expect((await first.open('ops', ref)).state).toBe('provisioning')
    await first.settled('ops')
    expect(await journal(store)).toEqual(['provisioning'])
    restore()
    h.sandbox.failCommand = undefined
    const second = await serviceOver(h.restart(), store)
    expect(await second.status('ops', ref)).toMatchObject({
      state: 'failed',
      failure: { stage: 'provision', message: expect.stringContaining('could not provision Bun') },
    })
    expect(await journal(store)).toEqual(['provisioning', 'provision-failed'])
    expect(h.sandbox.deletes).toBe(0)
    await second.open('ops', ref)
    await second.settled('ops')
    expect(await journal(store)).toEqual(['provisioning', 'provision-failed', 'provisioning'])
    expect([h.sandbox.deletes, h.creates]).toEqual([1, 2])
  })

  test('a create failure whose append was lost is failed by the orphan rule after its grace, once', async () => {
    const h = harness()
    h.createFailure = new Error('quota exceeded')
    const store = new MemoryBuildStore()
    const restore = breakSettlements(store, 'throw')
    const first = await serviceOver(h.provider, store)
    await first.open('ops', ref)
    await first.settled('ops')
    restore()
    h.createFailure = undefined
    let now = Date.now()
    const clock = () => new Date(now)
    const second = await serviceOver(h.restart(), store, clock)
    expect((await second.status('ops', ref)).state).toBe('provisioning')
    expect(await journal(store)).toEqual(['provisioning'])
    now += SANDBOX_PROVISION_ORPHAN_MS + 1_000
    expect(await second.status('ops', ref)).toMatchObject({
      state: 'failed',
      failure: { stage: 'checkout', message: SANDBOX_ORPHAN_MESSAGE },
    })
    await (await serviceOver(h.restart(), store, clock)).status('ops', ref)
    expect(await journal(store)).toEqual(['provisioning', 'provision-failed'])
  })

  test('open never reaps an environment whose failure it could not record', async () => {
    const h = harness({ setupCommand: 'echo setup' })
    h.sandbox.tailOutcome = { failAt: 'setup' }
    const store = new MemoryBuildStore()
    const service = await serviceOver(h.provider, store)
    await service.open('ops', ref)
    await service.settled('ops')
    const restore = breakSettlements(store, 'miss')
    expect(await service.open('ops', ref).catch((error: unknown) => error)).toMatchObject({
      stage: 'provision',
      message: SANDBOX_UNRECORDED_FAILURE_MESSAGE,
    })
    expect([h.sandbox.deletes, h.creates, h.sandbox.failedContent]).toEqual([0, 1, 'setup\n'])
    restore()
    await service.open('ops', ref)
    await service.settled('ops')
    expect(await failures(store)).toEqual([
      { stage: 'setup', message: expect.stringContaining('operator sandbox setup failed') },
    ])
    expect([h.sandbox.deletes, h.creates]).toEqual([1, 2])
  })

  for (const [label, arrange, stage, message] of [
    [
      'setup',
      (h: ReturnType<typeof harness>) => {
        h.sandbox.tailOutcome = { failAt: 'setup' }
        h.sandbox.logTail = '== setup\nsetup broke'
      },
      'setup',
      'operator sandbox setup failed: == setup\nsetup broke',
    ],
    [
      'Bun host step',
      (h: ReturnType<typeof harness>) => {
        h.sandbox.failCommand = (params) => params.cmd === 'npm'
      },
      'provision',
      'could not provision Bun',
    ],
  ] as const) {
    test(`an unpublished ${label} failure in a timer-stopped sandbox is recovered by open with its recorded stage`, async () => {
      const h = harness({ setupCommand: 'echo setup' })
      arrange(h)
      const store = new MemoryBuildStore()
      const restore = breakSettlements(store, 'throw')
      const first = await serviceOver(h.provider, store)
      await first.open('ops', ref)
      await first.settled('ops')
      restore()
      h.sandbox.failCommand = undefined
      h.sandbox.sessionStatus = 'stopped'
      h.sandbox.autoResume = true
      const second = await serviceOver(h.restart(), store)
      const before = h.sandbox.commands.length
      expect((await second.status('ops', ref)).state).toBe('stopped')
      expect(h.sandbox.commands.length).toBe(before)
      expect((await second.open('ops', ref)).state).toBe('resuming')
      await second.settled('ops')
      expect(await failures(store)).toEqual([{ stage, message: expect.stringContaining(message) }])
      expect(h.sandbox.deletes).toBe(0)
      await second.open('ops', ref)
      await second.settled('ops')
      expect([h.sandbox.deletes, h.creates]).toEqual([1, 2])
    })
  }

  test('a resume failure supersedes an older marker for every later observer', async () => {
    const h = harness()
    await ensure(h.provider)
    h.sandbox.bunVersion = '1.4.0'
    h.sandbox.bunInstallVersion = '1.4.0'
    const store = new MemoryBuildStore()
    const restore = breakSettlements(store, 'throw')
    const first = await serviceOver(h.provider, store)
    expect((await first.open('ops', ref)).state).toBe('resuming')
    await first.settled('ops')
    expect([h.sandbox.provisioned, h.sandbox.failedContent?.split('\n')[0]]).toEqual([
      true,
      'resume',
    ])
    restore()
    const second = await serviceOver(h.restart(), store)
    expect(await second.status('ops', ref)).toMatchObject({
      state: 'failed',
      failure: { stage: 'resume' },
    })
    expect(await journal(store)).toEqual(['provisioning', 'provision-failed'])
  })

  for (const outcome of ['resumed', 'failed'] as const) {
    test(`another process polling during a runtime refresh sees resuming, then the refresh ${outcome}`, async () => {
      const h = harness()
      await ensure(h.provider)
      h.sandbox.bunVersion = '1.4.0'
      if (outcome === 'failed') h.sandbox.bunInstallVersion = '1.4.0'
      let release!: () => void
      let entered!: () => void
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      const installing = new Promise<void>((resolve) => {
        release = resolve
      })
      h.sandbox.commandGate = (params) => {
        if (params.cmd !== 'npm') return undefined
        entered()
        return installing
      }
      const store = new MemoryBuildStore()
      const first = await serviceOver(h.provider, store)
      expect((await first.open('ops', ref)).state).toBe('resuming')
      await reached
      const second = await serviceOver(h.restart(), store)
      expect((await second.status('ops', ref)).state).toBe('resuming')
      expect(
        await second.exec('ops', { repo: REPO_ID, command: 'true' }).catch((error) => error),
      ).toMatchObject({ stage: 'not-ready', state: 'resuming' })
      release()
      await first.settled('ops')
      const facts = await journal(store)
      expect(facts).toEqual([
        'provisioning',
        outcome === 'resumed' ? 'resumed' : 'provision-failed',
      ])
      expect((await second.status('ops', ref)).state).toBe(
        outcome === 'resumed' ? 'ready' : 'failed',
      )
    })
  }

  test('closing a journaled failure stops the kept environment without discarding it', async () => {
    const h = harness({ setupCommand: 'echo setup' })
    h.sandbox.tailOutcome = { failAt: 'setup' }
    const store = new MemoryBuildStore()
    const service = await serviceOver(h.provider, store)
    await service.open('ops', ref)
    await service.settled('ops')
    expect((await service.status('ops', ref)).state).toBe('failed')
    expect(await service.close('ops', ref)).toMatchObject({ outcome: 'closed' })
    expect([h.sandbox.stops, h.sandbox.deletes, h.sandbox.failedContent]).toEqual([1, 0, 'setup\n'])
    expect(await journal(store)).toEqual(['provisioning', 'provision-failed'])
  })

  test('the guest probe ranks a failure above a refresh in progress above an older success marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-vercel-probe-'))
    try {
      const probe = () =>
        parseVercelOperatorProbe(
          Bun.spawnSync([
            'sh',
            '-c',
            VERCEL_OPERATOR_PROBE_SCRIPT,
            'probe',
            dir,
            join(dir, 'marker'),
            dir,
            join(dir, 'no-bun'),
            join(dir, 'distribution'),
          ]).stdout.toString(),
        )
      expect(probe()).toEqual({ kind: 'none' })
      await writeFile(join(dir, 'host'), 'provision 100\n')
      expect(probe()).toMatchObject({ kind: 'host', step: 'provision' })
      await writeFile(join(dir, 'marker'), JSON.stringify({ baseSha: SHA }))
      await writeFile(join(dir, 'distribution'), '1.2.3\n')
      expect(probe()).toEqual({ kind: 'ready', marker: { baseSha: SHA }, distribution: '1.2.3' })
      await writeFile(join(dir, 'resuming'), '100\n')
      expect(probe()).toMatchObject({ kind: 'resuming' })
      await writeFile(join(dir, 'failed'), 'resume\nBun pin failed\n')
      await writeFile(join(dir, 'log'), 'tail output')
      expect(probe()).toEqual({
        kind: 'failed',
        record: 'resume\nBun pin failed\n',
        log: 'tail output',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a deployment egress read credential reaches only the upload-pack transform', async () => {
    const secret = 'deploy-forge-secret'
    const basic = Buffer.from(`x-access-token:${secret}`).toString('base64')
    const h = harness({ egressReadCredential: { username: 'x-access-token', password: secret } })
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    const input = h.createInput!
    expect(Object.hasOwn(input, 'source')).toBe(false)
    const uploadPackOnly = {
      allow: {
        '*': [],
        'github.com': [
          {
            match: {
              method: ['GET'],
              path: { exact: '/acme/app.git/info/refs' },
              queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
            },
            transform: [{ headers: { authorization: `Basic ${basic}` } }],
          },
          {
            match: { method: ['POST'], path: { exact: '/acme/app.git/git-upload-pack' } },
            transform: [{ headers: { authorization: `Basic ${basic}` } }],
          },
        ],
      },
    }
    expect(input.networkPolicy).toEqual(uploadPackOnly)
    const { networkPolicy: _policy, ...rest } = input
    for (const value of [secret, basic]) expect(JSON.stringify(rest)).not.toContain(value)
    // The guest clones the bare origin itself; no credential rides argv or env.
    expect(h.sandbox.commands).toContainEqual({
      cmd: 'git',
      args: ['clone', '--no-checkout', 'https://github.com/acme/app.git', VERCEL_WORKSPACE_PATH],
      env: { GIT_TERMINAL_PROMPT: '0' },
    })
    expect(h.sandbox.commands).toContainEqual({
      cmd: 'git',
      args: ['-C', VERCEL_WORKSPACE_PATH, 'checkout', '--detach', SHA],
    })
    for (const value of [secret, basic]) {
      expect(JSON.stringify(h.sandbox.commands)).not.toContain(value)
    }
    expectCredentialFree(h.sandbox.commands)
    // A later policy reset (publication restores the normal policy) keeps the
    // same two transforms and nothing broader.
    await h.provider.publication.publish({
      ref: identity.environmentId,
      sha: SHA,
      branch: 'ab/remote-build',
    })
    expect(h.sandbox.policies.at(-1)).toEqual(uploadPackOnly)
  })

  test('an egress read credential and a configured gitPasswordEnv are mutually exclusive', () => {
    expect(() =>
      harness({
        egressReadCredential: { username: 'x-access-token', password: 'deploy-forge-secret' },
        gitCredentialEnv: { username: 'READ_USER', password: 'READ_PASSWORD' },
      }),
    ).toThrow('not both')
  })

  test('reuse re-checks the marker only, omits baseSha, and a stale distribution is refreshed', async () => {
    const h = harness()
    const fresh = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    // baseSha rides on the fresh provision only.
    expect(fresh.baseSha).toBe(SHA)
    const commandCount = h.sandbox.commands.length
    const resumed = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    expect(h.creates).toBe(1)
    expect(h.sandbox.commands.slice(commandCount)).toEqual([
      { cmd: 'test', args: ['-f', VERCEL_PROVISIONED_MARKER] },
      { cmd: VERCEL_BUN_EXECUTABLE, args: ['--version'], signal: expect.any(AbortSignal) },
      {
        cmd: 'cat',
        args: [VERCEL_DISTRIBUTION_VERSION_MARKER],
        signal: expect.any(AbortSignal),
      },
    ])
    expect(resumed.sessionId).toBe('session-1')
    expect(resumed.baseSha).toBeUndefined()

    // A reused environment whose marker disagrees is refreshed in place.
    h.sandbox.distributionVersion = '0.0.1'
    const refreshCommands = h.sandbox.commands.length
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    expect(h.creates).toBe(1)
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
    expect(h.sandbox.commands.slice(refreshCommands).map((command) => command.cmd)).toEqual([
      'test',
      VERCEL_BUN_EXECUTABLE,
      'cat',
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
  })

  test('a reused operator sandbox reporting Bun 1.4.0 is brought to the pin before it is returned', async () => {
    const h = harness()
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    h.sandbox.bunVersion = '1.4.0'
    const commandsBefore = h.sandbox.commands.length

    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    expect(h.creates).toBe(1)
    expect(h.sandbox.commands.slice(commandsBefore).map((command) => command.cmd)).toEqual([
      'test',
      VERCEL_BUN_EXECUTABLE,
      'npm',
      VERCEL_BUN_EXECUTABLE,
      'cat',
    ])
    expect(h.sandbox.bunVersion).toBe(VERCEL_BUN_VERSION)
  })

  test('a reused operator sandbox that cannot reach the Bun pin is reaped', async () => {
    const h = harness()
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    h.sandbox.bunVersion = '1.4.0'
    h.sandbox.bunInstallVersion = '1.4.0'
    const deletesBefore = h.sandbox.deletes

    const rejection = await h.provider.orchestratorSandbox
      .ensure({ repo: '/repo', operator: OPERATOR, baseBranch: 'main' })
      .catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(SandboxOperationError)
    expect((rejection as Error).message).toContain('found 1.4.0 (pin 1.4.4)')
    expect(h.sandbox.deletes).toBe(deletesBefore + 1)
  })

  test('sandboxPublication is the same object as publication on a freshly constructed provider', async () => {
    // Constructed here, not reused from a harness field: a field-initializer
    // alias would capture `undefined` and fail exactly this assertion
    // (the constructor-assignment regression).
    const h = harness()
    expect(h.provider.sandboxPublication).toBe(h.provider.publication)
  })

  test('exec is bounded by its own deadline, re-issuing interrupted long-polls', async () => {
    const h = harness()
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    let polls = 0
    h.sandbox.detachedWait = async () => {
      polls += 1
      if (polls === 1) {
        const timeout = new Error('The operation timed out.')
        timeout.name = 'TimeoutError'
        throw timeout
      }
      return { exitCode: 0 }
    }
    const result = await h.provider.orchestratorSandbox.exec(
      {
        provider: 'vercel-sandbox',
        environmentId: sandboxEnvironmentName('https://github.com/acme/app.git', OPERATOR),
        workspacePath: VERCEL_WORKSPACE_PATH,
      },
      // 300 s: far past the 30 s operation timeout — the wait must not be
      // cut off by it, only by the caller's own deadline.
      { command: 'echo hi', timeoutSeconds: 300 },
    )
    expect(result).toMatchObject({ exitCode: 0 })
    expect(polls).toBeGreaterThanOrEqual(2)
    const launch = h.sandbox.commands.at(-1) as Record<string, unknown>
    expect(launch.detached).toBe(true)
    expect((launch.args as string[])[1]).toBe(`${PATH_PREFIX}echo hi`)
    expectCredentialFree([launch])
  })

  test('exec past its deadline kills the command and fails typed', async () => {
    const h = harness()
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    h.sandbox.detachedWait = () => {
      const timeout = new Error('The operation timed out.')
      timeout.name = 'TimeoutError'
      return Promise.reject(timeout)
    }
    const error = await h.provider.orchestratorSandbox
      .exec(
        {
          provider: 'vercel-sandbox',
          environmentId: sandboxEnvironmentName('https://github.com/acme/app.git', OPERATOR),
          workspacePath: VERCEL_WORKSPACE_PATH,
        },
        { command: 'sleep 1000', timeoutSeconds: 1 },
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('exec-timeout')
    expect(h.sandbox.killSignals.length).toBeGreaterThan(0)
  }, 20_000)

  test('a real exec failure surfaces as a typed exec error', async () => {
    const h = harness()
    await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    h.sandbox.detachedWait = async () => {
      throw new Error('connection reset by provider')
    }
    const error = await h.provider.orchestratorSandbox
      .exec(
        {
          provider: 'vercel-sandbox',
          environmentId: sandboxEnvironmentName('https://github.com/acme/app.git', OPERATOR),
          workspacePath: VERCEL_WORKSPACE_PATH,
        },
        { command: 'false' },
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('exec')
  })

  test('start returns a command id and wait reads the exit and output', async () => {
    const h = harness()
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    const { commandId } = await h.provider.orchestratorSandbox.start(identity, {
      command: 'bun test',
    })
    expect(commandId).toMatch(/^cmd-/)
    // A zero-second wait observes without waiting: running, no output
    // (Vercel reports output only after exit).
    expect(
      await h.provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 0 }),
    ).toEqual({
      state: 'running',
    })
    h.sandbox.detachedExits.set(commandId, 3)
    const finished = await h.provider.orchestratorSandbox.wait(identity, {
      commandId,
      waitSeconds: 300,
    })
    expect(finished).toMatchObject({ state: 'exited', exitCode: 3 })
  })

  test('readFile round-trips arbitrary binary through the rooted base64 channel; writeFile routes through writeFiles', async () => {
    const h = harness()
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    h.sandbox.detachedWait = async () => ({ exitCode: 0 })
    // Bytes a string stdout channel would mangle.
    const binary = new Uint8Array([0, 1, 2, 0x0a, 0x22, 0xff, 0xfe, 0x80])
    h.sandbox.fileContent = binary
    const bytes = await h.provider.orchestratorSandbox.readFile(identity, 'src/blob.bin')
    expect([...bytes]).toEqual([...binary])
    const read = [...h.sandbox.commands].reverse().find((command) => command.cmd === 'base64')
    expect((read!.args as string[])[0]).toBe(`${VERCEL_WORKSPACE_PATH}/src/blob.bin`)
    expectCredentialFree([read!])

    await h.provider.orchestratorSandbox.writeFile(identity, 'out.txt', new Uint8Array([1, 2]))
    expect(h.sandbox.writes.at(-1)).toEqual({
      path: `${VERCEL_WORKSPACE_PATH}/out.txt`,
      content: new Uint8Array([1, 2]),
    })
  })

  test('stop ends the session and keeps the sandbox; absent is reported honestly', async () => {
    const h = harness()
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    const stops = h.sandbox.stops
    expect(
      await h.provider.orchestratorSandbox.stop({
        operator: OPERATOR,
        environmentId: identity.environmentId,
      }),
    ).toEqual({ outcome: 'stopped' })
    expect(h.sandbox.stops).toBe(stops + 1)
    expect(h.sandbox.deletes).toBe(0)
    // The snapshot is kept for the next resume.
    expect(h.sandbox.snapshots.length).toBe(1)

    // An environment the provider cannot resolve is reported absent, not
    // stopped (a fresh harness whose facade resolves nothing).
    const absent = harness({ facadeGet: async () => null })
    expect(
      await absent.provider.orchestratorSandbox.stop({
        operator: OPERATOR,
        environmentId: 'autobuild-sandbox-gone',
      }),
    ).toEqual({ outcome: 'absent' })
  })

  test('release reaps the environment and purges its snapshots', async () => {
    const h = harness()
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    const released = await h.provider.orchestratorSandbox.release({
      repo: '/repo',
      operator: OPERATOR,
      environmentId: identity.environmentId,
    })
    expect(released.snapshots.outcome).toBe('confirmed')
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.snapshots).toHaveLength(0)
  })

  test('a missing forwarded host value fails typed as environment', async () => {
    const h = harness({
      setupCommand: 'echo setup-ran',
      sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'],
    })
    const error = await h.provider.orchestratorSandbox
      .ensure({ repo: '/repo', operator: OPERATOR, baseBranch: 'main' })
      .then(() => undefined)
      .catch((e: unknown) => e)
    // The environment check fires at the setup command, after provisioning.
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('environment')
  })

  test('a missing forwarded host value during exec fails typed before any command', async () => {
    const h = harness({ sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'] })
    const identity = await h.provider.orchestratorSandbox.ensure({
      repo: '/repo',
      operator: OPERATOR,
      baseBranch: 'main',
    })
    const error = await h.provider.orchestratorSandbox
      .exec(identity, { command: 'echo hi' })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('environment')
  })
})

describe('validateVercelSandbox execOrThrow failure semantics', () => {
  const baseOptions = {
    config: {
      image: 'vercel/sandbox/universal:latest',
      vcpus: 4,
      timeoutSeconds: 2700,
      failoverRegions: [],
      environmentVariables: [],
    },
    env: {},
    storeRef: 'https://store.example.test',
    storeToken: 'scoped-store-token',
    delegateCredential: async () => 'delegated-store-token',
    repo: '/repo',
    baseBranch: 'main',
  }

  // Deliberately not keyed to a specific argv: this pins the helper's
  // formatting, not the call order. If a future edit inserts an earlier exec
  // call, this test fails loudly and gets re-pinned — that is the
  // drift-detection working.
  test.each([
    [
      'a failing exec throws with the exit code and the trimmed stderr',
      { stdout: ' stdout filler ', stderr: 'fatal: not a git repository', exitCode: 2 },
      'git remote get-url origin exited 2: fatal: not a git repository',
    ],
    [
      'with empty stderr the message falls back to the trimmed stdout',
      { stdout: '  noisy stdout  ', stderr: '', exitCode: 7 },
      'git remote get-url origin exited 7: noisy stdout',
    ],
  ])('%s', async (_name, result, message) => {
    const exec: Exec = async () => result
    const error = await validateVercelSandbox({ ...baseOptions, exec }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    // Exact equality against the current first execOrThrow call site.
    expect((error as Error).message).toBe(message)
  })
})

test('billing credentials stay out of all guest commands and rotate on observation without relaunch', async () => {
  const env: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: 'sentinel-old-credential',
    SECOND_KEY: 'sentinel-second-credential',
  }
  const accounts = {
    first: { kind: 'kimi-code', credentialEnv: 'ANTHROPIC_API_KEY', region: 'overseas' },
    second: { kind: 'kimi-code', credentialEnv: 'SECOND_KEY', region: 'overseas' },
  } as const
  const h = harness({ accounts: () => accounts, accountEnv: env })
  const workspace = await h.provider.provision({
    repo: '/repo',
    baseBranch: 'main',
    branch: 'ab/billing',
  })
  h.sandbox.detachedWait = () => new Promise(() => undefined)
  const execution = await h.provider.buildExecution.start({
    slug: 'billing',
    storeRef: 'https://store.example.test',
    instance: 'i',
    workspaceRef: workspace.ref,
  })
  const commandCount = h.sandbox.commands.length
  expect(JSON.stringify(h.sandbox.commands)).not.toContain('sentinel-')
  expect(JSON.stringify(h.sandbox.writes)).not.toContain('sentinel-')
  const originalPolicy = JSON.stringify(h.sandbox.policies.at(-1))
  expect(originalPolicy).toContain('sentinel-old-credential')
  expect(originalPolicy).toContain('sentinel-second-credential')
  expect(originalPolicy).toContain('autobuild-account-6669727374')
  expect(originalPolicy).toContain('autobuild-account-7365636f6e64')
  env.ANTHROPIC_API_KEY = 'sentinel-rotated-credential'
  expect(await h.provider.buildExecution.observe!(execution.identity!)).toEqual({
    state: 'running',
  })
  expect(h.sandbox.commands.length).toBe(commandCount)
  const rotated = JSON.stringify(h.sandbox.policies.at(-1))
  expect(rotated).toContain('sentinel-rotated-credential')
  expect(rotated).not.toContain('sentinel-old-credential')
  delete env.ANTHROPIC_API_KEY
  const missing = await h.provider.buildExecution.observe!(execution.identity!)
  expect(missing.state).toBe('running')
  expect(missing.attention).toContain('ANTHROPIC_API_KEY')
  expect(missing.attention).toContain('first')
  expect(missing.attention).toContain('replace the Kimi')
  h.sandbox.detachedCommands.get(execution.identity!.commandId!)!.exitCode = 0
  const exited = await h.provider.buildExecution.observe!(execution.identity!)
  expect(exited).toMatchObject({ state: 'ended', exitCode: 0, attention: missing.attention })
  expect(h.sandbox.stops).toBeGreaterThan(0)
  expect(JSON.stringify(h.sandbox.policies.at(-1))).not.toContain('sentinel-rotated-credential')
})

test('legacy observation makes no policy writes and still settles command exit', async () => {
  const h = harness()
  const workspace = await h.provider.provision({
    repo: '/repo',
    baseBranch: 'main',
    branch: 'ab/legacy-observe',
  })
  h.sandbox.detachedWait = () => new Promise(() => undefined)
  const execution = await h.provider.buildExecution.start({
    slug: 'legacy-observe',
    storeRef: 'https://store.example.test',
    instance: 'i',
    workspaceRef: workspace.ref,
  })
  const updates = h.sandbox.policies.length
  h.sandbox.failRestore = true // Any newly introduced policy write would fail.
  expect(await h.provider.buildExecution.observe!(execution.identity!)).toEqual({
    state: 'running',
  })
  expect(h.sandbox.policies).toHaveLength(updates)
  h.sandbox.detachedCommands.get(execution.identity!.commandId!)!.exitCode = 0
  expect(await h.provider.buildExecution.observe!(execution.identity!)).toEqual({
    state: 'ended',
    exitCode: 0,
  })
  expect(h.sandbox.policies).toHaveLength(updates)
})

test('ChatGPT policies rotate and missing credentials are fenced without stopping other routes', async () => {
  const env: Record<string, string | undefined> = {
    CHATGPT_ACCESS: 'sentinel-chatgpt-first',
    ANTHROPIC_API_KEY: 'legacy-key',
    CLAUDE_ACCESS: 'sentinel-unaffected-claude',
  }
  const accounts = {
    plan: { kind: 'chatgpt-subscription', credentialEnv: 'CHATGPT_ACCESS' },
    claude: { kind: 'claude-subscription', credentialEnv: 'CLAUDE_ACCESS' },
  } as const
  const h = harness({ accounts: () => accounts, accountEnv: env })
  const workspace = await h.provider.provision({
    repo: '/repo',
    baseBranch: 'main',
    branch: 'ab/chatgpt',
  })
  h.sandbox.detachedWait = () => new Promise(() => undefined)
  const execution = await h.provider.buildExecution.start({
    slug: 'chatgpt',
    storeRef: 'https://store.example.test',
    instance: 'i',
    workspaceRef: workspace.ref,
  })
  expect(JSON.stringify(h.sandbox.commands)).not.toContain(env.CHATGPT_ACCESS!)
  const commands = h.sandbox.commands.length
  for (const token of ['sentinel-chatgpt-second', 'sentinel-chatgpt-third']) {
    env.CHATGPT_ACCESS = token
    expect(await h.provider.buildExecution.observe!(execution.identity!)).toEqual({
      state: 'running',
    })
    const policy = JSON.stringify(h.sandbox.policies.at(-1))
    expect(policy).toContain('api.openai.com')
    expect(policy).toContain(token)
    expect(policy).not.toContain('sentinel-chatgpt-first')
    expect(h.sandbox.commands.length).toBe(commands)
  }
  const stops = h.sandbox.stops
  delete env.CHATGPT_ACCESS
  const failed = await h.provider.buildExecution.observe!(execution.identity!)
  expect(failed.state).toBe('running')
  expect(failed.attention).toContain('plan')
  expect(failed.attention).toContain('ab accounts login')
  expect(h.sandbox.stops).toBe(stops)
  expect(JSON.stringify(h.sandbox.policies.at(-1))).not.toContain('sentinel-chatgpt-third')
  expect(JSON.stringify(h.sandbox.policies.at(-1))).toContain('sentinel-unaffected-claude')
})

describe('Vercel SDK cleanup facade', () => {
  const credentials = {
    VERCEL_TOKEN: 'host-only',
    VERCEL_TEAM_ID: 'team_test',
    VERCEL_PROJECT_ID: 'prj_test',
  }
  test.each([204, 404, 410])(
    'delete-by-name scopes the exact resource and acknowledges HTTP %s',
    async (status) => {
      const calls: { url: string; init?: RequestInit }[] = []
      const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return new Response(null, { status })
      }) as unknown as typeof globalThis.fetch
      const facade = createVercelSdkFacade(credentials, fetch)
      const signal = AbortSignal.timeout(5000)
      expect(await facade.deleteByName!('named/environment', signal)).toBe(
        status === 204 ? 'confirmed' : 'absent',
      )
      expect(calls).toHaveLength(1)
      const url = new URL(calls[0]!.url)
      expect(url.pathname).toBe('/api/v2/sandboxes/named%2Fenvironment')
      expect(url.searchParams.get('projectId')).toBe('prj_test')
      expect(url.searchParams.get('teamId')).toBe('team_test')
      expect(calls[0]!.init).toMatchObject({
        method: 'DELETE',
        signal,
        headers: { authorization: 'Bearer host-only' },
      })
    },
  )
  test.each([401, 403, 429, 500])(
    'delete errors at HTTP %s never prove absence',
    async (status) => {
      const facade = createVercelSdkFacade(
        credentials,
        (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch,
      )
      await expect(facade.deleteByName!('named')).rejects.toThrow(`HTTP ${status}`)
    },
  )
  test('transport failure never proves absence', async () => {
    const facade = createVercelSdkFacade(credentials, (async () => {
      throw new Error('network unavailable')
    }) as unknown as typeof globalThis.fetch)
    await expect(facade.deleteByName!('named')).rejects.toThrow('network unavailable')
  })
  test('snapshot unavailable preserves stale identity for cleanup while 404 is absent', async () => {
    let status = 410
    const facade = createVercelSdkFacade(
      credentials,
      (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: status === 410 ? 'snapshot_not_found' : 'not_found',
              message: 'missing',
            },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch,
    )
    const error = await facade.get('named').catch((error: unknown) => error)
    expect(isUnavailableVercelSnapshot(error)).toBe(true)
    status = 404
    expect(await facade.get('named')).toBeNull()
  })
})

test('preservation inspection failure restores scoped transport policy and retains every snapshot', async () => {
  const h = harness()
  const workspace = await h.provider.provision({
    repo: '/repo',
    baseBranch: 'main',
    branch: 'ab/remote-build',
  })
  expect(await h.provider.recovery.fence!(workspace)).toEqual({ outcome: 'confirmed' })
  const snapshots = h.sandbox.snapshots.map((snapshot) => snapshot.id)
  const previousPolicies = h.sandbox.policies.length
  h.sandbox.runCommand = async (input) => {
    expect(JSON.stringify(input)).not.toContain('forge-secret')
    throw new Error('inspection unavailable')
  }
  await expect(
    h.provider.publication.preserve!({
      ref: workspace.ref,
      slug: 'remote-build',
      branch: workspace.branch,
      base: SHA,
      candidates: [],
    }),
  ).rejects.toThrow('inspection unavailable')
  const policies = h.sandbox.policies.slice(previousPolicies)
  expect(JSON.stringify(policies[0])).toContain('receive')
  expect(JSON.stringify(policies.at(-1))).not.toContain('receive')
  expect(h.sandbox.deletes).toBe(0)
  expect(h.sandbox.snapshots.map((snapshot) => snapshot.id)).toEqual(
    expect.arrayContaining(snapshots),
  )
})

test('preservation of a VM without a checkout is absent and never runs git in it', async () => {
  const h = harness()
  const workspace = await h.provider.provision({
    repo: '/repo',
    baseBranch: 'main',
    branch: 'ab/remote-build',
  })
  expect(await h.provider.recovery.fence!(workspace)).toEqual({ outcome: 'confirmed' })
  h.sandbox.checkout = false
  const previousCommands = h.sandbox.commands.length
  const previousPolicies = h.sandbox.policies.length
  const stops = h.sandbox.stops
  expect(
    await h.provider.publication.preserve!({
      ref: workspace.ref,
      slug: 'remote-build',
      branch: workspace.branch,
      base: SHA,
      candidates: [],
    }),
  ).toEqual({ outcome: 'absent' })
  const commands = h.sandbox.commands.slice(previousCommands)
  expect(commands).toEqual([
    expect.objectContaining({ cmd: 'test', args: ['-e', `${VERCEL_WORKSPACE_PATH}/.git`] }),
  ])
  expect(commands.some((command) => command.cwd !== undefined)).toBe(false)
  expect(JSON.stringify(h.sandbox.policies.slice(previousPolicies).at(-1))).not.toContain('receive')
  expect(h.sandbox.stops).toBeGreaterThan(stops)
  expect(h.sandbox.deletes).toBe(0)
})

for (const probe of ['exit 2', 'no exit code', 'thrown'] as const)
  test(`preservation rejects when the checkout probe is inconclusive (${probe})`, async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(await h.provider.recovery.fence!(workspace)).toEqual({ outcome: 'confirmed' })
    const snapshots = h.sandbox.snapshots.map((snapshot) => snapshot.id)
    const run = h.sandbox.runCommand.bind(h.sandbox)
    h.sandbox.runCommand = async (input) => {
      if (
        input.cmd === 'test' &&
        (input.args as string[] | undefined)?.[1] === `${VERCEL_WORKSPACE_PATH}/.git`
      ) {
        if (probe === 'thrown') throw new Error('probe unavailable')
        return { exitCode: probe === 'exit 2' ? 2 : (null as unknown as number) }
      }
      return run(input)
    }
    await expect(
      h.provider.publication.preserve!({
        ref: workspace.ref,
        slug: 'remote-build',
        branch: workspace.branch,
        base: SHA,
        candidates: [],
      }),
    ).rejects.toThrow(probe === 'thrown' ? 'probe unavailable' : 'could not confirm the checkout')
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.snapshots.map((snapshot) => snapshot.id)).toEqual(
      expect.arrayContaining(snapshots),
    )
  })

test('fencing rechecks the provider and never purges snapshots on unknown outcome', async () => {
  let unavailable = false
  let gets = 0
  const sandbox = new FakeSandbox()
  const h = harness({
    facadeGet: async () => {
      gets++
      if (unavailable) throw new Error('provider unavailable')
      return sandbox
    },
  })
  const handle = {
    provider: 'vercel-sandbox',
    ref: 'existing',
    path: VERCEL_WORKSPACE_PATH,
    branch: 'ab/remote-build',
  }
  expect(await h.provider.recovery.fence!(handle)).toEqual({ outcome: 'confirmed' })
  unavailable = true
  expect(await h.provider.recovery.fence!(handle)).toMatchObject({
    outcome: 'unknown',
    error: 'provider unavailable',
  })
  expect(gets).toBe(2)
  expect(sandbox.deletes).toBe(0)
  expect(sandbox.snapshots).toHaveLength(1)
})

test('absent filesystem fencing permits authorized stale-name deletion', async () => {
  const h = harness({
    facadeGet: async () => {
      throw { response: { status: 410 }, json: { error: { code: 'snapshot_not_found' } } }
    },
  })
  const handle = {
    provider: 'vercel-sandbox',
    ref: 'snapshot-gone',
    path: VERCEL_WORKSPACE_PATH,
    branch: 'ab/remote-build',
  }
  expect(await h.provider.recovery.fence!(handle)).toEqual({ outcome: 'absent' })
  expect(h.sandbox.deletes).toBe(0)
  expect(await h.provider.recovery.reap(handle)).toMatchObject({ outcome: 'absent' })
  expect(h.sandbox.deletes).toBe(1)
})

/** A guest-side origin that refuses (or accepts) archive pushes; the returned
 * `refs` map is what the guest's `ls-remote` reads back. */
function scriptGuestRemote(
  h: ReturnType<typeof harness>,
  options: { refuseArchive: boolean; refs?: Map<string, string>; head?: string },
) {
  const refs = options.refs ?? new Map<string, string>()
  const original = h.sandbox.runCommand.bind(h.sandbox)
  h.sandbox.runCommand = async (params) => {
    if (params.cmd !== 'git') return original(params)
    h.sandbox.commands.push(params)
    const args = params.args as string[]
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1)!
      const sha = refs.get(ref)
      if (sha !== undefined) stdout = `${sha}\t${ref}\n`
    } else if (args[0] === 'push') {
      const [sha, ref] = args.at(-1)!.split(':')
      if (options.refuseArchive && ref!.startsWith('refs/autobuild/archive/')) {
        exitCode = 1
        stderr = `! [remote rejected] ${sha}:${ref} (refusing non-branch push)\n`
      } else refs.set(ref!, sha!)
    } else if (args[0] === 'rev-parse') stdout = `${options.head ?? SHA}\n`
    else if (args[0] === 'rev-list') stdout = `${options.head ?? SHA}\n`
    return { exitCode, stdout: async () => stdout, stderr: async () => stderr }
  }
  return refs
}

describe('refused guest archive pushes', () => {
  const archiveRef = `refs/autobuild/archive/remote-build/${SHA}`
  async function fenced(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options)
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(await h.provider.recovery.fence!(workspace)).toEqual({ outcome: 'confirmed' })
    return { h, workspace }
  }
  const recover = (h: ReturnType<typeof harness>, ref: string) =>
    h.provider.publication.recoverCandidate!({
      ref,
      slug: 'remote-build',
      branch: 'ab/remote-build',
      sha: SHA,
    })
  const pushes = (h: ReturnType<typeof harness>) =>
    h.sandbox.commands.filter(
      (command) => command.cmd === 'git' && (command.args as string[])[0] === 'push',
    )

  test.each([
    ['without a fallback', undefined],
    ['with an acknowledged fallback the readback cannot confirm', async () => {}],
  ])(
    'recovery %s reports the candidate available after a refused archive push, with no archive',
    async (_name, refusedArchive) => {
      const { h, workspace } = await fenced({ refusedArchive })
      const refs = scriptGuestRemote(h, { refuseArchive: true })
      // Archive refs are best effort: the settlement rewrite retains it.
      expect(await recover(h, workspace.ref)).toBe(true)
      expect(refs.has(archiveRef)).toBe(false)
    },
  )

  test('recovery publishes through git without calling the fallback', async () => {
    const calls: string[][] = []
    const { h, workspace } = await fenced({
      refusedArchive: async (ref, sha) => {
        calls.push([ref, sha])
      },
    })
    const refs = scriptGuestRemote(h, { refuseArchive: false })
    expect(await recover(h, workspace.ref)).toBe(true)
    expect(refs.get(archiveRef)).toBe(SHA)
    expect(calls).toEqual([])
  })

  test('recovery falls back after a refused push and proves the archive by readback', async () => {
    const refs = new Map<string, string>()
    const calls: string[][] = []
    const { h, workspace } = await fenced({
      refusedArchive: async (ref, sha) => {
        calls.push([ref, sha])
        refs.set(ref, sha)
      },
    })
    scriptGuestRemote(h, { refuseArchive: true, refs })
    expect(await recover(h, workspace.ref)).toBe(true)
    expect(calls).toEqual([[archiveRef, SHA]])
    expect(pushes(h)).toHaveLength(1)
    expect(h.sandbox.commands).toContainEqual(
      expect.objectContaining({
        cmd: 'git',
        args: ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', archiveRef],
      }),
    )
  })

  test('a failed fallback still reports recovery, keeps snapshots, and a retry archives', async () => {
    const refs = new Map<string, string>()
    let fail = true
    const { h, workspace } = await fenced({
      refusedArchive: async (ref, sha) => {
        if (fail) throw new Error('GitHub API 403 Resource not accessible')
        refs.set(ref, sha)
      },
    })
    scriptGuestRemote(h, { refuseArchive: true, refs })
    const snapshots = h.sandbox.snapshots.map((snapshot) => snapshot.id)
    const stops = h.sandbox.stops
    const policies = h.sandbox.policies.length
    expect(await recover(h, workspace.ref)).toBe(true)
    expect(refs.has(archiveRef)).toBe(false)
    expect(JSON.stringify(h.sandbox.policies.at(-1))).not.toContain('receive')
    expect(h.sandbox.policies.length).toBeGreaterThan(policies)
    expect(h.sandbox.stops).toBeGreaterThan(stops)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.snapshots.map((snapshot) => snapshot.id)).toEqual(
      expect.arrayContaining(snapshots),
    )

    fail = false
    expect(await recover(h, workspace.ref)).toBe(true)
    expect(refs.get(archiveRef)).toBe(SHA)
  })

  test('preservation archives through the fallback after a refused push', async () => {
    const refs = new Map<string, string>()
    const calls: string[][] = []
    const { h, workspace } = await fenced({
      refusedArchive: async (ref, sha) => {
        calls.push([ref, sha])
        refs.set(ref, sha)
      },
    })
    scriptGuestRemote(h, { refuseArchive: true, refs })
    const base = 'b'.repeat(40)
    const preserved = await h.provider.publication.preserve!({
      ref: workspace.ref,
      slug: 'remote-build',
      branch: workspace.branch,
      base,
      candidates: [],
    })
    expect(preserved).toMatchObject({
      outcome: 'preserved',
      heads: [{ sha: SHA, remoteRef: archiveRef }],
    })
    expect(calls).toEqual([[archiveRef, SHA]])
  })

  test('preservation keeps a store copy once the guest push and the host fallback both refuse', async () => {
    const { h, workspace } = await fenced({
      refusedArchive: async () => {
        throw new Error('GitHub API 403 Resource not accessible')
      },
    })
    const refs = scriptGuestRemote(h, { refuseArchive: true })
    const base = 'b'.repeat(40)
    const retained: { sha: string; base: string; workspacePath: string }[] = []
    const saved = 'd'.repeat(40)
    const preserved = await h.provider.publication.preserve!({
      ref: workspace.ref,
      slug: 'remote-build',
      branch: workspace.branch,
      base,
      candidates: [],
      retain: async ({ exec, sha, base, workspacePath }) => {
        // The trusted transport runs in the guest checkout, credential-free.
        expect((await exec(['git', 'rev-parse', 'HEAD'], { cwd: workspacePath })).exitCode).toBe(0)
        retained.push({ sha, base, workspacePath })
        return saved
      },
    })
    // The receipt records the copy's actual base, whatever base was asked for.
    expect(preserved).toEqual({
      outcome: 'preserved',
      heads: [{ sha: SHA, role: 'branch', commits: [SHA], storeBase: saved }],
    })
    expect(retained).toEqual([
      { sha: SHA, base: expect.any(String), workspacePath: VERCEL_WORKSPACE_PATH },
    ])
    expect(refs.has(archiveRef)).toBe(false)
  })

  test('provisioning restores a store-kept head through the dispatcher callback', async () => {
    const h = harness()
    let present = false
    const original = h.sandbox.runCommand.bind(h.sandbox)
    const output = (exitCode: number, stdout = '') => ({
      exitCode,
      stdout: async () => stdout,
      stderr: async () => (exitCode === 0 ? '' : 'missing'),
    })
    h.sandbox.runCommand = async (params) => {
      const args = (params.args ?? []) as string[]
      if (params.cmd === 'git' && args[0] === 'cat-file') return output(present ? 0 : 1)
      if (
        params.cmd === 'git' &&
        args.join(' ') === 'rev-parse --verify refs/heads/ab/remote-build^{commit}'
      )
        return output(0, `${SHA}\n`)
      return original(params)
    }
    const asked: string[] = []
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
      restoration: [{ sha: SHA, role: 'producer', commits: [SHA], storeBase: 'b'.repeat(40) }],
      restoreStored: async ({ sha, workspacePath }) => {
        expect(workspacePath).toBe(VERCEL_WORKSPACE_PATH)
        asked.push(sha)
        present = true
        return true
      },
    })
    expect(asked).toEqual([SHA])
  })

  test('a restack rewrite archives through the fallback before replacing the branch', async () => {
    const old = 'c'.repeat(40)
    const archive = `refs/autobuild/archive/remote-build/${old}`
    const refs = new Map<string, string>([['refs/heads/ab/remote-build', old]])
    const calls: string[][] = []
    const h = harness({
      refusedArchive: async (ref, sha) => {
        calls.push([ref, sha])
        refs.set(ref, sha)
      },
    })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    scriptGuestRemote(h, { refuseArchive: true, refs, head: old })
    expect(
      await h.provider.publication.rewrite!({
        ref: workspace.ref,
        sha: SHA,
        branch: workspace.branch,
        expected: old,
        archives: [{ ref: archive, sha: old }],
      }),
    ).toEqual({ kind: 'published' })
    expect(calls).toEqual([[archive, old]])
    expect(refs.get('refs/heads/ab/remote-build')).toBe(SHA)
  })

  test('a supplied retain callback replaces the strict archive and the rewrite proceeds', async () => {
    const old = 'c'.repeat(40)
    const archive = `refs/autobuild/archive/remote-build/${old}`
    const refs = new Map<string, string>([['refs/heads/ab/remote-build', old]])
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    scriptGuestRemote(h, { refuseArchive: true, refs, head: old })
    const retained: { ref: string; sha: string; workspacePath: string; refused: boolean }[] = []
    expect(
      await h.provider.publication.rewrite!({
        ref: workspace.ref,
        sha: SHA,
        branch: workspace.branch,
        expected: old,
        archives: [{ ref: archive, sha: old }],
        retain: async (input) => {
          // The trusted transport is handed over; the callback owns refusals.
          const refused = await input
            .archive({ workspacePath: input.workspacePath, ref: input.ref, sha: input.sha })
            .then(
              () => false,
              () => true,
            )
          retained.push({
            ref: input.ref,
            sha: input.sha,
            workspacePath: input.workspacePath,
            refused,
          })
        },
      }),
    ).toEqual({ kind: 'published' })
    expect(retained).toEqual([
      { ref: archive, sha: old, workspacePath: expect.any(String), refused: true },
    ])
    expect(refs.has(archive)).toBe(false)
    expect(refs.get('refs/heads/ab/remote-build')).toBe(SHA)
  })
})

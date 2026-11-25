/**
 * The operator sandbox service (AUT-340): the single validation,
 * serialization, journaling, and typed-error point behind the registry's
 * `sandbox.*` tools. The registry hands it only the caller's attributed
 * identity plus the tool input; the service owns every journal append and
 * derives lifecycle state from the repository journal (`sandboxStates`), so
 * a later dispatcher invocation can settle what this process left behind.
 *
 * Lifecycle (#1223, #1246): `open` returns promptly. Provisioning or
 * resuming runs as a background attempt the provider owns; the service
 * journals `provisioning` when it starts and `provisioned`/`resumed` or
 * `provision-failed` once the attempt's outcome is known — from its `settled`
 * promise in this process, or from a provider probe in any process (`status`,
 * `open`, the gate). Every settlement goes through `settleOnce`, a bounded
 * loop over the repository journal's compare-and-append
 * (`appendRepoIfCurrent`), so an outcome is recorded exactly once even when
 * several processes observe it. Every other tool passes a journal gate: it
 * proceeds only on a `live` environment and otherwise refuses typed
 * `not-ready` naming the state. Nothing but `open` (and `reset`, which reuses
 * it) ever starts provisioning.
 *
 * Failure evidence in the provider is destroyed only after the journal
 * authoritatively records that failure: `open` probes first and, when the
 * provider reports `failed`, records it (`recordFailure`) before calling the
 * provider's `open`, which may reap the failed environment. A provisioning
 * attempt that died before its environment existed is failed by the orphan
 * rule once its grace period passes.
 *
 * Credential freeness is structural upstream (the providers build guest
 * environments from empty records); redaction here keeps credential VALUES
 * out of typed error messages that travel to tool callers.
 */
import { createHash } from 'node:crypto'
import { humanActor } from '../events/envelope'
import type { Via } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import type { Forge } from '../ports/types'
import {
  redactSandboxMessage,
  SandboxOperationError,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxLifecycleState,
  type SandboxProviderStatus,
  type SandboxProvisionStage,
  type SandboxWaitResult,
} from '../ports/workspace/operator-sandbox'
import type { WorkspaceProvider } from '../ports/types'
import type { SandboxEnvironmentSnapshot } from '../processes/sandbox-state'
import { readRepositoryFacts, type RepositoryReadFacts } from '../store/reduced-reads'
import { systemClock, type BuildStore, type Clock } from '../store/types'

export { redactSandboxMessage }

/** Hard bound on one sandbox command wait, in seconds — shared with the
 * adapters (`SANDBOX_MAX_WAIT_SECONDS`). */
export const SANDBOX_EXEC_MAX_SECONDS = 300
/** Per-stream truncation bound for tool-returned output. */
export const SANDBOX_OUTPUT_LIMIT_BYTES = 65_536
export const SANDBOX_TRUNCATION_MARKER = '[truncated by autobuild: output exceeded 65536 bytes]'
/** Maximum `write_file` content size. */
export const SANDBOX_WRITE_LIMIT_BYTES = 1_048_576
/** Minimum journal interval between two `orchestrator.sandbox.activity`
 * facts for one environment. */
export const SANDBOX_ACTIVITY_INTERVAL_MS = 60_000
/** Bounded compare-and-append attempts of one settlement. A miss means the
 * journal advanced (often through unrelated facts); exhausting them leaves
 * the outcome in the provider for the next poll. */
export const SANDBOX_SETTLE_ATTEMPTS = 5
/** Grace after the latest evidence of a `provisioning` journal whose
 * provider reports no environment and no attempt runs in this process,
 * before the orphan rule fails it. */
export const SANDBOX_PROVISION_ORPHAN_MS = 120_000
/** The orphan rule's recorded failure message. */
export const SANDBOX_ORPHAN_MESSAGE =
  'the provisioning attempt ended before its environment was created; call sandbox.open to retry'
/** `open`'s refusal when it could not record a failed environment before
 * replacing it. */
export const SANDBOX_UNRECORDED_FAILURE_MESSAGE =
  "could not record the previous attempt's failure; nothing was discarded; call sandbox.open again"
/** Delays between the background settle handler's retries of a failing
 * settlement (store errors only). */
const SETTLE_RETRY_DELAYS_MS = [500, 2_000, 2_000] as const

/** Truncate one output stream to the byte bound, head-kept, with the
 * documented marker appended past the bound. Exactly-at-bound output is
 * returned unmodified. */
export function truncateSandboxOutput(output: string): string {
  const bytes = Buffer.from(output, 'utf8')
  if (bytes.length <= SANDBOX_OUTPUT_LIMIT_BYTES) return output
  const head = bytes.subarray(0, SANDBOX_OUTPUT_LIMIT_BYTES).toString('utf8')
  // Drop a possibly split trailing code unit so the marker rides on valid text.
  const repaired =
    head.length > 0 && Buffer.from(head, 'utf8').length > SANDBOX_OUTPUT_LIMIT_BYTES
      ? head.slice(0, -1)
      : head
  return `${repaired}\n${SANDBOX_TRUNCATION_MARKER}`
}

/** Pure lexical sandbox-path check: reject absolute paths, empty components,
 * and any `..` after normalization. Not a sandbox boundary — the credential
 * free rule bounds what a guest escape could reach — but it keeps tool file
 * paths inside the checkout. */
export function resolveSandboxRelativePath(path: string): string {
  if (path.length === 0) {
    throw new SandboxOperationError('exec', 'sandbox path must be nonempty')
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new SandboxOperationError(
      'exec',
      `sandbox path ${JSON.stringify(path)} must be relative to the checkout`,
    )
  }
  if (path.includes('\\')) {
    throw new SandboxOperationError(
      'exec',
      `sandbox path ${JSON.stringify(path)} must use "/" separators`,
    )
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new SandboxOperationError(
          'exec',
          `sandbox path ${JSON.stringify(path)} escapes the checkout`,
        )
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    throw new SandboxOperationError('exec', `sandbox path ${JSON.stringify(path)} names no file`)
  }
  return segments.join('/')
}

function describeError(error: unknown): string {
  return redactSandboxMessage(error instanceof Error ? error.message : String(error))
}

/** The canonical publication branch grammar every provider adapter enforces. */
const PUBLICATION_BRANCH_PATTERN = /^ab\/[a-z0-9][a-z0-9-]*$/

/** Deterministic PR branch name for one operator × repository:
 * `ab/orch-<operator-slug>-<hash8>` where hash8 is the first 8 hex chars of
 * sha256(`<repo>\0<operator>`) and the slug is the operator lowercased with
 * non-`[a-z0-9]` runs collapsed to `-` and trimmed. One operator always maps
 * to one branch per repository, so a later publish updates the same PR's
 * head. An identity with no `[a-z0-9]` characters yields `ab/orch--<hash8>`,
 * which still matches the canonical grammar — no fallback token. */
export function sandboxPublicationBranch(repo: string, operator: string): string {
  const slug = operator
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const hash8 = createHash('sha256').update(`${repo}\0${operator}`).digest('hex').slice(0, 8)
  const branch = `ab/orch-${slug}-${hash8}`
  if (!PUBLICATION_BRANCH_PATTERN.test(branch)) {
    throw new SandboxOperationError(
      'publish',
      `derived publication branch ${JSON.stringify(branch)} is not a canonical branch name`,
    )
  }
  return branch
}

export interface OperatorSandboxConfig {
  idleMinutes: number
  environmentVariables: readonly string[]
}

/** What `sandbox.open` (and `reset`) report: the environment's lifecycle
 * state right after the call, the base head once ready, and the failure
 * when a background attempt failed. */
export interface SandboxOpenResult {
  state: SandboxLifecycleState
  environmentId: string
  provider: string
  baseSha?: string
  failure?: { stage: SandboxProvisionStage; message: string }
}

/** What `sandbox.status` reports: the open result plus the checkout head and
 * the latest journaled evidence time. */
export interface SandboxStatusResult extends SandboxOpenResult {
  headSha?: string
  lastEvidenceAt?: string
}

export interface OperatorSandboxService {
  /** Dispose local composition resources only; separate from release(identity, repo).
   * Caller-owned static services retain their lifetime across requests. */
  dispose?(): Promise<void>
  /** True when both a forge and the provider's sandbox publication
   * capability are present, i.e. `publish` is callable. */
  readonly canPublish: boolean
  /** Open the caller's environment and return at once. A fresh provision or
   * a resume continues in the background of this process; poll `status`. */
  open(identity: string, input: { repo: string }): Promise<SandboxOpenResult>
  /** Bounded poll: one reduced repository read plus one provider probe. Its
   * only write records a finished background attempt's outcome, exactly once
   * across processes, through the repository compare-and-append; it never
   * resumes or extends an idle environment. */
  status(identity: string, input: { repo: string }): Promise<SandboxStatusResult>
  /** Stop the environment and release its capacity, keeping the checkout; a
   * later `open` resumes it. Cancels an in-flight attempt. `noop` when there
   * is nothing to close. */
  close(
    identity: string,
    input: { repo: string },
  ): Promise<{ outcome: 'closed' | 'noop'; environmentId: string }>
  /** Fast-forward a clean checkout to the current base-branch head. Refuses a
   * dirty (`refresh-dirty`) or diverged (`refresh-diverged`) checkout and
   * changes nothing then. */
  refresh(
    identity: string,
    input: { repo: string },
  ): Promise<{
    outcome: 'refreshed' | 'current'
    headSha: string
    baseSha: string
    previousHeadSha: string
  }>
  /** Resolves once no background attempt for the operator is in flight in
   * this process. For tests and orderly shutdown. */
  settled(identity: string): Promise<void>
  exec(
    identity: string,
    input: { repo: string; command: string; cwd?: string; timeoutSeconds?: number },
  ): Promise<SandboxCommandResult>
  start(
    identity: string,
    input: { repo: string; command: string; cwd?: string },
  ): Promise<{ commandId: string }>
  wait(
    identity: string,
    input: { repo: string; commandId: string; waitSeconds: number },
  ): Promise<SandboxWaitResult>
  readFile(identity: string, input: { repo: string; path: string }): Promise<Uint8Array>
  writeFile(
    identity: string,
    input: { repo: string; path: string; content: string; encoding: 'utf8' | 'base64' },
  ): Promise<void>
  /** Destructive: journal `reset`, full teardown + snapshot purge, then a
   * fresh provision from the CURRENT base head, started in the background
   * like `open`; returns the open result. */
  reset(identity: string, input: { repo: string }): Promise<SandboxOpenResult>
  /** PR-only publication (AUT-343): push the sandbox checkout's head (or an
   * explicit commit) to a deterministic operator branch and open or update
   * the PR against the base branch. The base branch itself is never pushed
   * to; the sandbox performs no push and receives no credential. */
  publish(
    identity: string,
    input: {
      repo: string
      title: string
      body?: string
      commit?: string
      via?: Via
    },
  ): Promise<{ branch: string; sha: string; pr: { number: number; url: string; headSha: string } }>
  /** Full teardown + snapshot purge of the operator's environment, without
   * provisioning. A no-op when the journal shows no environment. Used by
   * `reset` and the session-archive hook. */
  release(identity: string, input: { repo: string }): Promise<void>
}

export interface OperatorSandboxServiceOptions {
  store: BuildStore
  repo: string
  provider: WorkspaceProvider
  sandbox: OperatorSandboxConfig
  /** The binding's parsed `[baseBranch]`: reset always provisions from this
   * branch's current head. A hot baseBranch reload is picked up when the
   * `ab mcp` process restarts. */
  baseBranch: string
  /** The forge used to open or update the PR. Absent = publication is
   * unavailable and the service reports `canPublish: false`. */
  forge?: Forge
  clock?: Clock
  capability?: WorkspaceProvider['orchestratorSandbox']
  /** Receives a background attempt's journal-append failure. The outcome is
   * retained and flushed before the next mutating call either way. */
  report?: (error: unknown) => void
  /** Hosted background seam (`waitUntil`, Next's `after()`): receives each
   * attached attempt's settle promise so the serving function stays alive
   * for the provider's host phase and its settlement. A throwing seam is
   * reported and never fails `open`. */
  background?: (work: Promise<unknown>) => void
  /** Test seam for the settle handler's retry delays. */
  sleep?: (ms: number) => Promise<void>
}

export async function createOperatorSandboxService(
  options: OperatorSandboxServiceOptions,
): Promise<OperatorSandboxService> {
  const store = options.store
  const repo = options.repo
  const provider = options.provider
  const capability = options.capability ?? provider.orchestratorSandbox
  if (capability === undefined) {
    throw new Error(
      `workspace provider "${provider.name}" cannot host operator sandboxes; sandbox tools are unavailable`,
    )
  }
  const clock = options.clock ?? systemClock
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const canPublish = options.forge !== undefined && provider.sandboxPublication !== undefined
  await store.ensureRepo(repo)

  /** Per-environment serialization: one in-process promise chain keyed by
   * (repo, operator) — equivalent to keying by environment because the
   * mapping is 1:1 — so calls against one environment serialize. */
  const chains = new Map<string, Promise<unknown>>()
  const serialize = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    chains.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  const append = async (
    identity: string,
    type:
      | 'orchestrator.sandbox.provisioned'
      | 'orchestrator.sandbox.resumed'
      | 'orchestrator.sandbox.activity'
      | 'orchestrator.sandbox.released'
      | 'orchestrator.sandbox.reset'
      | 'orchestrator.sandbox.published'
      | 'orchestrator.sandbox.publish-failed'
      | 'orchestrator.sandbox.provisioning'
      | 'orchestrator.sandbox.provision-failed'
      | 'orchestrator.sandbox.closed'
      | 'orchestrator.sandbox.refreshed',
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await store.appendRepo(repo, {
      actor: humanActor(identity),
      type,
      payload: payload as never,
    })
  }

  /** The operator's journal state, or undefined when no environment exists. */
  const operatorState = (
    identity: string,
    events: RepositoryReadFacts,
  ): SandboxEnvironmentSnapshot | undefined =>
    events.sandboxes
      .filter((state) => state.operator === identity && state.state !== 'released')
      .at(-1)

  const keyOf = (identity: string): string => `${repo}\0${identity}`
  const readFacts = async (): Promise<RepositoryReadFacts> =>
    (await readRepositoryFacts(store, repo)).value

  /** One background attempt this process attached a settle handler to.
   * `source` is the provider's `settled` promise, so concurrent opens of one
   * attempt attach once; `cancelled` is set by close/reset/release before the
   * provider call so the queued handler drops the outcome. */
  interface BackgroundEntry {
    token: number
    cancelled: boolean
    source: Promise<SandboxProviderStatus>
    promise: Promise<void>
  }
  const background = new Map<string, BackgroundEntry>()
  let nextToken = 0
  /** Outcomes whose append failed, flushed before the next mutating call and
   * deleted only once appended. */
  const unjournaled = new Map<string, { environmentId: string; outcome: SandboxProviderStatus }>()

  const requireLifecycle = (): void => {
    if (!capability.lifecycleSupported) {
      throw new SandboxOperationError(
        'unsupported',
        `workspace provider "${provider.name}" does not implement the operator sandbox lifecycle (open/status/close/refresh)`,
      )
    }
  }

  const notReady = (state: SandboxLifecycleState): SandboxOperationError =>
    new SandboxOperationError(
      'not-ready',
      state === 'provisioning' || state === 'resuming'
        ? `operator sandbox is ${state}; poll sandbox.status until it reports ready`
        : `operator sandbox is ${state}; call sandbox.open and poll sandbox.status until it reports ready`,
      { state },
    )

  const probe = async (identity: string): Promise<SandboxProviderStatus> =>
    capability.status({ repo, operator: identity }).catch((error: unknown) => {
      if (error instanceof SandboxOperationError) throw error
      throw new SandboxOperationError('exec', describeError(error), { cause: error })
    })

  type SettleResult = 'appended' | 'settled-elsewhere' | 'nothing' | 'contended'

  /** The fact that settles one attempt against a `provisioning` snapshot, or
   * undefined for an in-flight or cancelled outcome (its closer journals).
   * The fact kind comes from the journal's `pendingKind`, never from the
   * provider; the base head from the provider's handle. */
  const settlementFact = (
    identity: string,
    state: SandboxEnvironmentSnapshot,
    outcome: SandboxProviderStatus,
    handle: SandboxEnvironmentIdentity | undefined,
  ): RepositoryEventWrite | undefined => {
    const actor = humanActor(identity)
    if (outcome.state === 'ready' && handle !== undefined) {
      if (state.pendingKind === 'provision') {
        return {
          actor,
          type: 'orchestrator.sandbox.provisioned',
          payload: {
            operator: identity,
            environmentId: state.environmentId,
            provider: handle.provider,
            ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
            workspacePath: handle.workspacePath,
            ...(handle.baseSha !== undefined ? { baseSha: handle.baseSha } : {}),
          },
        }
      }
      return {
        actor,
        type: 'orchestrator.sandbox.resumed',
        payload: {
          operator: identity,
          environmentId: state.environmentId,
          provider: handle.provider,
          ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
        },
      }
    }
    if (outcome.state === 'absent' && outcome.cancelled === true) return undefined
    if (outcome.state === 'provisioning' || outcome.state === 'resuming') return undefined
    return failureFact(identity, state.environmentId, outcome)
  }

  const failureFact = (
    identity: string,
    environmentId: string,
    outcome: SandboxProviderStatus,
  ): RepositoryEventWrite => {
    const failure = outcome.failure ?? {
      stage: 'provision' as const,
      message: `the provider reported the environment ${outcome.state} when the attempt settled`,
    }
    return {
      actor: humanActor(identity),
      type: 'orchestrator.sandbox.provision-failed',
      payload: {
        operator: identity,
        environmentId,
        stage: failure.stage,
        message: redactSandboxMessage(failure.message) || 'provisioning failed',
      },
    }
  }

  /** Record one attempt's outcome exactly once across processes: append the
   * settling fact only while the journal still says `provisioning` for
   * `environmentId`, and only at the sequence just read. A miss re-reads and
   * re-checks, a bounded number of times; another process's settlement ends
   * the loop with nothing appended. Never falls back to an unconditional
   * append. */
  const settleOnce = async (
    identity: string,
    environmentId: string,
    outcome: SandboxProviderStatus,
    first?: { cursor: number; value: RepositoryReadFacts },
  ): Promise<SettleResult> => {
    let handle: SandboxEnvironmentIdentity | undefined
    let read = first
    for (let attempt = 0; attempt < SANDBOX_SETTLE_ATTEMPTS; attempt += 1) {
      const { cursor, value } = read ?? (await readRepositoryFacts(store, repo))
      read = undefined
      const state = operatorState(identity, value)
      if (state?.state !== 'provisioning' || state.environmentId !== environmentId) {
        return 'settled-elsewhere'
      }
      if (outcome.state === 'ready' && handle === undefined) {
        handle = outcome.handle ?? (await capability.describe({ repo, operator: identity }))
      }
      const fact = settlementFact(identity, state, outcome, handle)
      if (fact === undefined) return 'nothing'
      if ((await store.appendRepoIfCurrent(repo, cursor, fact)) !== null) return 'appended'
    }
    return 'contended'
  }

  /** Make the journal authoritatively record a failure the provider reports,
   * before anything may discard its evidence. `already-recorded` means an
   * authoritative read shows this environment `failed`; a journal that never
   * saw the attempt (absent or released) first gains its `provisioning` fact.
   * Each append is conditional. */
  const recordFailure = async (
    identity: string,
    environmentId: string,
    provider: string,
    outcome: SandboxProviderStatus,
  ): Promise<'appended' | 'already-recorded' | 'contended'> => {
    for (let attempt = 0; attempt < SANDBOX_SETTLE_ATTEMPTS; attempt += 1) {
      const { cursor, value } = await readRepositoryFacts(store, repo)
      const state = operatorState(identity, value)
      if (state?.environmentId === environmentId && state.state === 'failed') {
        return 'already-recorded'
      }
      if (state === undefined || state.environmentId !== environmentId) {
        await store.appendRepoIfCurrent(repo, cursor, {
          actor: humanActor(identity),
          type: 'orchestrator.sandbox.provisioning',
          payload: { operator: identity, environmentId, provider, kind: 'provision' },
        })
        continue
      }
      const fact = failureFact(identity, environmentId, outcome)
      if ((await store.appendRepoIfCurrent(repo, cursor, fact)) !== null) return 'appended'
    }
    return 'contended'
  }

  /** The orphan rule's precondition: a `provisioning` journal whose provider
   * reports no environment, with no attempt in this process, past the grace
   * after its latest evidence. */
  const orphaned = (
    identity: string,
    state: SandboxEnvironmentSnapshot | undefined,
    providerStatus: SandboxProviderStatus,
  ): boolean => {
    if (state?.state !== 'provisioning' || providerStatus.state !== 'absent') return false
    if (background.has(keyOf(identity))) return false
    const last = Date.parse(state.lastEvidenceTs)
    return Number.isFinite(last) && clock().getTime() - last > SANDBOX_PROVISION_ORPHAN_MS
  }
  const orphanOutcome: SandboxProviderStatus = {
    state: 'failed',
    failure: { stage: 'checkout', message: SANDBOX_ORPHAN_MESSAGE },
  }

  /** Append an outcome whose earlier append failed, before anything else on
   * a mutating path. A no-op (no store read) when nothing is retained. */
  const flushUnjournaled = async (
    identity: string,
    facts: RepositoryReadFacts,
  ): Promise<RepositoryReadFacts> => {
    const key = keyOf(identity)
    const entry = unjournaled.get(key)
    if (entry === undefined) return facts
    const state = operatorState(identity, facts)
    if (
      state === undefined ||
      state.state !== 'provisioning' ||
      state.environmentId !== entry.environmentId
    ) {
      // The journal moved on (closed, released, or a newer attempt).
      unjournaled.delete(key)
      return facts
    }
    let result: SettleResult
    try {
      result = await settleOnce(identity, entry.environmentId, entry.outcome)
    } catch (error) {
      throw new SandboxOperationError(
        'provision',
        `could not journal the previous provisioning outcome: ${describeError(error)}`,
        { cause: error },
      )
    }
    if (result === 'contended') {
      throw new SandboxOperationError(
        'provision',
        'could not journal the previous provisioning outcome: the repository journal kept advancing; retry',
      )
    }
    unjournaled.delete(key)
    return readFacts()
  }

  /** The settle handler of one attached attempt, run on the serialize chain
   * so it orders after in-flight calls. It settles only while its entry is
   * current and uncancelled; a store failure is retried a bounded number of
   * times inside the attached promise (and so inside a hosted background
   * window) before the outcome is retained for the next mutating call. */
  const onSettled = async (
    identity: string,
    entry: BackgroundEntry,
    environmentId: string,
    outcome: SandboxProviderStatus,
  ): Promise<void> => {
    const key = keyOf(identity)
    for (let attempt = 0; ; attempt += 1) {
      if (background.get(key) !== entry || entry.cancelled) return
      let result: SettleResult
      try {
        result = await settleOnce(identity, environmentId, outcome)
      } catch (error) {
        const delay = SETTLE_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) {
          unjournaled.set(key, { environmentId, outcome })
          throw error
        }
        await sleep(delay)
        continue
      }
      if (result === 'contended') {
        // The evidence stays in the provider; the next poll settles it.
        unjournaled.set(key, { environmentId, outcome })
        throw new Error(
          'could not journal the attempt outcome: the repository journal kept advancing',
        )
      }
      return
    }
  }

  const attach = (
    identity: string,
    environmentId: string,
    settled: Promise<SandboxProviderStatus>,
  ): void => {
    const key = keyOf(identity)
    const entry: BackgroundEntry = {
      token: ++nextToken,
      cancelled: false,
      source: settled,
      promise: Promise.resolve(),
    }
    entry.promise = settled
      .then((outcome) => serialize(key, () => onSettled(identity, entry, environmentId, outcome)))
      .catch((error: unknown) => {
        options.report?.(error)
      })
      .finally(() => {
        if (background.get(key)?.token === entry.token) background.delete(key)
      })
    background.set(key, entry)
    try {
      options.background?.(entry.promise)
    } catch (error) {
      options.report?.(error)
    }
  }

  /** Mark any in-flight attempt cancelled before a provider teardown call. */
  const cancelBackground = (identity: string): boolean => {
    const entry = background.get(keyOf(identity))
    if (entry === undefined || entry.cancelled) return false
    entry.cancelled = true
    return true
  }

  const openReport = async (
    identity: string,
    status: SandboxProviderStatus,
    environmentId: string,
    providerName: string,
    reread: boolean,
    state: SandboxEnvironmentSnapshot | undefined,
  ): Promise<SandboxOpenResult> => {
    const reported: SandboxLifecycleState =
      status.state === 'absent' || status.state === 'stopped' ? 'provisioning' : status.state
    const after = reread ? operatorState(identity, await readFacts()) : state
    const baseSha = reported === 'ready' ? (after?.baseSha ?? status.handle?.baseSha) : undefined
    const failure = reported === 'failed' ? (status.failure ?? after?.failure) : undefined
    return {
      state: reported,
      environmentId,
      provider: providerName,
      ...(baseSha !== undefined ? { baseSha } : {}),
      ...(failure !== undefined
        ? { failure: { stage: failure.stage, message: redactSandboxMessage(failure.message) } }
        : {}),
    }
  }

  /** The open path, run inside the operator's serialize chain (reset calls
   * it while holding the chain).
   *
   * Ordering is what makes reaping safe: the provider is probed first, and a
   * `failed` report is recorded in the journal (`recordFailure`) before the
   * provider's `open` — which may reap the failed environment and reprovision
   * — is called. When the failure cannot be recorded, `open` refuses and
   * nothing is discarded. */
  const openLocked = async (identity: string): Promise<SandboxOpenResult> => {
    const facts = await flushUnjournaled(identity, await readFacts())
    let state = operatorState(identity, facts)
    const described = await capability.describe({ repo, operator: identity })
    const current = await probe(identity)
    if (state !== undefined && orphaned(identity, state, current)) {
      await settleOnce(identity, state.environmentId, orphanOutcome)
      state = operatorState(identity, await readFacts())
    } else if (state?.state === 'provisioning' && current.state === 'ready') {
      // A lagging journal: settle it from the provider before deciding.
      const result = await settleOnce(identity, state.environmentId, current)
      if (result === 'appended' || result === 'settled-elsewhere') {
        return openReport(
          identity,
          current,
          described.environmentId,
          described.provider,
          true,
          state,
        )
      }
    }
    if (current.state === 'failed') {
      let recorded: Awaited<ReturnType<typeof recordFailure>>
      try {
        recorded = await recordFailure(
          identity,
          described.environmentId,
          described.provider,
          current,
        )
      } catch (error) {
        throw new SandboxOperationError(
          'provision',
          `${SANDBOX_UNRECORDED_FAILURE_MESSAGE}: ${describeError(error)}`,
          { cause: error },
        )
      }
      if (recorded === 'contended') {
        throw new SandboxOperationError('provision', SANDBOX_UNRECORDED_FAILURE_MESSAGE)
      }
      state = operatorState(identity, await readFacts())
    }
    let opened: Awaited<ReturnType<typeof capability.open>>
    try {
      opened = await capability.open({ repo, operator: identity, baseBranch: options.baseBranch })
    } catch (error) {
      if (error instanceof SandboxOperationError) throw error
      throw new SandboxOperationError('provision', describeError(error), { cause: error })
    }
    const { status, settled } = opened
    if (settled === undefined && status.state === 'ready') {
      if (state?.state === 'live') {
        return openReport(
          identity,
          status,
          described.environmentId,
          described.provider,
          false,
          state,
        )
      }
      if (state?.state === 'provisioning') {
        await settleOnce(identity, state.environmentId, status)
      } else {
        const handle = status.handle ?? described
        if (state === undefined || status.kind === 'provision') {
          await append(identity, 'orchestrator.sandbox.provisioned', {
            operator: identity,
            environmentId: described.environmentId,
            provider: handle.provider,
            ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
            workspacePath: handle.workspacePath,
            ...(handle.baseSha !== undefined ? { baseSha: handle.baseSha } : {}),
          })
        } else {
          await append(identity, 'orchestrator.sandbox.resumed', {
            operator: identity,
            environmentId: described.environmentId,
            provider: handle.provider,
            ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
          })
        }
      }
      return openReport(identity, status, described.environmentId, described.provider, true, state)
    }
    // Work remains (or failed at once): open the attempt in the journal.
    const kind = status.kind ?? (status.state === 'resuming' ? 'resume' : 'provision')
    let journaled = state
    if (
      state?.state !== 'provisioning' ||
      (status.kind !== undefined && status.kind !== state.pendingKind)
    ) {
      await append(identity, 'orchestrator.sandbox.provisioning', {
        operator: identity,
        environmentId: described.environmentId,
        provider: described.provider,
        kind,
      })
      journaled = operatorState(identity, await readFacts())
    }
    if (settled !== undefined) {
      const existing = background.get(keyOf(identity))
      if (existing === undefined || existing.cancelled || existing.source !== settled) {
        attach(identity, described.environmentId, settled)
      }
    } else if (status.state === 'failed' && journaled !== undefined) {
      await settleOnce(identity, journaled.environmentId, status)
    }
    return openReport(
      identity,
      status,
      described.environmentId,
      described.provider,
      false,
      journaled,
    )
  }

  /** The journal gate every non-lifecycle tool passes, inside the chain. */
  const gate = async (
    identity: string,
  ): Promise<{ resolved: SandboxEnvironmentIdentity; state: SandboxEnvironmentSnapshot }> => {
    const facts = await flushUnjournaled(identity, await readFacts())
    let state = operatorState(identity, facts)
    if (state?.state === 'provisioning') {
      const current = await probe(identity)
      if (current.state === 'ready' || current.state === 'failed') {
        await settleOnce(identity, state.environmentId, current)
      } else if (orphaned(identity, state, current)) {
        await settleOnce(identity, state.environmentId, orphanOutcome)
      } else {
        throw notReady(current.state === 'absent' ? 'provisioning' : current.state)
      }
      state = operatorState(identity, await readFacts())
    }
    if (state === undefined) throw notReady('absent')
    if (state.state !== 'live') {
      throw notReady(state.state === 'released' ? 'absent' : state.state)
    }
    const resolved = await capability.describe({ repo, operator: identity })
    return { resolved, state }
  }

  /** Rate-limited activity evidence: at most one fact per interval per
   * environment, compared against the latest journaled evidence. */
  const maybeAppendActivity = async (
    identity: string,
    state: ReturnType<typeof operatorState>,
  ): Promise<void> => {
    if (state === undefined) return
    const last = Date.parse(state.lastEvidenceTs)
    if (Number.isFinite(last) && clock().getTime() - last < SANDBOX_ACTIVITY_INTERVAL_MS) return
    const resolved = await capability.describe({ repo, operator: identity })
    await append(identity, 'orchestrator.sandbox.activity', {
      operator: identity,
      environmentId: resolved.environmentId,
    })
  }

  const requireRepo = (
    inputRepo: string | undefined,
    stage: SandboxOperationError['stage'] = 'exec',
  ): void => {
    if (inputRepo !== undefined && inputRepo !== repo) {
      throw new SandboxOperationError(
        stage,
        `sandbox tools serve repository "${repo}"; refusing "${inputRepo}"`,
      )
    }
  }

  const run = async <T>(
    identity: string,
    stage: 'exec' | 'publish' | 'refresh',
    operation: (
      resolved: SandboxEnvironmentIdentity,
      state: SandboxEnvironmentSnapshot,
    ) => Promise<T>,
  ): Promise<T> =>
    serialize(keyOf(identity), async () => {
      const { resolved, state } = await gate(identity)
      try {
        const result = await operation(resolved, state)
        await maybeAppendActivity(identity, state).catch(() => {})
        return result
      } catch (error) {
        if (error instanceof SandboxOperationError) throw error
        throw new SandboxOperationError(stage, describeError(error), { cause: error })
      }
    })

  return {
    /** True only when both a forge and a sandbox publication capability are
     * wired; the registry filters `sandbox.publish` when false. */
    canPublish,

    async open(identity, input) {
      requireRepo(input.repo, 'provision')
      requireLifecycle()
      return serialize(keyOf(identity), () => openLocked(identity))
    },

    async status(identity, input) {
      requireRepo(input.repo)
      requireLifecycle()
      const read = await readRepositoryFacts(store, repo)
      const state = operatorState(identity, read.value)
      const described = await capability.describe({ repo, operator: identity })
      const current = await probe(identity)
      // The poll's only write: a finished attempt's outcome (or an orphaned
      // attempt's failure) the journal still lacks, recorded exactly once.
      // A store error or contention is reported, never thrown.
      let orphanFailure: SandboxProviderStatus['failure']
      if (state?.state === 'provisioning') {
        const settling =
          current.state === 'ready' || current.state === 'failed'
            ? current
            : orphaned(identity, state, current)
              ? orphanOutcome
              : undefined
        if (settling !== undefined) {
          if (settling === orphanOutcome) orphanFailure = orphanOutcome.failure
          await serialize(keyOf(identity), () =>
            settleOnce(identity, state.environmentId, settling, read),
          ).catch((error: unknown) => {
            options.report?.(error)
          })
        }
      }
      let reported: SandboxLifecycleState
      if (orphanFailure !== undefined) {
        reported = 'failed'
      } else if (
        current.state === 'provisioning' ||
        current.state === 'resuming' ||
        current.state === 'failed'
      ) {
        reported = current.state
      } else if (current.state === 'ready') {
        reported =
          state?.state === 'live' || state?.state === 'provisioning'
            ? 'ready'
            : state === undefined
              ? 'absent'
              : state.state === 'released'
                ? 'absent'
                : state.state
      } else if (current.state === 'stopped' && state !== undefined && state.state !== 'released') {
        // The provider's idle timer stopped it: no fact was journaled, so the
        // journal may still say `live`. A failed journal keeps `failed`.
        reported = state.state === 'failed' ? 'failed' : 'stopped'
      } else if (current.state === 'absent' && state?.state === 'provisioning') {
        // An attempt whose environment does not exist yet (inside the orphan
        // grace, or running in this process).
        reported = 'provisioning'
      } else {
        reported = state?.state === 'stopped' || state?.state === 'failed' ? state.state : 'absent'
      }
      const baseSha =
        state?.state === 'provisioning'
          ? current.state === 'ready'
            ? current.handle?.baseSha
            : undefined
          : state?.baseSha
      const failure =
        reported === 'failed' ? (orphanFailure ?? current.failure ?? state?.failure) : undefined
      const headSha = current.state === 'ready' ? current.headSha : undefined
      return {
        state: reported,
        environmentId: described.environmentId,
        provider: described.provider,
        ...(headSha !== undefined ? { headSha } : {}),
        ...(baseSha !== undefined ? { baseSha } : {}),
        ...(failure !== undefined
          ? { failure: { stage: failure.stage, message: redactSandboxMessage(failure.message) } }
          : {}),
        ...(state !== undefined ? { lastEvidenceAt: state.lastEvidenceTs } : {}),
      }
    },

    async close(identity, input) {
      requireRepo(input.repo)
      requireLifecycle()
      return serialize(keyOf(identity), async () => {
        const state = operatorState(identity, await flushUnjournaled(identity, await readFacts()))
        const described = await capability.describe({ repo, operator: identity })
        const inflight = cancelBackground(identity)
        if (
          !inflight &&
          (state === undefined || state.state === 'stopped' || state.state === 'failed')
        ) {
          return { outcome: 'noop' as const, environmentId: described.environmentId }
        }
        const result = await capability
          .close({ repo, operator: identity, environmentId: described.environmentId })
          .catch((error: unknown) => {
            if (error instanceof SandboxOperationError) throw error
            throw new SandboxOperationError('close', describeError(error), { cause: error })
          })
        if (state === undefined) {
          return { outcome: 'noop' as const, environmentId: described.environmentId }
        }
        // A provision that finished in the race keeps its base head.
        if (result.attempt !== undefined && state.state === 'provisioning') {
          await settleOnce(identity, state.environmentId, result.attempt)
        }
        await append(identity, 'orchestrator.sandbox.closed', {
          operator: identity,
          environmentId: described.environmentId,
        })
        return { outcome: 'closed' as const, environmentId: described.environmentId }
      })
    },

    async refresh(identity, input) {
      requireRepo(input.repo)
      requireLifecycle()
      return run(identity, 'refresh', async (resolved) => {
        const result = await capability.refresh(resolved, {
          repo,
          baseBranch: options.baseBranch,
        })
        if (result.outcome === 'refused') {
          throw new SandboxOperationError(
            result.reason === 'dirty' ? 'refresh-dirty' : 'refresh-diverged',
            redactSandboxMessage(result.message),
          )
        }
        if (result.outcome === 'refreshed') {
          await append(identity, 'orchestrator.sandbox.refreshed', {
            operator: identity,
            environmentId: resolved.environmentId,
            baseSha: result.baseSha,
            headSha: result.headSha,
            previousHeadSha: result.previousHeadSha,
          })
        }
        return {
          outcome: result.outcome,
          headSha: result.headSha,
          baseSha: result.baseSha,
          previousHeadSha: result.previousHeadSha,
        }
      })
    },

    async settled(identity) {
      const key = keyOf(identity)
      for (let entry = background.get(key); entry !== undefined; entry = background.get(key)) {
        await entry.promise
      }
    },

    async exec(identity, input) {
      requireRepo(input.repo)
      const timeoutSeconds = validateBoundedInt(
        input.timeoutSeconds ?? 120,
        1,
        SANDBOX_EXEC_MAX_SECONDS,
        'timeoutSeconds',
      )
      const cwd = input.cwd === undefined ? undefined : resolveSandboxRelativePath(input.cwd)
      return run(identity, 'exec', async (resolved) => {
        const result = await capability.exec(resolved, {
          command: input.command,
          ...(cwd !== undefined ? { cwd } : {}),
          timeoutSeconds,
        })
        return {
          exitCode: result.exitCode,
          stdout: truncateSandboxOutput(result.stdout),
          stderr: truncateSandboxOutput(result.stderr),
        }
      })
    },

    async start(identity, input) {
      requireRepo(input.repo)
      const cwd = input.cwd === undefined ? undefined : resolveSandboxRelativePath(input.cwd)
      return run(identity, 'exec', async (resolved) =>
        capability.start(resolved, {
          command: input.command,
          ...(cwd !== undefined ? { cwd } : {}),
        }),
      )
    },

    async wait(identity, input) {
      requireRepo(input.repo)
      const waitSeconds = validateBoundedInt(
        input.waitSeconds,
        0,
        SANDBOX_EXEC_MAX_SECONDS,
        'waitSeconds',
      )
      return run(identity, 'exec', async (resolved) => {
        const result = await capability.wait(resolved, {
          commandId: input.commandId,
          waitSeconds,
        })
        if (result.state === 'running') {
          // Partial output so far rides on `running` too: providers that
          // stream (the local faces) supply their buffers here, and Vercel —
          // which reports output only after exit — supplies none. Truncation
          // bounds apply to both shapes.
          return {
            state: 'running' as const,
            ...(result.stdout !== undefined
              ? { stdout: truncateSandboxOutput(result.stdout) }
              : {}),
            ...(result.stderr !== undefined
              ? { stderr: truncateSandboxOutput(result.stderr) }
              : {}),
          }
        }
        return {
          state: 'exited' as const,
          exitCode: result.exitCode,
          stdout: truncateSandboxOutput(result.stdout ?? ''),
          stderr: truncateSandboxOutput(result.stderr ?? ''),
        }
      })
    },

    async readFile(identity, input) {
      requireRepo(input.repo)
      const path = resolveSandboxRelativePath(input.path)
      return run(identity, 'exec', async (resolved) => capability.readFile(resolved, path))
    },

    async writeFile(identity, input) {
      requireRepo(input.repo)
      const path = resolveSandboxRelativePath(input.path)
      const content =
        input.encoding === 'base64'
          ? Buffer.from(input.content, 'base64')
          : Buffer.from(input.content, 'utf8')
      if (content.length > SANDBOX_WRITE_LIMIT_BYTES) {
        throw new SandboxOperationError(
          'exec',
          `sandbox write exceeds the ${SANDBOX_WRITE_LIMIT_BYTES}-byte bound`,
        )
      }
      await run(identity, 'exec', async (resolved) => {
        await capability.writeFile(resolved, path, new Uint8Array(content))
      })
    },

    async publish(
      identity,
      input: {
        repo: string
        title: string
        body?: string
        commit?: string
        via?: Via
      },
    ) {
      requireRepo(input.repo, 'publish')
      const title = input.title.trim()
      if (title === '') {
        throw new SandboxOperationError('publish', 'title must not be empty')
      }
      if (title.length > 200) {
        throw new SandboxOperationError('publish', 'title must be at most 200 characters')
      }
      if (input.body !== undefined && input.body.length > 65_536) {
        throw new SandboxOperationError('publish', 'body must be at most 65,536 characters')
      }
      if (input.commit !== undefined && input.commit.trim() === '') {
        throw new SandboxOperationError('publish', 'commit must be a nonempty commit-ish')
      }
      if (!canPublish) {
        throw new SandboxOperationError(
          'publish',
          'publication is unavailable: no forge or no sandbox publication capability is wired',
        )
      }
      const forge = options.forge!
      const publication = provider.sandboxPublication!
      // run() already serializes per environment; wrapping it in another
      // serialize on the same key would deadlock the chain.
      return run(identity, 'publish', async (resolved, freshState) => {
        let stage: 'checks' | 'push' | 'pr' = 'checks'
        try {
          // 1. Resolve the commit inside the sandbox checkout.
          const commitExpr = input.commit?.trim() || 'HEAD'
          const resolveResult = await capability.exec(resolved, {
            // --quiet makes an unresolvable commit-ish exit 1 (the documented
            // refusal signal below); without it git exits 128 and the refusal
            // branch is unreachable.
            command: `git rev-parse --verify --quiet ${commitExpr}^{commit}`,
            timeoutSeconds: 30,
          })
          if (resolveResult.exitCode === 1) {
            throw new SandboxOperationError(
              'publish',
              `commit ${JSON.stringify(commitExpr)} does not resolve to a commit in the sandbox checkout`,
            )
          }
          if (resolveResult.exitCode !== 0) {
            throw new Error(
              `git rev-parse --verify ${commitExpr}^{commit} exited ${resolveResult.exitCode}: ${resolveResult.stderr.trim() || resolveResult.stdout.trim() || '(no output)'}`,
            )
          }
          const sha = resolveResult.stdout.trim()
          // 2. Refuse a dirty checkout: staged or unstaged changes to
          // tracked files, and untracked files — a new file the operator
          // never committed would otherwise be silently left out of the
          // published commit. The providers exclude their own
          // provisioning marker in the checkout's info/exclude, so the
          // marker itself never counts as dirt (f_c748dc6a).
          const statusResult = await capability.exec(resolved, {
            command: 'git status --porcelain',
            timeoutSeconds: 30,
          })
          if (statusResult.exitCode !== 0) {
            throw new Error(
              `git status --porcelain exited ${statusResult.exitCode}: ${statusResult.stderr.trim() || statusResult.stdout.trim() || '(no output)'}`,
            )
          }
          if (statusResult.stdout.trim() !== '') {
            throw new SandboxOperationError(
              'publish',
              'the sandbox checkout has uncommitted changes; commit or discard them before publishing',
            )
          }
          // 3. Refuse a commit that is not a descendant of the base head
          // at provision, refresh or reset time.
          const baseSha = freshState?.baseSha
          if (baseSha === undefined) {
            throw new SandboxOperationError(
              'publish',
              'this environment has no recorded base head; run sandbox.reset to re-provision before publishing',
            )
          }
          if (sha === baseSha) {
            throw new SandboxOperationError(
              'publish',
              'the checkout head is the base commit itself; there is nothing to publish',
            )
          }
          const ancestorResult = await capability.exec(resolved, {
            command: `git merge-base --is-ancestor ${baseSha} ${sha}`,
            timeoutSeconds: 30,
          })
          if (ancestorResult.exitCode === 1) {
            throw new SandboxOperationError(
              'publish',
              `the commit is not a descendant of the base head ${baseSha} recorded at provision, refresh or reset time; rebase onto the current base, or run sandbox.refresh or sandbox.reset`,
            )
          }
          if (ancestorResult.exitCode !== 0) {
            throw new Error(
              `git merge-base --is-ancestor ${baseSha} ${sha} exited ${ancestorResult.exitCode}: ${ancestorResult.stderr.trim() || ancestorResult.stdout.trim() || '(no output)'}`,
            )
          }
          // 4. Deterministic branch; the helper self-validates the grammar.
          const branch = sandboxPublicationBranch(repo, identity)
          if (branch === options.baseBranch) {
            throw new SandboxOperationError(
              'publish',
              'the derived publication branch collides with the base branch; refusing',
            )
          }
          // 5. Push-before-fact crash safety, mirroring
          // publication-settlement: a crashed prior attempt is owed its
          // completion, not a re-push.
          const alreadyPublished =
            (await publication.isPublished?.({
              ref: resolved.environmentId,
              sha,
              branch,
            })) === true
          stage = 'push'
          if (!alreadyPublished) {
            await publication.publish({ ref: resolved.environmentId, sha, branch })
          }
          // 6. Open (or adopt) the PR against the base branch; a later
          // publish to the same branch moves the same PR's head.
          stage = 'pr'
          const session =
            input.via !== undefined && input.via.kind === 'session' ? input.via.id : undefined
          const body =
            (input.body ?? '') +
            (input.body !== undefined && input.body !== '' ? '\n\n' : '') +
            `Published from an Autobuild operator sandbox by ${identity}` +
            (session !== undefined ? ` via orchestrator session ${session}` : '') +
            ' — agent-authored, not a pipeline build.'
          const pr = await forge.openPr({
            workspacePath: resolved.workspacePath,
            head: branch,
            base: options.baseBranch,
            title,
            body,
          })
          // 7. The publication is a repository-journal fact.
          await append(identity, 'orchestrator.sandbox.published', {
            operator: identity,
            environmentId: resolved.environmentId,
            branch,
            sha,
            ...(session !== undefined ? { session } : {}),
            pr: { number: pr.number, url: pr.url, headSha: pr.headSha },
          })
          return { branch, sha, pr: { number: pr.number, url: pr.url, headSha: pr.headSha } }
        } catch (error) {
          // 8. Every refusal or failure at steps 1-6 is a journal fact
          // naming the stage, with credential values redacted from the
          // message.
          const message = describeError(error)
          await append(identity, 'orchestrator.sandbox.publish-failed', {
            operator: identity,
            environmentId: resolved.environmentId,
            stage,
            message,
          }).catch(() => {})
          throw new SandboxOperationError('publish', message, {
            cause: error instanceof SandboxOperationError ? error.cause : error,
          })
        }
      })
    },

    async reset(identity, input) {
      requireRepo(input.repo)
      // Refuse before tearing anything down: reset re-provisions through the
      // lifecycle, which a provider without it cannot do.
      requireLifecycle()
      return serialize(keyOf(identity), async () => {
        await flushUnjournaled(identity, await readFacts())
        const resolved = await capability.describe({ repo, operator: identity })
        cancelBackground(identity)
        await append(identity, 'orchestrator.sandbox.reset', {
          operator: identity,
          environmentId: resolved.environmentId,
        })
        // Release first (snapshot purge; the provider cancels and awaits an
        // in-flight attempt), then reprovision from the CURRENT base head in
        // the background. The journal carries reset → released →
        // provisioning → provisioned as the evidence chain.
        const { snapshots } = await capability
          .release({ repo, operator: identity, environmentId: resolved.environmentId })
          .catch((error: unknown) => {
            throw new SandboxOperationError('reset', describeError(error), { cause: error })
          })
        await append(identity, 'orchestrator.sandbox.released', {
          operator: identity,
          environmentId: resolved.environmentId,
          snapshots,
        })
        return openLocked(identity)
      })
    },

    async release(identity, input) {
      requireRepo(input.repo)
      await serialize(keyOf(identity), async () => {
        const state = operatorState(identity, await flushUnjournaled(identity, await readFacts()))
        const inflight = cancelBackground(identity)
        // No environment ever provisioned: a no-op, with no fact and no
        // provider traffic beyond the pure describe.
        if (state === undefined && !inflight) return
        const resolved = await capability.describe({ repo, operator: identity })
        // The provider cancels and awaits an in-flight attempt before the
        // teardown, so the archive hook never waits on an unbounded setup.
        const { snapshots } = await capability
          .release({ repo, operator: identity, environmentId: resolved.environmentId })
          .catch((error: unknown) => {
            throw new SandboxOperationError('release', describeError(error), { cause: error })
          })
        if (state === undefined) return
        await append(identity, 'orchestrator.sandbox.released', {
          operator: identity,
          environmentId: resolved.environmentId,
          snapshots,
        })
      })
    },
  }
}

function validateBoundedInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SandboxOperationError('exec', `${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

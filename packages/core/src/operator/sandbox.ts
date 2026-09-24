/**
 * The operator sandbox service (AUT-340): the single validation,
 * serialization, journaling, and typed-error point behind the registry's
 * `sandbox.*` tools. The registry hands it only the caller's attributed
 * identity plus the tool input; the service owns every journal append and
 * derives lifecycle state from the repository journal (`sandboxStates`), so
 * a later dispatcher invocation can settle what this process left behind.
 *
 * Credential freeness is structural upstream (the providers build guest
 * environments from empty records); redaction here keeps credential VALUES
 * out of typed error messages that travel to tool callers.
 */
import { createHash } from 'node:crypto'
import { humanActor } from '../events/envelope'
import type { Via } from '../events/envelope'
import type { Forge } from '../ports/types'
import {
  SANDBOX_FORBIDDEN_ENV,
  SandboxOperationError,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxWaitResult,
} from '../ports/workspace/operator-sandbox'
import type { WorkspaceProvider } from '../ports/types'
import { sandboxStates } from '../processes/sandbox-state'
import { systemClock, type BuildStore, type Clock } from '../store/types'

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

/** Redact values of credential-named environment variables from a provider
 * message (the existing credential-redaction discipline): the message may
 * travel to a tool caller, so a value of any forbidden name never rides on
 * it. Values are read from the host environment of the serving process. */
export function redactSandboxMessage(message: string): string {
  let redacted = message
  for (const name of SANDBOX_FORBIDDEN_ENV) {
    const value = process.env[name]
    if (value !== undefined && value !== '') redacted = redacted.split(value).join('[REDACTED]')
  }
  return redacted
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

export interface OperatorSandboxService {
  /** True when both a forge and the provider's sandbox publication
   * capability are present, i.e. `publish` is callable. */
  readonly canPublish: boolean
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
   * fresh provision from the CURRENT base head. */
  reset(identity: string, input: { repo: string }): Promise<void>
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
      | 'orchestrator.sandbox.publish-failed',
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await store.appendRepo(repo, {
      actor: humanActor(identity),
      type,
      payload: payload as never,
    })
  }

  const journalEvents = async (): Promise<Awaited<ReturnType<typeof store.getRepoStateEvents>>> => {
    if ((await store.getRepo(repo)) === null) return []
    // Bounded read (AUT-489): sandboxStates consumes orchestrator.sandbox.*
    // facts, all of which are durable.
    return store.getRepoStateEvents(repo)
  }

  /** The operator's journal state, or undefined when no environment exists. */
  const operatorState = (identity: string, events: Awaited<ReturnType<typeof journalEvents>>) =>
    sandboxStates(events)
      .filter((state) => state.operator === identity && state.state !== 'released')
      .at(-1)

  /** Ensure (provision or resume) with the journal facts the transition
   * produces. Returns the resolved identity. */
  const ensureWithFacts = async (
    identity: string,
    state: ReturnType<typeof operatorState>,
  ): Promise<SandboxEnvironmentIdentity> => {
    const resolved = await capability.ensure({
      repo,
      operator: identity,
      baseBranch: options.baseBranch,
    })
    if (state === undefined) {
      await append(identity, 'orchestrator.sandbox.provisioned', {
        operator: identity,
        environmentId: resolved.environmentId,
        provider: resolved.provider,
        ...(resolved.sessionId !== undefined ? { sessionId: resolved.sessionId } : {}),
        workspacePath: resolved.workspacePath,
        ...(resolved.baseSha !== undefined ? { baseSha: resolved.baseSha } : {}),
      })
    } else if (state.state === 'stopped') {
      await append(identity, 'orchestrator.sandbox.resumed', {
        operator: identity,
        environmentId: resolved.environmentId,
        provider: resolved.provider,
        ...(resolved.sessionId !== undefined ? { sessionId: resolved.sessionId } : {}),
      })
    }
    return resolved
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

  const requireRepo = (inputRepo: string | undefined): void => {
    if (inputRepo !== undefined && inputRepo !== repo) {
      throw new SandboxOperationError(
        'exec',
        `sandbox tools serve repository "${repo}"; refusing "${inputRepo}"`,
      )
    }
  }

  const run = async <T>(
    identity: string,
    stage: 'provision' | 'resume' | 'exec' | 'publish',
    operation: (
      resolved: SandboxEnvironmentIdentity,
      state: ReturnType<typeof operatorState>,
    ) => Promise<T>,
  ): Promise<T> => {
    const key = `${repo}\0${identity}`
    return serialize(key, async () => {
      const events = await journalEvents()
      const state = operatorState(identity, events)
      const resolved = await ensureWithFacts(identity, state).catch((error: unknown) => {
        if (error instanceof SandboxOperationError) throw error
        throw new SandboxOperationError(
          state === undefined ? 'provision' : 'resume',
          describeError(error),
          { cause: error },
        )
      })
      const freshEvents = await journalEvents()
      const freshState = operatorState(identity, freshEvents)
      try {
        const result = await operation(resolved, freshState)
        await maybeAppendActivity(identity, freshState).catch(() => {})
        return result
      } catch (error) {
        if (error instanceof SandboxOperationError) throw error
        throw new SandboxOperationError(stage, describeError(error), { cause: error })
      }
    })
  }

  return {
    /** True only when both a forge and a sandbox publication capability are
     * wired; the registry filters `sandbox.publish` when false. */
    canPublish,

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
      requireRepo(input.repo)
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
            command: `git rev-parse --verify ${commitExpr}^{commit}`,
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
          // at provision or reset time.
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
              `the commit is not a descendant of the base head ${baseSha} recorded at provision time; rebase onto the current base or run sandbox.reset`,
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
      const key = `${repo}\0${identity}`
      await serialize(key, async () => {
        const events = await journalEvents()
        const state = operatorState(identity, events)
        const resolved = await capability.describe({ repo, operator: identity })
        await append(identity, 'orchestrator.sandbox.reset', {
          operator: identity,
          environmentId: resolved.environmentId,
        })
        // Release first (snapshot purge), then reprovision from the CURRENT
        // base head. A release failure still surfaces typed; the journal
        // carries reset → released → provisioned as the evidence chain.
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
        await ensureWithFacts(identity, undefined).catch((error: unknown) => {
          if (error instanceof SandboxOperationError) throw error
          throw new SandboxOperationError('provision', describeError(error), { cause: error })
        })
        void state
      })
    },

    async release(identity, input) {
      requireRepo(input.repo)
      const key = `${repo}\0${identity}`
      await serialize(key, async () => {
        const events = await journalEvents()
        const state = operatorState(identity, events)
        // No environment ever provisioned: a no-op, with no fact and no
        // provider traffic beyond the pure describe.
        if (state === undefined) return
        const resolved = await capability.describe({ repo, operator: identity })
        const { snapshots } = await capability
          .release({ repo, operator: identity, environmentId: resolved.environmentId })
          .catch((error: unknown) => {
            throw new SandboxOperationError('release', describeError(error), { cause: error })
          })
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

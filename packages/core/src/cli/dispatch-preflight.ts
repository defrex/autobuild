import { hostname } from 'node:os'
import { selectedExecutionAccounts } from '../config/roles'
import { LocalCredentials } from '../accounts/local-credentials'
import { inspectLocalAccountEnvironment } from '../accounts/local-owner'
import { missingAccountCredentials, MissingAccountCredentialsError } from '../accounts/availability'
import type { BuildStore } from '../store/types'
import { DISPATCHER } from '../events/envelope'
import type { Handoff } from '../kernel/dispatch-upgrade'

export interface StoreOverlapEvidence {
  compatible: boolean
  evidence: string
}
export interface PreflightInput {
  store: BuildStore
  repo: string
  handoff: Handoff
  successor: string
  signal: AbortSignal
  validate(): Promise<void>
  /** The admitted predecessor owns failure publication, including when this
   * target cannot authenticate or its new catalog writes are rejected. */
  failure(reason: string): Promise<void>
}
async function preflightRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return read()
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
  })
}

/** A successful metadata probe never authorizes yield. Only a successfully
 * persisted request does. Callers keep terminal and repository work inactive. */
export async function prepareDispatcherYield(input: PreflightInput): Promise<boolean> {
  try {
    input.signal.throwIfAborted()
    await preflightRead(input.signal, input.validate)
    const evidence = (await preflightRead(input.signal, async () =>
      input.store.inspectDispatcherOverlap?.(input.signal),
    )) ?? {
      compatible: false,
      evidence: 'selected store does not provide overlap compatibility evidence',
    }
    input.signal.throwIfAborted()
    const holder = (await preflightRead(input.signal, () => input.store.getRepo(input.repo)))?.lease
    if (holder?.holder !== input.handoff.run || Date.parse(holder.expiresAt) <= Date.now())
      throw new Error('preflight predecessor no longer holds the repository lease')
    // This write is also the actual store/catalog admission test. A rejection
    // must never be translated into cutover or successful preflight.
    await input.store.appendRepo(input.repo, {
      actor: DISPATCHER,
      type: 'dispatcher.yield-requested',
      payload: {
        ...input.handoff,
        successor: input.successor,
        mode: evidence.compatible ? 'drain' : 'cutover',
        evidence: evidence.evidence,
      },
    })
    return true
  } catch (error) {
    if (
      !input.signal.aborted ||
      (input.signal.reason instanceof Error && input.signal.reason.name === 'TimeoutError')
    )
      await input.failure(
        input.signal.aborted
          ? 'dispatcher preflight deadline exceeded'
          : error instanceof Error
            ? error.message
            : 'dispatcher preflight failed',
      )
    return false
  }
}

/** Runtime-owned entry. The launcher never opens the store or interprets config. */
async function runGenerationPreflight(
  launch: import('./dispatch-launch-contract').GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<boolean> {
  const { RemoteBuildStore } = await import('../store/remote/client')
  const { openGenerationStore } = await import('./dispatch-handoff')
  const { openLocalStore } = await import('../store/local/store')
  const { spawnExec } = await import('../ports/workspace/git-worktree')
  const { loadConfig } = await import('../config/load')
  const { readDispatchUpgrade, readDispatcherRunFacts } = await import('../store/reduced-reads')
  const { join } = await import('node:path')
  let prepared = false
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  const opened = await openGenerationStore(launch, argv, env, (ref, token) =>
    /^https?:/i.test(ref)
      ? new RemoteBuildStore({
          url: ref,
          token,
          fetchFn: ((input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([
                signal,
                prepared ? AbortSignal.timeout(30_000) : deadline,
                ...(init?.signal ? [init.signal] : []),
              ]),
            })) as typeof fetch,
        })
      : openLocalStore(ref, { bootstrap: false }),
  )
  try {
    const state = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[
      launch.predecessor!
    ]
    const handoff = state?.prepared?.payload
    if (
      !handoff ||
      handoff.correlation !== launch.predecessorCorrelation ||
      handoff.root !== launch.runtimeRoot ||
      handoff.lineage !== launch.lineage ||
      !launch.run
    )
      return false
    if (state?.request && state.request.payload.successor !== launch.run) return false
    const failure = async (reason: string) => publishPreflightFailure(launch, argv, env, reason)

    if (state?.request?.payload.successor === launch.run) prepared = true
    if (
      !prepared &&
      !(await prepareDispatcherYield({
        store: opened.store,
        repo: opened.repo,
        handoff,
        successor: launch.run,
        signal: deadline,
        failure,
        validate: async () => {
          const config = await loadConfig(join(launch.checkout, 'autobuild.toml'))
          if (!config.upgrade.automatic)
            throw new Error('automatic upgrades disabled during preflight')
          const { loadPlugins } = await import('../plugins/load')
          const { materializePluginRuntimes } = await import('../plugins/runtimes')
          const { createProductionRuntimes } = await import('../ports/runner/production')
          const { createRuntimeResolver } = await import('../ports/runner/routing')
          const { resolveForgeRegistration } = await import('../ports/forge/create')
          const { validateWorkspaceDispatchConfiguration } = await import('./dispatch-readiness')
          const plugins = await loadPlugins(config.plugins, launch.checkout, {
            packageRoot: launch.checkout,
            onNotice: () => {},
          })
          resolveForgeRegistration(config.forge, plugins)
          await validateWorkspaceDispatchConfiguration(
            config,
            { targetRepo: launch.checkout, env, exec: spawnExec },
            plugins,
          )
          const runtimes = await materializePluginRuntimes(
            createProductionRuntimes().runtimes,
            plugins,
            { repoRoot: launch.checkout, env },
          )
          createRuntimeResolver(
            runtimes,
            config.roles,
            config.policy.sessionBudgetSeconds,
            config.accounts,
          )
          const facts = (await readDispatcherRunFacts(opened.store, opened.repo, handoff.run)).value
          const start = facts.start
          const predecessorPid =
            start?.type === 'dispatcher.run-started' && start.payload.host === hostname()
              ? start.payload.pid
              : undefined
          const accounts = selectedExecutionAccounts(config)
          const available = inspectLocalAccountEnvironment(
            new LocalCredentials(join(launch.checkout, '.autobuild')),
            accounts,
            env,
            predecessorPid,
          )
          const missing = missingAccountCredentials(accounts, available)
          if (missing.length) throw new MissingAccountCredentialsError(missing)
          if (facts.stopRequest || facts.stop)
            throw new Error('predecessor stopped during preflight')
        },
      }))
    )
      return false
    prepared = true
    for (;;) {
      signal.throwIfAborted()
      const current = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[handoff.run]
      const facts = (await readDispatcherRunFacts(opened.store, opened.repo, handoff.run)).value
      if (facts.stopRequest || current?.failure) return false
      if (facts.stop && !current?.handoff) return false
      if (
        current?.request?.payload.correlation !== handoff.correlation ||
        current.request.payload.successor !== launch.run
      )
        return false
      const ready =
        current?.handoff?.payload.successor === launch.run &&
        current.handoff.payload.correlation === handoff.correlation &&
        current?.released?.payload.correlation === handoff.correlation &&
        (current.request?.payload.mode === 'drain' ||
          (current.completed &&
            facts.stop?.type === 'dispatcher.run-stopped' &&
            facts.stop.payload.outcome === 'normal'))
      if (ready) {
        const config = await loadConfig(join(launch.checkout, 'autobuild.toml'))
        const accounts = selectedExecutionAccounts(config)
        const available = inspectLocalAccountEnvironment(
          new LocalCredentials(join(launch.checkout, '.autobuild')),
          accounts,
          env,
        )
        const missing = missingAccountCredentials(accounts, available)
        if (missing.length) {
          await failure(new MissingAccountCredentialsError(missing).message)
          return false
        }
      }
      if (ready && (await opened.store.claimRepoLease(opened.repo, launch.run, 60_000))) {
        await opened.store.appendRepo(opened.repo, {
          actor: DISPATCHER,
          type: 'dispatcher.takeover',
          payload: { ...handoff, successor: launch.run },
        })
        return true
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    await opened.store.close()
  }
}

export async function preflightGeneration(
  launch: import('./dispatch-launch-contract').GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    return await runGenerationPreflight(launch, argv, env, signal)
  } catch (error) {
    if (!signal.aborted)
      await publishPreflightFailure(
        launch,
        argv,
        env,
        error instanceof Error ? error.message : 'target preflight failed',
      )
    return false
  }
}

async function publishPreflightFailure(
  launch: import('./dispatch-launch-contract').GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  reason: string,
): Promise<void> {
  if (!launch.predecessorRoot || !launch.predecessor || !launch.predecessorCorrelation)
    throw new Error('missing predecessor failure writer')
  const { generationArguments, DISPATCH_GENERATION_ENV } = await import(
    './dispatch-launch-contract'
  )
  const predecessor = {
    ...launch,
    run: launch.predecessor,
    runtimeRoot: launch.predecessorRoot,
    predecessor: undefined,
  }
  const writer = Bun.spawn(
    [
      process.execPath,
      ...generationArguments(launch.predecessorRoot, [
        '--record-preflight-failure',
        launch.predecessorCorrelation,
        reason,
        ...argv,
      ]),
    ],
    {
      env: { ...env, [DISPATCH_GENERATION_ENV]: JSON.stringify(predecessor) },
      cwd: launch.checkout,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      signal: AbortSignal.timeout(30_000),
    },
  )
  if ((await writer.exited) !== 0) throw new Error('predecessor could not record preflight failure')
}

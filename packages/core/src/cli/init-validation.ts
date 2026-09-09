import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { effectiveRuntimeReferences } from '../config/roles'
import type { Config } from '../config/schema'
import { vercelSandboxConfigSchema } from '../config/schema'
import { loadConfig } from '../config/load'
import { createProductionRuntimes } from '../ports/runner/production'
import { createRuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import { type VercelSandboxFacade, validateVercelSandbox } from '../ports/workspace/vercel-sandbox'
import { loadPlugins } from '../plugins/load'
import { materializePluginRuntimes } from '../plugins/runtimes'
import { createTicketSource } from '../ports/tickets/create'
import { inspectLocalStoreSnapshot } from '../store/local/store'
import type { StoreOpener } from './store-opening'
import { openProductionStore } from './store-opening'
import { isRemoteStoreRef, resolveMainRepo, resolveRepoStatePaths } from './repo-state'

export const INIT_PROBE_MARKER = 'AB_INIT_READINESS_V1='

export interface ReadinessCheck {
  name: string
  status: 'pass' | 'fail' | 'absent'
  detail: string
}

export interface InitValidationReport {
  provider: string
  context: 'local worktree' | 'Vercel Sandbox'
  workspace?: string
  revision?: string
  checks: ReadinessCheck[]
  exitCode: number
}

export interface GuestProbeReport {
  checks: ReadinessCheck[]
}

function message(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(message)].filter(Boolean).join('; ')
  }
  if (error instanceof Error)
    return `${error.message}${error.cause === undefined ? '' : `; ${message(error.cause)}`}`
  return String(error)
}

/** Replace every supplied nonempty value, longest first, in all diagnostics. */
export function createReadinessRedactor(
  env: Readonly<Record<string, string | undefined>>,
  explicitSecretNames: readonly string[] = [],
): (value: unknown) => string {
  const namedSecrets = new Set(explicitSecretNames)
  const secrets = [
    ...new Set(
      Object.entries(env)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            value !== '' &&
            (namedSecrets.has(name) || /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)),
        )
        .map(([, value]) => value as string),
    ),
  ].sort((left, right) => right.length - left.length)
  return (value) => {
    let text = message(value)
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
    return text
  }
}

async function shell(
  exec: Exec,
  cwd: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await exec(['sh', '-c', command], {
    cwd,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `setup command exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  }
}

function effectiveTargets(
  config: Config,
  runtimes: RuntimeRegistry,
): Array<{ runtime: string; models: string[] }> {
  // Preserve eager registry/model/argument validation, but probe only routes
  // the pipeline can consume rather than every declared role table.
  createRuntimeResolver(runtimes, config.roles, config.policy.sessionBudgetSeconds)
  return effectiveRuntimeReferences(config).map((group) => {
    const defaultModel = runtimes[group.runtime]?.defaultModel
    return {
      runtime: group.runtime,
      models: [
        ...new Set([
          ...group.models,
          ...(group.usesRuntimeDefaultModel && defaultModel !== undefined ? [defaultModel] : []),
        ]),
      ].sort(),
    }
  })
}

/** Probe code shared by the detached local worktree and the private sandbox entry. */
export async function runGuestReadinessProbe(opts: {
  repo: string
  env: Record<string, string | undefined>
  runtimes?: RuntimeRegistry
  openStore?: StoreOpener
  exec?: Exec
  signal?: AbortSignal
}): Promise<GuestProbeReport> {
  const checks: ReadinessCheck[] = []
  const config = await loadConfig(join(opts.repo, 'autobuild.toml'))
  const vercelConfig =
    config.workspace.provider === 'vercel-sandbox'
      ? vercelSandboxConfigSchema.parse(config.workspace.config)
      : undefined
  const redact = createReadinessRedactor(opts.env, vercelConfig?.environmentVariables)
  try {
    const setup = config.commands.setup
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('validation cancelled')
    if (setup !== undefined) await shell(opts.exec ?? spawnExec, opts.repo, setup, opts.signal)
    checks.push({
      name: 'repository setup',
      status: 'pass',
      detail: setup === undefined ? 'no commands.setup configured' : 'commands.setup completed',
    })
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? error
    return {
      checks: [
        {
          name: 'repository setup',
          status: 'fail',
          detail: `${redact(error)}; make commands.setup idempotent and runnable in a fresh environment`,
        },
      ],
    }
  }

  let runtimes: RuntimeRegistry
  try {
    const packageRoot = await resolveMainRepo(opts.repo, opts.exec ?? spawnExec)
    const plugins = await loadPlugins(config.plugins, opts.repo, { packageRoot })
    runtimes = await materializePluginRuntimes(
      opts.runtimes ?? createProductionRuntimes().runtimes,
      plugins,
      { repoRoot: opts.repo, env: opts.env },
    )
    checks.push({
      name: 'configuration and plugins',
      status: 'pass',
      detail: `${config.plugins.length} configured plugin(s) loaded`,
    })
  } catch (error) {
    return {
      checks: [
        ...checks,
        {
          name: 'configuration and plugins',
          status: 'fail',
          detail: `${redact(error)}; install or correct the configured plugin in this environment`,
        },
      ],
    }
  }

  try {
    for (const target of effectiveTargets(config, runtimes)) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('validation cancelled')
      const probe = runtimes[target.runtime]?.initUsable
      if (probe === undefined) {
        checks.push({
          name: `runtime ${target.runtime}`,
          status: 'fail',
          detail:
            'selected runtime has no onboarding usability probe; add initUsable or select a supported runtime',
        })
        continue
      }
      try {
        const outcome = await probe({ cwd: opts.repo, env: opts.env, models: target.models })
        const usable = typeof outcome === 'boolean' ? outcome : outcome.usable
        const reason =
          typeof outcome === 'boolean' ? (outcome ? 'usable' : 'unusable') : outcome.reason
        checks.push({
          name: `runtime ${target.runtime}${target.models.length === 0 ? '' : ` (${target.models.join(', ')})`}`,
          status: usable ? 'pass' : 'fail',
          detail: usable
            ? redact(reason)
            : `${redact(reason)}; fix workspace.config.runtimeProvisioning.${target.runtime}.preflight and expose API credential names in workspace.config.environmentVariables`,
        })
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? error
        checks.push({
          name: `runtime ${target.runtime}`,
          status: 'fail',
          detail: `${redact(error)}; fix workspace.config.runtimeProvisioning.${target.runtime} and its API credential names in workspace.config.environmentVariables`,
        })
      }
    }
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? error
    checks.push({ name: 'runtime routing', status: 'fail', detail: redact(error) })
  }

  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('validation cancelled')
  const storeRef = opts.env.AB_STORE
  if (storeRef === undefined || storeRef === '') {
    checks.push({
      name: 'BuildStore',
      status: 'fail',
      detail: 'AB_STORE is missing; configure the Store used by builds',
    })
  } else if (opts.openStore === undefined && !isRemoteStoreRef(storeRef)) {
    const localRoot = resolve(opts.repo, storeRef)
    try {
      const inspection = await inspectLocalStoreSnapshot(localRoot)
      if (inspection.status === 'absent') {
        checks.push({
          name: 'BuildStore',
          status: 'absent',
          detail: `${inspection.databasePath} does not exist; no repository history was available to inspect and no Store was created`,
        })
      } else {
        checks.push({
          name: 'BuildStore',
          status: 'pass',
          detail: `${inspection.buildCount} readable build record(s) in a disposable snapshot of ${inspection.databasePath}`,
        })
      }
    } catch (error) {
      checks.push({
        name: 'BuildStore',
        status: 'fail',
        detail: `${redact(error)}; verify the local Store database permissions and integrity`,
      })
    }
  } else {
    let store: ReturnType<StoreOpener> | undefined
    try {
      store = (opts.openStore ?? openProductionStore)(storeRef, opts.env.AB_TOKEN)
      await store.listBuilds()
      checks.push({ name: 'BuildStore', status: 'pass', detail: 'read-only request succeeded' })
    } catch (error) {
      checks.push({
        name: 'BuildStore',
        status: 'fail',
        detail: `${redact(error)}; verify the Store URL, AB_TOKEN scope, and network access`,
      })
    } finally {
      await store?.close().catch((error) => {
        checks.push({ name: 'BuildStore close', status: 'fail', detail: redact(error) })
      })
    }
  }
  return { checks }
}

function parseGuestOutput(output: string): GuestProbeReport {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(INIT_PROBE_MARKER))
  if (line === undefined)
    throw new Error('remote readiness probe returned malformed output (result marker absent)')
  const value = JSON.parse(line.slice(INIT_PROBE_MARKER.length)) as GuestProbeReport
  if (!Array.isArray(value.checks))
    throw new Error('remote readiness probe returned malformed checks')
  return value
}

async function gitText(
  exec: Exec,
  repo: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec(['git', ...args], {
    cwd: repo,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  return result.stdout.trim()
}

function hostPreflight(config: Config, env: Record<string, string | undefined>): void {
  if (config.workspace.provider !== 'vercel-sandbox') return
  if (config.forge !== 'github')
    throw new Error(
      'vercel-sandbox supports forge = "github" only; configure GitHub publication before validating',
    )
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN)
    throw new Error('vercel-sandbox publication requires push-capable GITHUB_TOKEN or GH_TOKEN')
  if (
    !env.VERCEL_OIDC_TOKEN &&
    (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID)
  ) {
    throw new Error(
      'Vercel authentication requires VERCEL_OIDC_TOKEN or the durable VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID set',
    )
  }
  if (config.tickets.source === 'linear' && !env.LINEAR_API_KEY)
    throw new Error('ticket source "linear" requires LINEAR_API_KEY')
}

export async function validateInitReadiness(opts: {
  targetRepo: string
  env: Record<string, string | undefined>
  stdout?: (line: string) => void
  exec?: Exec
  openStore?: StoreOpener
  runtimes?: RuntimeRegistry
  vercelFacade?: VercelSandboxFacade
  packageArchive?: () => Promise<Uint8Array>
  signal?: AbortSignal
}): Promise<InitValidationReport> {
  const exec = opts.exec ?? spawnExec
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('validation cancelled')
  const repo = await resolveMainRepo(opts.targetRepo, exec)
  const configPath = join(repo, 'autobuild.toml')
  const configBytes = await readFile(configPath, 'utf8')
  const config = await loadConfig(configPath)
  const state = resolveRepoStatePaths({ repo, envStore: opts.env.AB_STORE })
  const vercelConfig =
    config.workspace.provider === 'vercel-sandbox'
      ? vercelSandboxConfigSchema.parse(config.workspace.config)
      : undefined
  const redact = createReadinessRedactor(opts.env, [
    ...(vercelConfig?.environmentVariables ?? []),
    ...(vercelConfig?.gitUsernameEnv === undefined ? [] : [vercelConfig.gitUsernameEnv]),
    ...(vercelConfig?.gitPasswordEnv === undefined ? [] : [vercelConfig.gitPasswordEnv]),
  ])
  try {
    hostPreflight(config, opts.env)
    // Ticket acquisition is a host responsibility for both workspace providers.
    // Exercise its read surface before allocating disposable infrastructure.
    const hostPlugins = await loadPlugins(config.plugins, repo, { packageRoot: repo })
    if (config.tickets.source !== 'file') {
      const ticketSource = await createTicketSource(
        config.tickets,
        { ...opts.env, AB_STORE: state.storeRef },
        repo,
        state.localStateRoot,
        hostPlugins,
      )
      await ticketSource.listReady({
        ...(config.tickets.readyLabels !== undefined ? { labels: config.tickets.readyLabels } : {}),
        state: config.tickets.readyState,
      })
    }
  } catch (error) {
    throw new Error(redact(error))
  }
  let report: InitValidationReport | undefined

  if (config.workspace.provider === 'git-worktree') {
    const root = await mkdtemp(join(tmpdir(), 'ab-init-validation-'))
    const workspace = join(root, 'worktree')
    let failure: unknown
    let cleanupFailure: unknown
    try {
      const revision = await gitText(
        exec,
        repo,
        ['rev-parse', '--verify', `${config.baseBranch}^{commit}`],
        opts.signal,
      )
      const add = await exec(['git', 'worktree', 'add', '--detach', workspace, revision], {
        cwd: repo,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })
      if (add.exitCode !== 0)
        throw new Error(
          `could not create validation worktree: ${add.stderr.trim() || add.stdout.trim()}`,
        )
      const candidateConfig = await readFile(join(workspace, 'autobuild.toml'), 'utf8')
      if (candidateConfig !== configBytes)
        throw new Error(
          `autobuild.toml differs from committed ${config.baseBranch}; commit setup changes before validating`,
        )
      const guest = await runGuestReadinessProbe({
        repo: workspace,
        env: { ...opts.env, AB_STORE: state.storeRef },
        ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
        ...(opts.runtimes !== undefined ? { runtimes: opts.runtimes } : {}),
        exec,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })
      report = {
        provider: 'git-worktree',
        context: 'local worktree',
        workspace,
        revision,
        checks: [
          {
            name: 'repository acquisition',
            status: 'pass',
            detail: `detached committed ${config.baseBranch} at ${revision}`,
          },
          ...guest.checks,
        ],
        exitCode: guest.checks.some((check) => check.status === 'fail') ? 1 : 0,
      }
    } catch (error) {
      failure = error
    } finally {
      const remove = await exec(['git', 'worktree', 'remove', '--force', workspace], { cwd: repo })
      const prune = await exec(['git', 'worktree', 'prune'], { cwd: repo })
      await rm(root, { recursive: true, force: true })
      if (remove.exitCode !== 0 && !/not a working tree/i.test(remove.stderr)) {
        cleanupFailure = new Error(
          `validation worktree ${workspace} could not be removed: ${remove.stderr.trim()}`,
        )
      } else if (prune.exitCode !== 0) {
        cleanupFailure = new Error(
          `validation worktree registry could not be pruned: ${prune.stderr.trim()}`,
        )
      }
    }
    if (failure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [failure, cleanupFailure],
        `validation failed and disposable worktree ${workspace} cleanup also failed`,
      )
    }
    if (failure !== undefined) throw failure
    if (cleanupFailure !== undefined) throw cleanupFailure
  } else if (config.workspace.provider === 'vercel-sandbox') {
    const vercel = vercelConfig!
    const storeRef = state.storeRef
    if (!/^https:\/\//i.test(storeRef))
      throw new Error('vercel-sandbox requires AB_STORE to be an HTTPS URL reachable from Vercel')
    const token = opts.env.AB_TOKEN
    if (!token) throw new Error('vercel-sandbox requires nonempty AB_TOKEN for the hosted Store')
    const remoteLine = await gitText(
      exec,
      repo,
      ['ls-remote', '--heads', 'origin', `refs/heads/${config.baseBranch}`],
      opts.signal,
    )
    const remoteRevision = remoteLine.split(/\s+/)[0]
    if (!/^[0-9a-f]{40,64}$/i.test(remoteRevision ?? '')) {
      throw new Error(
        `remote base ${config.baseBranch} does not exist; commit and push setup changes before validating`,
      )
    }
    await gitText(
      exec,
      repo,
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--refmap=',
        'origin',
        `refs/heads/${config.baseBranch}`,
      ],
      opts.signal,
    )
    const shownConfig = await exec(['git', 'show', `${remoteRevision}:autobuild.toml`], {
      cwd: repo,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    })
    if (shownConfig.exitCode !== 0) {
      throw new Error(
        `remote ${config.baseBranch} does not contain autobuild.toml; commit and push setup changes before validating`,
      )
    }
    if (shownConfig.stdout !== configBytes) {
      throw new Error(
        `remote ${config.baseBranch} autobuild.toml differs from this checkout; commit and push setup changes before validating`,
      )
    }
    let remote: Awaited<ReturnType<typeof validateVercelSandbox>>
    try {
      remote = await validateVercelSandbox({
        config: vercel,
        env: opts.env,
        storeRef,
        storeToken: token,
        repo,
        baseBranch: config.baseBranch,
        ...(opts.vercelFacade !== undefined ? { facade: opts.vercelFacade } : {}),
        exec,
        ...(opts.packageArchive !== undefined ? { packageArchive: opts.packageArchive } : {}),
        runtimeReferences: effectiveRuntimeReferences(config),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        onSandbox: (name) => opts.stdout?.(`Disposable Vercel Sandbox: ${name} (active)`),
      })
    } catch (error) {
      throw new Error(redact(error))
    }
    let guest: GuestProbeReport
    try {
      guest = parseGuestOutput(remote.output)
    } catch (error) {
      throw new Error(
        `disposable sandbox ${remote.sandbox} was deleted, but its readiness output was invalid: ${redact(error)}`,
      )
    }
    report = {
      provider: 'vercel-sandbox',
      context: 'Vercel Sandbox',
      workspace: remote.sandbox,
      revision: remote.revision,
      checks: [
        {
          name: 'repository acquisition',
          status: 'pass',
          detail: `${remote.origin} ${remote.revision}`,
        },
        ...guest.checks,
      ],
      exitCode: guest.checks.some((check) => check.status === 'fail') ? 1 : 0,
    }
  } else {
    throw new Error(
      `workspace provider "${config.workspace.provider}" does not support init readiness validation`,
    )
  }

  if (report === undefined) throw new Error('readiness validation produced no report')
  const stdout = opts.stdout ?? (() => {})
  stdout(`Readiness: ${report.context} (${report.provider})`)
  stdout(`Store: ${state.storeRef}`)
  stdout(`Forge: ${config.forge}`)
  if (vercelConfig !== undefined) {
    stdout(
      `Vercel auth: ${opts.env.VERCEL_OIDC_TOKEN ? 'OIDC' : 'access token'}; team=${opts.env.VERCEL_TEAM_ID ?? '(linked)'}; project=${opts.env.VERCEL_PROJECT_ID ?? '(linked)'}`,
    )
    stdout(
      `Private clone variables: ${vercelConfig.gitUsernameEnv === undefined ? '(public repository)' : `${vercelConfig.gitUsernameEnv}, ${vercelConfig.gitPasswordEnv}`}`,
    )
    stdout(
      `Guest environment variable names: ${vercelConfig.environmentVariables.join(', ') || '(none)'}`,
    )
    stdout(
      `Runtime provisioning names: ${Object.keys(vercelConfig.runtimeProvisioning).sort().join(', ') || '(none)'}`,
    )
  }
  if (report.workspace !== undefined)
    stdout(`Disposable environment: ${report.workspace} (released)`)
  for (const check of report.checks) {
    const label = check.status === 'pass' ? 'PASS' : check.status === 'absent' ? 'ABSENT' : 'FAIL'
    stdout(`  ${label} ${check.name}: ${redact(check.detail)}`)
  }
  return {
    ...report,
    checks: report.checks.map((check) => ({ ...check, detail: redact(check.detail) })),
  }
}

import { LOCAL_CONFIG_RELATIVE_PATH, parseLayeredConfig, type LocalOverrideRecord } from './local'
import type { Config, TicketsConfig } from './schema'
import { createRuntimeResolver, type RuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'

/** Exact repository artifact kind used for accepted dispatcher config revisions. */
export const DISPATCHER_CONFIG_ARTIFACT = 'dispatcher-config'

/**
 * Explicit hot/restart classification for every strict root field. Open maps
 * are classified at their owning table: their entries all share that table's
 * behavior.
 */
export const CONFIG_RELOAD_CLASSIFICATION = {
  store: 'restart',
  upgrade: 'hot',
  operator: 'hot',
  hooks: 'hot',
  baseBranch: 'hot',
  capacity: 'hot',
  ticketScanIntervalSeconds: 'hot',
  forge: 'restart',
  plugins: 'restart',
  pr: 'hot',
  landing: 'hot',
  workspace: {
    provider: 'restart',
    config: 'restart',
  },
  commands: 'hot',
  generated: 'hot',
  verify: 'hot',
  finalize: 'hot',
  roles: 'hot',
  profiles: 'hot',
  accounts: 'hot',
  policy: 'hot',
  orchestrator: 'restart',
  tickets: {
    source: 'restart',
    readyLabels: 'hot',
    readyState: 'hot',
    readyAssignee: 'hot',
    createAssignee: 'hot',
    createLabels: 'hot',
    teamKey: 'restart',
    claimedState: 'restart',
    createState: 'restart',
    triageState: 'hot',
    proposalState: 'hot',
    backlogState: 'hot',
    rejectedState: 'hot',
    dir: 'restart',
  },
} as const satisfies {
  [K in keyof Config]: K extends 'workspace'
    ? { [P in keyof Config['workspace']]: 'hot' | 'restart' }
    : K extends 'tickets'
      ? { [P in keyof TicketsConfig]: 'hot' | 'restart' }
      : 'hot' | 'restart'
}

export const RESTART_REQUIRED_CONFIG_PATHS = [
  'store',
  'forge',
  'plugins',
  'workspace.provider',
  'workspace.config',
  'orchestrator',
  'tickets.source',
  'tickets.teamKey',
  'tickets.claimedState',
  'tickets.createState',
  'tickets.dir',
] as const
export type RestartRequiredConfigPath = (typeof RESTART_REQUIRED_CONFIG_PATHS)[number]

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Paths whose candidate values cannot replace startup-constructed adapters. */
export function restartRequiredChanges(
  startup: Config,
  candidate: Config,
): RestartRequiredConfigPath[] {
  const changed: RestartRequiredConfigPath[] = []
  const compare = (
    path: (typeof RESTART_REQUIRED_CONFIG_PATHS)[number],
    a: unknown,
    b: unknown,
  ) => {
    if (!same(a, b)) changed.push(path)
  }
  compare('forge', startup.forge, candidate.forge)
  compare('plugins', startup.plugins, candidate.plugins)
  compare('workspace.provider', startup.workspace.provider, candidate.workspace.provider)
  compare('workspace.config', startup.workspace.config, candidate.workspace.config)
  compare('tickets.source', startup.tickets.source, candidate.tickets.source)
  compare('tickets.teamKey', startup.tickets.teamKey, candidate.tickets.teamKey)
  compare('tickets.claimedState', startup.tickets.claimedState, candidate.tickets.claimedState)
  compare('tickets.createState', startup.tickets.createState, candidate.tickets.createState)
  compare('tickets.dir', startup.tickets.dir, candidate.tickets.dir)
  compare('orchestrator', startup.orchestrator, candidate.orchestrator)
  return changed
}

/** Config sections that define the pipeline a build runs under (SPEC §16.1):
 * the verify universe, finalize steps, deterministic commands, and the
 * workspace provisioning definition. Build-owned sections are composed from
 * the build's own branch at a recorded pipeline-source commit and never
 * replaced by a later base-branch change. */
export const BUILD_OWNED_CONFIG_PATHS = ['verify', 'finalize', 'commands', 'workspace'] as const

/** Compose one build's effective config: build-owned tables come from the
 * pipeline source (the build's own branch), everything else from the live
 * dispatcher snapshot (deployment). Dispatcher-owned sections (baseBranch,
 * capacity, forge, plugins, pr, tickets, orchestrator) always travel with the
 * deployment side — the runner never interprets them. */
export function composeBuildConfig(pipeline: Config, deployment: Config): Config {
  return {
    ...deployment,
    verify: pipeline.verify,
    finalize: pipeline.finalize,
    commands: pipeline.commands,
    workspace: pipeline.workspace,
  }
}

/** Overlay all hot fields while retaining every startup-built adapter field. */
export function composeReloadedConfig(startup: Config, candidate: Config): Config {
  return {
    ...candidate,
    store: startup.store,
    forge: startup.forge,
    plugins: startup.plugins,
    workspace: startup.workspace,
    orchestrator: startup.orchestrator,
    tickets: {
      ...candidate.tickets,
      source: startup.tickets.source,
      teamKey: startup.tickets.teamKey,
      claimedState: startup.tickets.claimedState,
      createState: startup.tickets.createState,
      dir: startup.tickets.dir,
    },
  }
}

export interface ConfigSnapshot {
  readonly config: Config
  readonly resolver: RuntimeResolver
  /** Process-local revision. Zero is the startup file. */
  readonly revision: number
  /** Settings this snapshot took from the checkout's local override file. */
  readonly localOverrides?: LocalOverrideRecord
}

/** One dispatcher configuration candidate: the committed `autobuild.toml`
 * text and, in checkout mode, the local override file's text when present. */
export interface ConfigContent {
  committed: string
  local?: string
}

export interface LiveConfigOptions {
  /** Absolute path of the checkout's local override file. Unset in origin
   * mode, which never reads a checkout. */
  localSource?: string
  /** What the startup snapshot took from the local file. */
  startupLocalOverrides?: LocalOverrideRecord
}

function normalizeContent(content: string | ConfigContent): ConfigContent {
  return typeof content === 'string' ? { committed: content } : content
}

/** Comparison key of a candidate. Without a local layer it is exactly the
 * committed text, as it was before the layer existed. */
function contentKey(content: ConfigContent): string {
  return content.local === undefined
    ? content.committed
    : JSON.stringify([content.committed, content.local])
}

export type ConfigReloadOutcome =
  | { kind: 'unchanged' }
  | {
      kind: 'rejected'
      error: string
      notify: boolean
      /** Deprecation lines of a candidate that parsed but failed validation
       * afterwards; non-empty only on the first evaluation of that content. */
      deprecations?: readonly string[]
    }
  | {
      kind: 'publication-failed'
      error: string
      /** As for `rejected`: non-empty only on first evaluation of the content. */
      deprecations: readonly string[]
    }
  | {
      kind: 'adopted'
      snapshot: ConfigSnapshot
      restartRequired: RestartRequiredConfigPath[]
      effectiveChanged: boolean
    }

export type ConfigReloadPublisher = (input: {
  /** The committed `autobuild.toml` text of the candidate. */
  content: string
  /** Settings the candidate takes from the local override file, if any. */
  localOverrides?: LocalOverrideRecord
  /** Fully composed snapshot that will become current after publication. */
  effectiveConfig: Config
  restartRequired: readonly RestartRequiredConfigPath[]
  effectiveChanged: boolean
}) => Promise<void>

/**
 * Process-local owner of the dispatcher's effective config: `autobuild.toml`
 * layered with the checkout's `.autobuild/local.toml`, read together as one
 * candidate. A candidate is
 * published only after parsing, eager route validation, and durable journal
 * publication all succeed. Callers capture `current()` once per boundary.
 *
 * Parsing never writes: deprecation lines are collected. `deprecations()`
 * holds the accepted content's lines, and a candidate that parses but is not
 * adopted returns its lines on the outcome once per distinct content, so a
 * re-evaluated pending file stays quiet on later ticks.
 */
export class LiveConfig {
  private snapshot: ConfigSnapshot
  private acceptedContent: string
  private rejectedContent: string | undefined
  private acceptedDeprecations: readonly string[]
  private noticedCandidate: string | undefined
  private readonly localSource: string | undefined

  constructor(
    private readonly source: string,
    private readonly startup: Config,
    startupContent: string | ConfigContent,
    private readonly runtimes: RuntimeRegistry,
    private readonly publish: ConfigReloadPublisher,
    startupDeprecations: readonly string[] = [],
    /** A synchronous, request-free check of a composed reload against the
     * running process (for example the ticket source's capabilities); a
     * throw rejects the reload and keeps the previous snapshot. */
    private readonly validate?: (config: Config) => void,
    options: LiveConfigOptions = {},
  ) {
    this.localSource = options.localSource
    this.acceptedContent = contentKey(normalizeContent(startupContent))
    this.acceptedDeprecations = startupDeprecations
    this.snapshot = {
      config: startup,
      resolver: createRuntimeResolver(
        runtimes,
        startup.roles,
        startup.policy.sessionBudgetSeconds,
        startup.accounts,
        startup.profiles,
      ),
      revision: 0,
      ...(options.startupLocalOverrides ? { localOverrides: options.startupLocalOverrides } : {}),
    }
  }

  current(): ConfigSnapshot {
    return this.snapshot
  }

  /** Deprecation lines of the accepted content (startup or last adoption). */
  deprecations(): readonly string[] {
    return this.acceptedDeprecations
  }

  async refreshFromDisk(): Promise<ConfigReloadOutcome> {
    const localSource = this.localSource
    if (localSource === undefined) return this.refreshFrom(() => Bun.file(this.source).text())
    let local: string | undefined
    try {
      local = await Bun.file(localSource).text()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        const message =
          `${localSource} could not be read during live reload: ${
            error instanceof Error ? error.message : String(error)
          }; the last valid configuration snapshot remains active — ` +
          `fix or remove ${LOCAL_CONFIG_RELATIVE_PATH} to resume live reload`
        return this.rejectRead(message)
      }
    }
    return this.refreshFrom(async () => {
      const committed = await Bun.file(this.source).text()
      return local === undefined ? committed : { committed, local }
    })
  }

  private rejectRead(message: string): ConfigReloadOutcome {
    const rejectedRead = `\0${message}`
    const notify = this.rejectedContent !== rejectedRead
    this.rejectedContent = rejectedRead
    return { kind: 'rejected', error: message, notify }
  }

  /** Reload from any content source — the startup file (refreshFromDisk) or,
   * in checkout-less origin mode, the base branch's autobuild.toml fetched
   * through the forge. Read failures take the same rejected-read path: the
   * last valid snapshot remains active and the error is reported once per
   * distinct failure. */
  async refreshFrom(read: () => Promise<string | ConfigContent>): Promise<ConfigReloadOutcome> {
    let content: string | ConfigContent
    try {
      content = await read()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const detail =
        code === 'ENOENT'
          ? 'is missing during live reload'
          : `could not be read during live reload: ${
              error instanceof Error ? error.message : String(error)
            }`
      const message =
        `${this.source} ${detail}; the last valid configuration snapshot remains active — ` +
        'restore a valid autobuild.toml to resume live reload'
      return this.rejectRead(message)
    }
    return this.refresh(content)
  }

  async refresh(candidateContent: string | ConfigContent): Promise<ConfigReloadOutcome> {
    const layers = normalizeContent(candidateContent)
    const content = contentKey(layers)
    if (content === this.acceptedContent) {
      this.rejectedContent = undefined
      this.noticedCandidate = undefined
      return { kind: 'unchanged' }
    }

    let candidate: Config
    let localOverrides: LocalOverrideRecord | undefined
    const deprecations: string[] = []
    try {
      ;({ config: candidate, localOverrides } = parseLayeredConfig(
        {
          committed: { text: layers.committed, source: this.source },
          ...(layers.local === undefined
            ? {}
            : {
                local: {
                  text: layers.local,
                  source: this.localSource ?? LOCAL_CONFIG_RELATIVE_PATH,
                },
              }),
        },
        (line) => deprecations.push(line),
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notify = this.rejectedContent !== content
      this.rejectedContent = content
      return { kind: 'rejected', error: message, notify }
    }

    const candidateDeprecations = this.noticedCandidate === content ? [] : deprecations
    this.noticedCandidate = content

    const config = composeReloadedConfig(this.startup, candidate)
    let resolver: RuntimeResolver
    try {
      this.validate?.(config)
      for (const [name, account] of Object.entries(this.snapshot.config.accounts)) {
        if (account.kind === 'chatgpt-subscription' && !same(account, config.accounts[name]))
          throw new Error(
            `ChatGPT account ${JSON.stringify(name)} cannot change while dispatch is active; stop dispatch before replacing its descriptor`,
          )
      }
      resolver = createRuntimeResolver(
        this.runtimes,
        config.roles,
        config.policy.sessionBudgetSeconds,
        config.accounts,
        config.profiles,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notify = this.rejectedContent !== content
      this.rejectedContent = content
      return { kind: 'rejected', error: message, notify, deprecations: candidateDeprecations }
    }

    const restartRequired = restartRequiredChanges(this.startup, candidate)
    const effectiveChanged = !same(this.snapshot.config, config)
    try {
      await this.publish({
        content: layers.committed,
        ...(localOverrides ? { localOverrides } : {}),
        effectiveConfig: config,
        restartRequired,
        effectiveChanged,
      })
    } catch (error) {
      return {
        kind: 'publication-failed',
        error: error instanceof Error ? error.message : String(error),
        deprecations: candidateDeprecations,
      }
    }

    this.acceptedContent = content
    this.acceptedDeprecations = deprecations
    this.rejectedContent = undefined
    this.noticedCandidate = undefined
    this.snapshot = {
      config,
      resolver,
      revision: this.snapshot.revision + 1,
      ...(localOverrides ? { localOverrides } : {}),
    }
    return {
      kind: 'adopted',
      snapshot: this.snapshot,
      restartRequired,
      effectiveChanged,
    }
  }
}

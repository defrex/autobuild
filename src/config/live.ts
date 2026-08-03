import { parseConfig } from './load'
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
  baseBranch: 'hot',
  capacity: 'hot',
  forge: 'restart',
  plugins: 'restart',
  pr: 'hot',
  workspace: {
    provider: 'restart',
    config: 'restart',
  },
  commands: 'hot',
  verify: 'hot',
  finalize: 'hot',
  roles: 'hot',
  policy: 'hot',
  tickets: {
    source: 'restart',
    readyLabels: 'hot',
    readyState: 'hot',
    teamKey: 'restart',
    claimedState: 'restart',
    createState: 'restart',
    triageState: 'hot',
    proposalState: 'hot',
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
  'forge',
  'plugins',
  'workspace.provider',
  'workspace.config',
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
  return changed
}

/** Overlay all hot fields while retaining every startup-built adapter field. */
export function composeReloadedConfig(startup: Config, candidate: Config): Config {
  return {
    ...candidate,
    forge: startup.forge,
    plugins: startup.plugins,
    workspace: startup.workspace,
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
}

export type ConfigReloadOutcome =
  | { kind: 'unchanged' }
  | { kind: 'rejected'; error: string; notify: boolean }
  | { kind: 'publication-failed'; error: string }
  | {
      kind: 'adopted'
      snapshot: ConfigSnapshot
      restartRequired: RestartRequiredConfigPath[]
      effectiveChanged: boolean
    }

export type ConfigReloadPublisher = (input: {
  content: string
  /** Fully composed snapshot that will become current after publication. */
  effectiveConfig: Config
  restartRequired: readonly RestartRequiredConfigPath[]
  effectiveChanged: boolean
}) => Promise<void>

/**
 * Process-local owner of the dispatcher's effective config. A candidate is
 * published only after parsing, eager route validation, and durable journal
 * publication all succeed. Callers capture `current()` once per boundary.
 */
export class LiveConfig {
  private snapshot: ConfigSnapshot
  private acceptedContent: string
  private rejectedContent: string | undefined

  constructor(
    private readonly source: string,
    private readonly startup: Config,
    startupContent: string,
    private readonly runtimes: RuntimeRegistry,
    private readonly publish: ConfigReloadPublisher,
  ) {
    this.acceptedContent = startupContent
    this.snapshot = {
      config: startup,
      resolver: createRuntimeResolver(runtimes, startup.roles),
      revision: 0,
    }
  }

  current(): ConfigSnapshot {
    return this.snapshot
  }

  async refreshFromDisk(): Promise<ConfigReloadOutcome> {
    let content: string
    try {
      content = await Bun.file(this.source).text()
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
      const rejectedRead = `\0${message}`
      const notify = this.rejectedContent !== rejectedRead
      this.rejectedContent = rejectedRead
      return { kind: 'rejected', error: message, notify }
    }
    return this.refresh(content)
  }

  async refresh(content: string): Promise<ConfigReloadOutcome> {
    if (content === this.acceptedContent) {
      this.rejectedContent = undefined
      return { kind: 'unchanged' }
    }

    let candidate: Config
    try {
      candidate = parseConfig(content, this.source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notify = this.rejectedContent !== content
      this.rejectedContent = content
      return { kind: 'rejected', error: message, notify }
    }

    const config = composeReloadedConfig(this.startup, candidate)
    let resolver: RuntimeResolver
    try {
      resolver = createRuntimeResolver(this.runtimes, config.roles)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notify = this.rejectedContent !== content
      this.rejectedContent = content
      return { kind: 'rejected', error: message, notify }
    }

    const restartRequired = restartRequiredChanges(this.startup, candidate)
    const effectiveChanged = !same(this.snapshot.config, config)
    try {
      await this.publish({ content, effectiveConfig: config, restartRequired, effectiveChanged })
    } catch (error) {
      return {
        kind: 'publication-failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    this.acceptedContent = content
    this.rejectedContent = undefined
    this.snapshot = {
      config,
      resolver,
      revision: this.snapshot.revision + 1,
    }
    return {
      kind: 'adopted',
      snapshot: this.snapshot,
      restartRequired,
      effectiveChanged,
    }
  }
}

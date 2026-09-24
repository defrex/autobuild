/**
 * `ab mcp` — the first binding of the agent tool registry (AUT-338): the
 * registry served as an MCP server over stdio, using the official MCP
 * TypeScript SDK's current major.
 *
 * The CLI remains the primary local interface for agents that have a shell.
 * The stdio binding exists so the registry can be exercised end to end from a
 * local install, for dogfooding, and for local agents that cannot run
 * commands. Every tool is registered from the registry's closed table — name,
 * description, JSON-schema input, annotations, handler — so this surface can
 * never drift from the in-process registry the contract suite proves.
 *
 * Identity: the sessionless operator identity the other operator commands use
 * (`buildControlUser` — USER/USERNAME, else "dashboard"), with a via marker
 * naming the connected MCP client (learned lazily at the initialize handshake).
 * The server fails closed inside a phase: repository-wide operator authority
 * cannot be narrowed to the ambient build (the §8.2 rule that makes
 * repository-wide `ab builds` fail inside a phase, moved to process start
 * because a server cannot scope per request).
 */
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { Via } from '../events/envelope'
import { defaultTriageState } from '../processes/dispatcher'
import { createWorkspaceProvider } from '../ports/workspace/create'
import { createForge } from '../ports/forge/create'
import type { Forge } from '../ports/types'
import { createTicketSource } from '../ports/tickets/create'
import { loadPlugins } from '../plugins/load'
import { AUTOBUILD_VERSION } from '../store/remote/version'
import type { Clock } from '../store/types'
import { buildControlUser } from './build-control'
import type { Exec } from '../ports/workspace/git-worktree'
import { openSessionlessStore, type StoreOpener } from './store-opening'
import { InvalidAmbientContextError, resolveAmbientReadSession } from './env'
import { buildRegistry, RegistryError, type OperatorToolRegistry } from '../operator/registry'
import { createOperatorSandboxService, type OperatorSandboxService } from '../operator/sandbox'
import type { OperatorTicketBackend } from '../operator/tickets'

export const AB_MCP_USAGE = 'usage: ab mcp [--store <ref>] [--repo <id>] (§8.2)'

export const AB_MCP_PHASE_REFUSAL =
  'ab mcp serves repository-wide operator authority and cannot run inside a phase session (§8.2)'

const SERVER_INSTRUCTIONS = [
  'Autobuild operator tools for one repository: builds, repository and harvest controls, tickets, and operator notes.',
  'The `ab` CLI is the primary local interface for agents that have a shell; these tools mirror its operator commands',
  'and the operator API routes — every result equals the corresponding route. Prefer the CLI when a command exists;',
  'use these tools when no shell is available, for dogfooding, and for parity testing of the tool registry.',
  'Every tool names its repository explicitly via `repo`; mutating tools append durable, human-attributed events.',
].join(' ')

export interface AbMcpOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Explicit --store; selection remains --store > AB_STORE > repo-local. */
  storeRef?: string
  /** Explicit --repo: refuse calls targeting any other repository. */
  repo?: string
  /** Injectable adapter seam for tests; production composes the real adapter. */
  openStore?: StoreOpener
  /** Injectable ticket-source factory for tests. */
  ticketSourceFactory?: typeof createTicketSource
  clock?: Clock
}

/**
 * The operator ticket backend for the stdio binding: one TicketSource built
 * once from the checkout's own `[tickets]` config. `statesFor` returns the
 * configured lifecycle names; `sourceFor` cross-checks the effective
 * config's teamKey against this startup config and refuses on drift.
 */
export async function buildMcpTicketBackend(
  opts: AbMcpOpts & { checkout: string; localStateRoot: string },
): Promise<OperatorTicketBackend> {
  const configPath = join(opts.checkout, 'autobuild.toml')
  let config: Config
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — 'ab mcp' reads autobuild.toml from the resolved Git main checkout (SPEC §8.8)`,
      )
    }
    throw error
  }
  const plugins = await loadPlugins(config.plugins, opts.checkout)
  const factory = opts.ticketSourceFactory ?? createTicketSource
  const source = await factory(
    config.tickets,
    opts.env,
    opts.checkout,
    opts.localStateRoot,
    plugins,
  )
  const states = [
    ...new Set(
      [
        defaultTriageState(config),
        config.tickets.readyState,
        config.tickets.claimedState,
        config.tickets.createState,
      ].filter((state): state is string => state !== undefined),
    ),
  ]
  return {
    sourceFor: async (context) => {
      if (config.tickets.teamKey !== context.teamKey) {
        throw new Error(
          `the repository's effective ticket config names team "${context.teamKey}", but this checkout's autobuild.toml names team "${String(config.tickets.teamKey)}"; refusing to serve tickets across that drift — run ab mcp from the checkout dispatch uses`,
        )
      }
      return source
    },
    statesFor: async () => states,
  }
}

/**
 * Map every registry entry onto the MCP server: name, description (with the
 * output description appended), input schema, annotations, and a handler that
 * routes through registry.call so validation, identity enforcement, and
 * failure-body mapping stay identical across bindings. Successes and failures
 * both surface as JSON text content; failures additionally carry isError.
 */
export function serveRegistry(
  registry: OperatorToolRegistry,
  server: McpServer,
  ctx: { identity?: string; via?: Via | (() => Via | undefined) },
): void {
  for (const entry of registry.entries) {
    server.registerTool(
      entry.name,
      {
        description: `${entry.description}\n\nReturns: ${entry.outputDescription}`,
        inputSchema: entry.inputSchema,
        annotations: entry.annotations,
      },
      // The SDK validates args against the entry's schema before this runs;
      // registry.call re-validates so every binding shares one enforcement
      // path.
      async (args: unknown) => {
        try {
          // A lazy via resolves per call — the stdio server is long-lived and
          // only learns the client's identity at the initialize handshake.
          const via = typeof ctx.via === 'function' ? ctx.via() : ctx.via
          const value = await registry.call(entry.name, args, {
            identity: ctx.identity,
            ...(via !== undefined ? { via } : {}),
          })
          return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
        } catch (error) {
          const body =
            error instanceof RegistryError
              ? error.body
              : { kind: 'internal' as const, error: 'operator tool is unavailable' }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(body) }],
            isError: true,
          }
        }
      },
    )
  }
}

/** The `ab mcp` command core. Returns the process exit code. */
export async function abMcp(opts: AbMcpOpts): Promise<number> {
  // Fail closed before any store open: a complete ambient tuple (or a
  // malformed one) must not start a repository-wide server.
  let ambient: unknown
  try {
    ambient = resolveAmbientReadSession(opts.env)
  } catch (error) {
    if (error instanceof InvalidAmbientContextError) {
      opts.stderr(`${AB_MCP_PHASE_REFUSAL} ${error.message}`)
      return 1
    }
    throw error
  }
  if (ambient !== undefined) {
    opts.stderr(AB_MCP_PHASE_REFUSAL)
    return 1
  }

  const context = await openSessionlessStore({
    targetRepo: opts.targetRepo,
    env: opts.env,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
  })
  try {
    const backend = await buildMcpTicketBackend({
      ...opts,
      checkout: context.checkout,
      localStateRoot: context.localStateRoot,
    })
    // The operator-sandbox backend (AUT-340) is built only when the
    // repository enables it. A construction failure is contained: the
    // server still serves every other tool, one diagnostic names the
    // failure, and the sandbox tools are absent from advertisement AND
    // dispatch (never broken).
    let sandbox: OperatorSandboxService | undefined
    try {
      const configPath = join(context.checkout, 'autobuild.toml')
      let mcpConfig: Config
      try {
        mcpConfig = await loadConfig(configPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `${configPath}: not found — 'ab mcp' reads autobuild.toml from the resolved Git main checkout (SPEC §8.8)`,
          )
        }
        throw error
      }
      if (mcpConfig.orchestrator.enabled) {
        const plugins = await loadPlugins(mcpConfig.plugins, context.checkout)
        const provider = await createWorkspaceProvider(mcpConfig.workspace, {
          registry: plugins,
          worktreeRoot: context.worktreeRoot,
          repoRoot: context.checkout,
          env: opts.env,
          storeRef: context.storeRef,
          ...(context.token !== undefined ? { storeToken: context.token } : {}),
          sandboxSetupCommand: mcpConfig.commands.setup,
          sandboxRoot: join(context.localStateRoot, 'orchestrator-sandboxes'),
          sandboxEnvironmentVariables: mcpConfig.orchestrator.sandbox.environmentVariables,
          orchestratorSandboxEnabled: true,
        })
        // The forge is needed only for sandbox.publish; a construction
        // failure must not drop every sandbox tool, so it is contained here
        // and publication is silently omitted (canPublish stays false).
        let forge: Forge | undefined
        try {
          forge = await createForge({
            name: mcpConfig.forge,
            registry: plugins,
            env: opts.env,
            repoRoot: context.checkout,
            repository: context.repo,
          })
        } catch (forgeError) {
          opts.stderr(
            `ab mcp: forge unavailable, sandbox.publish omitted: ${forgeError instanceof Error ? forgeError.message : String(forgeError)}`,
          )
        }
        sandbox = await createOperatorSandboxService({
          store: context.store,
          repo: context.repo,
          provider,
          sandbox: mcpConfig.orchestrator.sandbox,
          baseBranch: mcpConfig.baseBranch,
          ...(forge !== undefined ? { forge } : {}),
          ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
        })
      }
    } catch (error) {
      opts.stderr(
        `ab mcp: operator sandbox backend unavailable, sandbox tools omitted: ${error instanceof Error ? error.message : String(error)}`,
      )
      sandbox = undefined
    }
    const registry = buildRegistry({
      store: context.store,
      tickets: backend,
      ...(sandbox !== undefined ? { sandbox } : {}),
      clock: opts.clock,
      ...(opts.repo !== undefined ? { allowedRepo: opts.repo } : {}),
    })

    const server = new McpServer(
      { name: 'autobuild', version: AUTOBUILD_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    )
    serveRegistry(registry, server, {
      identity: buildControlUser(opts.env),
      // Unlike the hosted stateless server, the stdio server is long-lived:
      // the initialize handshake populates the client version before any tool
      // call, so the via marker names the connected client.
      via: () => ({ kind: 'mcp', client: server.server.getClientVersion()?.name ?? 'stdio' }),
    })

    const done = new Promise<void>((resolve) => {
      server.server.onclose = () => resolve()
    })
    await server.connect(new StdioServerTransport())
    await done
    return 0
  } finally {
    await context.store.close()
  }
}

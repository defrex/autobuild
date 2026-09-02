/**
 * Shared wiring for the `ab` process entry points. Production calls this with
 * argv only; the repo-local hot entry may additionally supply a per-paint
 * dashboard renderer resolver. All command routing and resource cleanup stay
 * identical between the two entries.
 */
import { join } from 'node:path'
import { isSessionlessInvocation, runCli } from './main'
import { createUpgradeAgentResolver } from './upgrade-agent'
import { loadDotEnv } from './dotenv'
import { MissingAmbientContextError, resolveCliEnv, resolveHarvestCliEnv } from './env'
import { openProductionSessionStore } from './store-opening'
import { processTerminal, processTerminalInput, type TerminalOut } from './terminal'
import { installTerminalRestoreHook, type TerminalRestoreProcess } from './terminal-restore'
import type { DashboardRendererResolver } from './dashboard/render'
import { loadConfig } from '../config/load'
import { loadPlugins } from '../plugins/load'
import { createForge } from '../ports/forge/create'
import { spawnExec } from '../ports/workspace/git-worktree'
import { randomIds } from '../ids'
import { systemClock } from '../store/types'
import { resolveMainRepo } from './repo-state'

/** Upgrade (including its `update` alias) owns Ctrl-C only while raw per-file
 * progress is active. Everywhere else its process must retain Node's ordinary
 * immediate SIGINT termination. */
export function usesGenericSessionlessSigintHandler(command: string | undefined): boolean {
  return command !== 'upgrade' && command !== 'update'
}

export interface SessionlessSigintBoundary {
  on(event: 'SIGINT', listener: () => void): unknown
  once(event: 'SIGINT', listener: () => void): unknown
  removeListener(event: 'SIGINT', listener: () => void): unknown
}

/** Dispatch keeps its listener through the complete child drain; ordinary
 * sessionless commands preserve the historical one-shot cancellation. */
export function installSessionlessSigintHandler(
  command: string | undefined,
  onSigint: () => void,
  boundary: SessionlessSigintBoundary = process,
): () => void {
  if (!usesGenericSessionlessSigintHandler(command)) return () => {}
  if (command === 'dispatch') boundary.on('SIGINT', onSigint)
  else boundary.once('SIGINT', onSigint)
  return () => boundary.removeListener('SIGINT', onSigint)
}

/** Install the dispatch-only process fallback around the exact CLI lifetime. */
export async function withDispatchTerminalRestore<T>(
  command: string | undefined,
  terminal: TerminalOut,
  run: () => Promise<T>,
  boundary: TerminalRestoreProcess = process as unknown as TerminalRestoreProcess,
  requestStop: () => void = () => {},
): Promise<T> {
  const hook =
    command === 'dispatch'
      ? installTerminalRestoreHook(terminal.modes, boundary, requestStop)
      : undefined
  try {
    return await run()
  } finally {
    hook?.close()
  }
}

export async function runBinary(
  argv: string[],
  resolveDashboardRenderer?: DashboardRendererResolver,
): Promise<number> {
  const command = argv[0]
  // Version identity is installation-local and offline; do not inspect even a
  // repository-local .env before routing it.
  if (command !== '--version') {
    // Local .env supplies developer-set secrets (e.g. LINEAR_API_KEY); real
    // environment variables always win over .env values.
    loadDotEnv(join(process.cwd(), '.env'), process.env)
  }

  const unscopedDeps = {
    workspacePath: process.cwd(),
    processEnv: process.env,
    exec: spawnExec,
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  }

  // Sessionless commands resolve their own repository/store and do not require
  // a phase tuple; durable controls also take a target slug and inspect raw
  // AB_SESSION/AB_BUILD only to reject self-control. The flat-name set and
  // mixed nested-command classifier live beside the switch in main.ts.
  if (isSessionlessInvocation(argv)) {
    // The dispatch watch loop runs until SIGINT; abort the signal so it exits
    // cleanly at the next tick boundary (§15.6-C: in-flight leases expire and
    // a future dispatch re-attaches).
    const controller = new AbortController()
    const onSigint = (): void => controller.abort()
    const ownsSigint = usesGenericSessionlessSigintHandler(command)
    const terminal = processTerminal(process.stdout)
    const removeSigint = installSessionlessSigintHandler(command, onSigint)
    try {
      return await withDispatchTerminalRestore(
        command,
        terminal,
        () =>
          runCli(argv, {
            ...unscopedDeps,
            ...(ownsSigint ? { signal: controller.signal } : {}),
            // `ab dispatch`'s dashboard seam: interactive iff stdout is a real
            // TTY, so a pipe or redirect silently gets plain output.
            terminal,
            input: processTerminalInput(process.stdin),
            ...(command === 'init'
              ? { initInteractive: process.stdin.isTTY === true && process.stdout.isTTY === true }
              : {}),
            upgradeResolverFactory: createUpgradeAgentResolver,
            ...(resolveDashboardRenderer !== undefined ? { resolveDashboardRenderer } : {}),
          }),
        process as unknown as TerminalRestoreProcess,
        onSigint,
      )
    } finally {
      removeSigint()
    }
  }

  if (command === 'harvest') {
    let harvestEnv: ReturnType<typeof resolveHarvestCliEnv>
    try {
      harvestEnv = resolveHarvestCliEnv(process.env)
    } catch (error) {
      if (error instanceof MissingAmbientContextError) {
        return runCli(argv, unscopedDeps)
      }
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    const store = openProductionSessionStore(harvestEnv)
    try {
      return await runCli(argv, {
        ...unscopedDeps,
        store,
        harvestEnv,
        ids: randomIds(),
        clock: systemClock,
      })
    } finally {
      await store.close()
    }
  }

  let cliEnv: ReturnType<typeof resolveCliEnv>
  try {
    cliEnv = resolveCliEnv(process.env)
  } catch (error) {
    if (error instanceof MissingAmbientContextError) {
      return runCli(argv, unscopedDeps)
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  // A scoped phase process is composed from the build worktree's immutable
  // configuration just like dispatch. Load and select the forge before opening
  // the store so plugin failures cannot partially execute terminal plumbing.
  let forge: Awaited<ReturnType<typeof createForge>>
  try {
    const repoRoot = process.cwd()
    const packageRoot = await resolveMainRepo(repoRoot, spawnExec)
    const config = await loadConfig(join(repoRoot, 'autobuild.toml'))
    const plugins = await loadPlugins(config.plugins, repoRoot, { packageRoot })
    forge = await createForge({
      name: config.forge,
      registry: plugins,
      env: process.env,
      repoRoot,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const store = openProductionSessionStore(cliEnv)
  try {
    return await runCli(argv, {
      ...unscopedDeps,
      store,
      env: cliEnv,
      forge,
      ids: randomIds(),
      clock: systemClock,
    })
  } finally {
    await store.close()
  }
}

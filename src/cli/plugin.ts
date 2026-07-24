import { join } from 'node:path'
import { loadConfig } from '../config/load'
import { CONTRACT_ADAPTER_ENV, CONTRACT_PORT_ENV, CONTRACT_REPO_ENV } from '../plugins/contract-env'
import { diagnosePlugins, type PluginDiagnosis } from '../plugins/load'
import {
  PLUGIN_PORTS,
  pluginPortLabel,
  type AdapterProjection,
  type PluginPort,
} from '../plugins/registry'
import type { Exec } from '../ports/workspace/git-worktree'
import { resolveMainRepo } from './repo-state'

export interface PluginContractProcessInput {
  repoRoot: string
  port: PluginPort
  adapter: string
  env: Record<string, string | undefined>
  stdout: (line: string) => void
  stderr: (line: string) => void
}

export type PluginContractSubprocess = (input: PluginContractProcessInput) => Promise<number>

export interface PluginCliOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  stderr: (line: string) => void
  subprocess?: PluginContractSubprocess
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function forwardText(text: string, sink: (line: string) => void): void {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (normalized === '') return
  for (const line of normalized.split('\n')) sink(line)
}

export const spawnPluginContract: PluginContractSubprocess = async (input) => {
  const entry = join(import.meta.dir, '..', 'plugins', 'contract-entry.ts')
  const child = Bun.spawn(['bun', 'test', entry], {
    cwd: input.repoRoot,
    env: {
      ...definedEnv(input.env),
      [CONTRACT_REPO_ENV]: input.repoRoot,
      [CONTRACT_PORT_ENV]: input.port,
      [CONTRACT_ADAPTER_ENV]: input.adapter,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  forwardText(stdout, input.stdout)
  forwardText(stderr, input.stderr)
  return status
}

function renderModuleReport(report: PluginDiagnosis['reports'][number]): string {
  const location = report.resolved === undefined ? '' : ` resolved=${report.resolved}`
  const plugin = report.pluginName === undefined ? '' : ` plugin=${report.pluginName}`
  const api =
    report.api === undefined
      ? ''
      : ` api=${report.api.declaredRange} host=${report.api.hostVersion} ${report.api.status}`
  return report.status === 'loaded'
    ? `OK ${report.module} kind=${report.resolutionKind}${location}${plugin}${api}`
    : `FAIL ${report.module} kind=${report.resolutionKind} stage=${report.stage}${location}${plugin}${api}: ${report.error}`
}

function renderAdapter(adapter: AdapterProjection): string {
  const contract = adapter.hasContract
    ? adapter.live
      ? 'contract=live'
      : 'contract=available'
    : 'contract=missing'
  if (adapter.source.kind === 'builtin') {
    return `  ${adapter.name} owner=builtin module=(builtin) resolution=builtin api=host-compatible ${contract}`
  }
  const { source } = adapter
  return (
    `  ${adapter.name} owner=plugin:${source.pluginName} module=${source.module} ` +
    `resolution=${source.resolutionKind} resolved=${source.resolved} ` +
    `api=${source.api.declaredRange} host=${source.api.hostVersion} ${source.api.status} ${contract}`
  )
}

function contractField(port: PluginPort, adapter: string): string {
  const map: Record<PluginPort, string> = {
    'ticket-source': 'ticketSources',
    'agent-runtime': 'agentRuntimes',
    'workspace-provider': 'workspaceProviders',
    forge: 'forges',
  }
  return `${map[port]}.${adapter}.contract.factory`
}

async function loadDiagnosis(opts: PluginCliOpts): Promise<{
  repoRoot: string
  diagnosis: PluginDiagnosis
}> {
  const repoRoot = await resolveMainRepo(opts.targetRepo, opts.exec)
  const configPath = join(repoRoot, 'autobuild.toml')
  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — 'ab plugin' reads autobuild.toml from the resolved Git main checkout`,
      )
    }
    throw error
  }
  return {
    repoRoot,
    diagnosis: await diagnosePlugins(config.plugins, repoRoot),
  }
}

function parsePort(value: string): PluginPort {
  if (!PLUGIN_PORTS.includes(value as PluginPort)) {
    throw new Error(`unknown plugin port "${value}" — expected one of: ${PLUGIN_PORTS.join(', ')}`)
  }
  return value as PluginPort
}

/** Sessionless `ab plugin` operator/authoring namespace. */
export async function abPlugin(argv: readonly string[], opts: PluginCliOpts): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'list') {
    if (rest.length !== 0) throw new Error('usage: ab plugin list')
    const { diagnosis } = await loadDiagnosis(opts)
    opts.stdout('configured modules:')
    if (diagnosis.reports.length === 0) opts.stdout('  (none)')
    for (const report of diagnosis.reports) {
      const line = `  ${renderModuleReport(report)}`
      if (report.status === 'loaded') opts.stdout(line)
      else opts.stderr(line)
    }
    opts.stdout('adapters:')
    for (const port of PLUGIN_PORTS) {
      opts.stdout(`${port}:`)
      for (const adapter of diagnosis.registry.adapters(port)) {
        opts.stdout(renderAdapter(adapter))
      }
    }
    return diagnosis.healthy ? 0 : 1
  }

  if (command === 'doctor') {
    if (rest.length !== 0) throw new Error('usage: ab plugin doctor')
    const { diagnosis } = await loadDiagnosis(opts)
    if (diagnosis.reports.length === 0) {
      opts.stdout('No configured plugin modules.')
    }
    for (const report of diagnosis.reports) {
      const line = renderModuleReport(report)
      if (report.status === 'loaded') opts.stdout(line)
      else opts.stderr(line)
    }
    return diagnosis.healthy ? 0 : 1
  }

  if (command === 'test') {
    if (rest.length !== 2) {
      throw new Error(
        'usage: ab plugin test <ticket-source|agent-runtime|workspace-provider|forge> <adapter>',
      )
    }
    const port = parsePort(rest[0]!)
    const adapter = rest[1]!
    const { repoRoot, diagnosis } = await loadDiagnosis(opts)
    if (!diagnosis.healthy) {
      for (const report of diagnosis.reports) {
        if (report.status === 'failed') opts.stderr(renderModuleReport(report))
      }
      return 1
    }
    const registration = diagnosis.registry.registration(port, adapter)
    if (registration === undefined) {
      const names = diagnosis.registry.adapters(port).map((entry) => entry.name)
      throw new Error(
        `unknown ${pluginPortLabel(port)} adapter "${adapter}" — configured adapters: ${names.join(', ') || '(none)'}`,
      )
    }
    if (registration.contract === undefined) {
      throw new Error(
        `${pluginPortLabel(port)} adapter "${adapter}" cannot be contract-tested: ` +
          `its manifest does not provide ${contractField(port, adapter)}. ` +
          'Register the adapter as { factory, contract: { factory } } where the contract factory returns the shared suite harness factory.',
      )
    }
    if (registration.contract.live === true && opts.env.AB_RUN_LIVE_PORT_CONTRACTS !== '1') {
      throw new Error(
        `${pluginPortLabel(port)} adapter "${adapter}" declares a live contract; ` +
          'set AB_RUN_LIVE_PORT_CONTRACTS=1 to explicitly allow external side effects',
      )
    }
    return await (opts.subprocess ?? spawnPluginContract)({
      repoRoot,
      port,
      adapter,
      env: opts.env,
      stdout: opts.stdout,
      stderr: opts.stderr,
    })
  }

  throw new Error(
    'usage: ab plugin <list|doctor|test> — test requires <ticket-source|agent-runtime|workspace-provider|forge> <adapter>',
  )
}

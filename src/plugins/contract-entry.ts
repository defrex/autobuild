import { join } from 'node:path'
import { loadConfig } from '../config/load'
import { describeForgeContract, type ForgeContractFactory } from '../ports/forge/contract'
import {
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from '../ports/runner/contract'
import {
  describeTicketSourceContract,
  type TicketSourceContractFactory,
} from '../ports/tickets/contract'
import {
  describeWorkspaceProviderContract,
  type WorkspaceProviderContractFactory,
} from '../ports/workspace/contract'
import {
  CONTRACT_ADAPTER_ENV,
  CONTRACT_PORT_ENV,
  CONTRACT_REPO_ENV,
} from './contract-env'
import { loadPlugins } from './load'
import { PLUGIN_PORTS, type PluginPort } from './registry'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`plugin contract runner requires private environment ${name}`)
  }
  return value
}

const repoRoot = requiredEnv(CONTRACT_REPO_ENV)
const rawPort = requiredEnv(CONTRACT_PORT_ENV)
const adapter = requiredEnv(CONTRACT_ADAPTER_ENV)
if (!PLUGIN_PORTS.includes(rawPort as PluginPort)) {
  throw new Error(
    `${CONTRACT_PORT_ENV} must be one of ${PLUGIN_PORTS.join(', ')}; got "${rawPort}"`,
  )
}
const port = rawPort as PluginPort
const config = await loadConfig(join(repoRoot, 'autobuild.toml'))
const registry = await loadPlugins(config.plugins, repoRoot)
const registration = registry.registration(port, adapter)
if (registration === undefined) {
  throw new Error(`unknown ${port} adapter "${adapter}"`)
}
if (registration.contract === undefined) {
  throw new Error(`${port} adapter "${adapter}" has no contract fixture descriptor`)
}
if (
  registration.contract.live === true &&
  process.env['AB_RUN_LIVE_PORT_CONTRACTS'] !== '1'
) {
  throw new Error(
    'live plugin contracts require AB_RUN_LIVE_PORT_CONTRACTS=1',
  )
}

const contractFactory = await registration.contract.factory({
  config: {},
  env: process.env,
  repoRoot,
})
if (typeof contractFactory !== 'function') {
  throw new Error(
    `${port} adapter "${adapter}" contract.factory must return the shared suite's harness factory`,
  )
}

switch (port) {
  case 'ticket-source':
    describeTicketSourceContract(adapter, contractFactory as TicketSourceContractFactory)
    break
  case 'agent-runtime':
    describeAgentRunnerContract(adapter, contractFactory as AgentRunnerContractFactory)
    break
  case 'workspace-provider':
    describeWorkspaceProviderContract(
      adapter,
      contractFactory as WorkspaceProviderContractFactory,
    )
    break
  case 'forge':
    describeForgeContract(adapter, contractFactory as ForgeContractFactory)
    break
}

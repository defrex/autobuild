/**
 * Stable plugin-authoring surface. Internal source paths are not public API;
 * plugins should import only `autobuild/plugin-sdk` (normally with
 * `import type`) and run these same contracts against their adapters.
 */
export type * from '../ports/types'
export type * from '../store/types'
export type {
  RuntimeRegistration,
  RuntimeRegistry,
} from '../ports/runner/runtime'
export type {
  OneShotCompletion,
  OneShotCompletionInput,
  OneShotCompletionResult,
} from '../ports/runner/one-shot'

export {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
  parsePluginManifest,
} from '../plugins/manifest'
export type {
  AgentRuntimePluginFactory,
  AutobuildPluginManifest,
  ForgePluginFactory,
  PluginFactory,
  PluginFactoryContext,
  TicketSourcePluginFactory,
  WorkspaceProviderPluginFactory,
} from '../plugins/manifest'

export {
  describeTicketSourceContract,
  CONTRACT_TICKET_BODY,
  contractIdempotencyKey,
  contractTicketTitle,
} from '../ports/tickets/contract'
export type {
  TicketSourceContractFactory,
  TicketSourceContractHarness,
  TicketSourceContractStates,
} from '../ports/tickets/contract'

export { describeWorkspaceProviderContract } from '../ports/workspace/contract'
export type {
  WorkspaceProviderContractFactory,
  WorkspaceProviderContractHarness,
} from '../ports/workspace/contract'

export { describeForgeContract } from '../ports/forge/contract'
export type {
  ForgeContractControls,
  ForgeContractFactory,
  ForgeContractFactoryOptions,
  ForgeContractHarness,
} from '../ports/forge/contract'

export {
  describeBlobStoreContract,
  describeBuildStoreContract,
  CONTRACT_T0,
  ISO_TS,
  buildCreatedWrite,
  harvestStartedWrite,
  planCompletedWrite,
  sampleBuildInput,
  sampleEventWrite,
} from '../store/contract'
export type {
  BlobStoreFactory,
  BlobStoreHarness,
  BuildStoreFactory,
  BuildStoreHarness,
} from '../store/contract'

export { FakeTicketSource } from '../ports/tickets/fake'
export { FakeWorkspaceProvider } from '../ports/workspace/fake'
export { FakeForge } from '../ports/forge/fake'
export { ScriptedAgentRunner } from '../ports/runner/fake'
export { MemoryBlobStore, MemoryBuildStore } from '../store/memory'

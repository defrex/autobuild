/**
 * Stable plugin-authoring surface. Internal source paths are not public API;
 * plugins should import only `@defrex/autobuild/plugin-sdk` (normally with
 * `import type`) and run these same contracts against their adapters.
 */
export type * from '../ports/types'
export type * from '../ports/workspace/build-execution'
export type * from '../store/types'
export type {
  RuntimeRegistration,
  RuntimeRegistry,
  SessionStreamInfo,
} from '../ports/runner/runtime'
export {
  STREAM_PART_MAX_BYTES,
  abortPart,
  errorPart,
  finishPart,
  finishStepPart,
  promptPart,
  reasoningDeltaPart,
  reasoningEndPart,
  reasoningStartPart,
  sessionPart,
  startPart,
  startStepPart,
  textDeltaPart,
  textEndPart,
  textStartPart,
  toolInputPart,
  toolOutputPart,
  truncationPart,
} from '../ports/runner/stream-parts'
export type {
  OneShotCompletion,
  OneShotCompletionInput,
  OneShotCompletionResult,
} from '../ports/runner/one-shot'

export {
  CONTRACT_FOLLOW_UP,
  CONTRACT_INVOCATION,
  CONTRACT_ONE_SHOT_PROMPT,
  CONTRACT_ONE_SHOT_TEXT,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  CONTRACT_SKILL,
  describeAgentRunnerContract,
} from '../ports/runner/contract'
export type {
  AgentRunnerContractFactory,
  AgentRunnerContractHarness,
  AgentRunnerContractOneShotHarness,
  AgentRunnerContractOneShotObservation,
  AgentRunnerContractScenario,
  AgentRunnerContractTurnObservation,
} from '../ports/runner/contract'

export {
  PLUGIN_API_VERSION,
  PluginApiCompatibilityError,
  pluginApiCompatibility,
  pluginManifestSchema,
  parsePluginManifest,
} from '../plugins/manifest'
export type {
  AgentRuntimePluginFactory,
  AgentRuntimePluginRegistration,
  AutobuildPluginManifest,
  ForgePluginFactory,
  ForgePluginRegistration,
  PluginAdapterRegistration,
  PluginApiCompatibility,
  PluginContractDescriptor,
  PluginFactory,
  PluginFactoryContext,
  TicketSourcePluginDescriptor,
  TicketSourcePluginFactory,
  TicketSourcePluginRegistration,
  WorkspaceProviderPluginDescriptor,
  WorkspaceProviderPluginFactory,
  WorkspaceProviderPluginRegistration,
} from '../plugins/manifest'
export type {
  GuestProbeReport,
  InitValidationReport,
  ReadinessCheck,
  WorkspaceProviderCapabilities,
  WorkspaceProviderEnvRequirement,
  WorkspaceReadinessContext,
} from '../ports/workspace/provider-capabilities'

export {
  describeTicketSourceContract,
  CONTRACT_TICKET_BODY,
  contractIdempotencyKey,
  contractLabelName,
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
  messagePostedWrite,
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
export { validateTicketUpdate } from '../ports/tickets/update'
export { FakeWorkspaceProvider } from '../ports/workspace/fake'
export { FakeForge } from '../ports/forge/fake'
// ScriptContext + defaultTurnResult are the scripted fake's own API: the
// script callback's context type and its default turn result (needed by the
// hosted-dispatcher integration test to script guest agents).
export {
  defaultTurnResult,
  ScriptedAgentRunner,
  type ScriptContext,
} from '../ports/runner/fake'
export { MemoryBlobStore, MemoryBuildStore } from '../store/memory'

// Runtime primitives needed by out-of-tree BuildStore adapters.
export { validateEventWrite } from '../events/catalog'
export type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
export type { EventType } from '../events/payloads'
export { validateRepositoryEventWrite } from '../events/repository'
export type {
  RepositoryEvent,
  RepositoryEventEnvelope,
  RepositoryEventType,
  RepositoryEventWrite,
} from '../events/repository'
export { BuildScopeError, createBuildScopedStore } from '../store/build-scope'
export { createSessionStreamSink } from '../store/streams/session-writer'
export { pollingSubscribe } from '../store/subscribe'
export { assembleUIMessageDocument } from '../store/streams/assemble'
export { readStreamWithWait, STREAM_WAIT_POLL_MS } from '../store/streams/wait'
export {
  clampWaitSeconds,
  MAX_STREAM_WAIT_SECONDS,
  serializedBatchSize,
  STREAM_BATCH_MAX_BYTES,
  STREAM_FORMAT,
  StreamBatchTooLargeError,
  StreamClosedError,
  streamArtifactInput,
  validateStreamParts,
} from '../store/streams/types'
export type {
  StreamArtifactRef,
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
  StreamStatus,
} from '../store/streams/types'
export { contentHash, systemClock, toBytes, validateExpectedSeq } from '../store/types'

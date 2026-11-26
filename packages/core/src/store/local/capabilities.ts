/**
 * Store capabilities a short-lived reader may never use, initialized on first
 * need. A process that only reads its repository record and change position
 * never evaluates the event catalogs, the write validators or the reducers.
 *
 * Rule for every use: take `capability.value ?? (await capability.load())` as
 * the method's first statement, before any transaction, read or mutation, and
 * use the resolved functions synchronously where they were used before. Every
 * write is therefore still validated before it mutates anything, and once a
 * capability is loaded a method runs with no added await at all. A failed load
 * is not remembered: the next use retries it, and the error reaches the caller.
 */
export class Capability<T> {
  value: T | undefined
  private pending: Promise<T> | undefined

  constructor(private readonly initialize: () => Promise<T>) {}

  load(): Promise<T> {
    this.pending ??= this.initialize().then(
      (value) => {
        this.value = value
        return value
      },
      (error: unknown) => {
        this.pending = undefined
        throw error
      },
    )
    return this.pending
  }
}

/** Build, repository and session event validation, plus the build-creation and
 * tick-finish checks. */
export const writeValidation = new Capability(async () => {
  const [catalog, repository, sessions, newBuild, repoTick] = await Promise.all([
    import('../../events/catalog'),
    import('../../events/repository'),
    import('../../events/sessions'),
    import('../new-build'),
    import('../repo-tick'),
  ])
  return {
    validateEventWrite: catalog.prepareEventWrite,
    validateRepositoryEventWrite: repository.prepareRepositoryEventWrite,
    validateSessionEventWrite: sessions.validateSessionEventWrite,
    validateCreatedEvent: newBuild.validateCreatedEvent,
    validateTickFinish: repoTick.validateTickFinish,
  }
})

/** Strict build-event payload schemas. */
export const payloadSchemas = new Capability(async () => {
  const { eventPayloadSchemas } = await import('../../events/payloads')
  return { eventPayloadSchemas }
})

/** Named reducer values over the selective index: only the requested reducer's
 * module initializes. Never the complete catalog unless a request names a
 * reducer outside the index. */
export const reducedValues = new Capability(async () => {
  const [read, index] = await Promise.all([
    import('../reducer-value-read'),
    import('../../kernel/reducer-value-index'),
  ])
  return {
    parseValueRequest: read.parseValueRequest,
    resolveRegisteredValue: read.resolveRegisteredValue,
    readResolvedReducerValue: read.readResolvedReducerValue,
    loadValueRegistration: index.loadValueRegistration,
    loadedValueRegistration: index.loadedValueRegistration,
  }
})

/** Saved build digests for open-build and repository digest listings. */
export const buildDigests = new Capability(async () => {
  const { readPersistedBuildDigests } = await import('../reduced-reads')
  return { readPersistedBuildDigests }
})

/** Repository rollups (the derived-reducer engine). */
export const rollups = new Capability(async () => {
  const { readRollupValue } = await import('../rollups')
  return { readRollupValue }
})

/** The repository state-event selection. */
export const repositoryStateEvents = new Capability(async () => {
  const module = await import('../repo-state-events')
  return {
    REPOSITORY_STATE_EVENT_TYPES: module.REPOSITORY_STATE_EVENT_TYPES,
    REPOSITORY_LATEST_EVENT_TYPES: module.REPOSITORY_LATEST_EVENT_TYPES,
    readRepoStateEventsWithAnchorRecheck: module.readRepoStateEventsWithAnchorRecheck,
  }
})

/** Ticket asset storage and pinning. */
export const ticketAssetCapability = new Capability(async () => {
  const module = await import('../ticket-assets')
  return {
    DEFAULT_TICKET_ASSET_LIMITS: module.DEFAULT_TICKET_ASSET_LIMITS,
    loadTicketAsset: module.loadTicketAsset,
    storeTicketAssetBlobs: module.storeTicketAssetBlobs,
    resolvePinnedAsset: module.resolvePinnedAsset,
    summarizeTicketAsset: module.summarizeTicketAsset,
    validateTicketAssetInput: module.validateTicketAssetInput,
  }
})

/** UI message stream assembly at close. */
export const streamAssembly = new Capability(async () => {
  const { assembleUIMessageDocument } = await import('../streams/assemble')
  return { assembleUIMessageDocument }
})

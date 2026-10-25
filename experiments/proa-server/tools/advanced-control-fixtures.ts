/** Full node landing and immutable ticket-asset answer oracle; production never imports it. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import type {
  ArtifactInput,
  BuildStore,
  NewBuildInput,
} from '../../../packages/core/src/store/types'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { FakeTicketSource } from '../../../packages/core/src/ports/tickets/fake'
import type { Ticket, TicketSource } from '../../../packages/core/src/ports/types'
import { parseConfig } from '../../../packages/core/src/config/load'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { sources, experiment } from './fixture-core'
import { operatorClock, operatorRepo } from './operator-fixtures'

export const advancedConfig = parseConfig(
  '[tickets]\nsource="hosted"\nteamKey="ENG"\nreadyState="ready"\ntriageState="triage"\nclaimedState="doing"\ndoneState="done"\n',
)
export const advancedLifecycle = { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' }
const corpusPath = resolve(experiment, 'fixtures/advanced-control-corpus.json')
const secret = 'offline-operator-fixture-secret'
const clock = () => new Date(operatorClock)
const spec = '## Acceptance criteria\n- Replacement works\n## Out of scope\nOther features\n'
export const advancedScenarios = [
  'node-land-complete',
  'node-land-open-source-child',
  'node-land-frozen-child',
  'node-land-uncovered-frozen-child',
  'node-land-empty',
  'node-land-source-mismatch',
  'revise-hosted-empty',
  'revise-hosted-file',
  'revise-hosted-tree',
  'revise-hosted-chunk-boundaries',
  'revise-hosted-latest-and-removed',
  'revise-supplied-preserves-assets',
  'revise-no-ticket',
  'revise-nonhosted-store-assets',
  'revise-hosted-legacy-alias',
  'node-revise-hosted-file',
  'node-revise-supplied',
] as const
export type AdvancedScenario = (typeof advancedScenarios)[number]
export interface AssetSeed {
  ticketId: string
  kind: string
  name: string
  layout: 'file' | 'tree'
  entries: ({ type: 'dir'; path: string } | { type: 'file'; path: string; base64: string })[]
  removed?: boolean
}
function ticket(
  id: string,
  kind: 'node' | 'work' = 'work',
  state = 'done',
  target?: string,
): Ticket {
  return {
    ref: { source: 'database', id, title: `Ticket ${id}` },
    revision: '1',
    title: `Ticket ${id}`,
    body: spec,
    kind,
    state,
    resolved: state === 'done',
    labels: [],
    ...(target ? { target } : {}),
  }
}
export function advancedBindings(
  value: unknown,
  kinds: readonly string[],
  hashes: readonly string[],
): unknown {
  if (typeof value === 'string') {
    let result = value
    kinds.forEach((kind, index) => {
      result = result.replaceAll(kind, `$snapshot:${index}`)
    })
    hashes.forEach((hash, index) => {
      result = result.replaceAll(hash, `$manifest-sha256:${index}`)
    })
    return result
  }
  if (Array.isArray(value)) return value.map((item) => advancedBindings(item, kinds, hashes))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, advancedBindings(item, kinds, hashes)]),
    )
  return value
}
export async function advancedSnapshot(
  store: BuildStore,
  repo: string,
  slugs: readonly string[],
  snapshotKinds: string[],
) {
  const builds = await Promise.all(
    slugs.map(async (slug) => {
      // PostgreSQL jsonb stores the JSON wire bytes: optional undefined fields
      // never become durable facts (the in-memory adapter can retain them).
      const events = JSON.parse(JSON.stringify(await store.getEvents(slug))) as Awaited<
        ReturnType<BuildStore['getEvents']>
      >
      const artifacts = await Promise.all(
        (await store.listArtifacts(slug)).map(async (meta) => ({
          meta,
          base64: Buffer.from(
            (await store.getArtifact(slug, meta.kind, meta.revision))!.content,
          ).toString('base64'),
        })),
      )
      return {
        record: await store.getBuild(slug),
        events,
        state: encodeReducerValue(reduceBuild(events)),
        artifacts,
      }
    }),
  )
  const repository = await store.getRepoEvents(repo)
  const manifestKinds = new Set(
    builds.flatMap((build) =>
      reduceBuild(build.events).pinnedAssets.flatMap((pin) =>
        pin.snapshot ? [pin.snapshot.kind] : [],
      ),
    ),
  )
  const repositoryArtifacts = await Promise.all(
    (await store.listRepoArtifacts(repo)).map(async (meta) => {
      const content = (await store.getRepoArtifact(repo, meta.kind, meta.revision))!.content
      // Independently generated snapshot identifiers change compressed bytes and
      // their SHA256. Bind those dependencies only, while testing the actual hash.
      const actualHash = createHash('sha256').update(content).digest('hex')
      if (actualHash !== meta.blobRef) throw new Error('artifact bytes do not match metadata hash')
      if (manifestKinds.has(meta.kind)) {
        const decoded: unknown = JSON.parse(gunzipSync(content).toString('utf8'))
        return { meta, encoding: 'gzip-json' as const, content: decoded }
      }
      return { meta, encoding: 'base64' as const, content: Buffer.from(content).toString('base64') }
    }),
  )
  // Store metadata sorts random kind names; creation order is the stable
  // operation order, captured at the put boundary or reconstructed via pins.
  repositoryArtifacts.sort(
    (a, b) => snapshotKinds.indexOf(a.meta.kind) - snapshotKinds.indexOf(b.meta.kind),
  )
  const orderedHashes = repositoryArtifacts
    .filter((a) => a.encoding === 'gzip-json')
    .map((a) => a.meta.blobRef)
  return { builds, repository, repositoryArtifacts, manifestHashes: orderedHashes }
}
export async function replayAdvancedScenario(id: AdvancedScenario) {
  const store = new MemoryBuildStore({ clock })
  const snapshotKinds: string[] = []
  const putRepo = store.putRepoArtifact.bind(store)
  store.putRepoArtifact = async (repo: string, input: ArtifactInput) => {
    const meta = await putRepo(repo, input)
    if (input.kind.startsWith('ticket-snapshot-')) snapshotKinds.push(input.kind)
    return meta
  }
  await store.ensureRepo(operatorRepo)
  const source = new FakeTicketSource([], { doneState: 'done', createState: 'triage' })
  Object.defineProperty(source, 'name', { value: 'database' })
  Object.defineProperty(source, 'assets', { value: store })
  const tickets: Ticket[] = [ticket('ENG-1', 'node'), ticket('ENG-2', 'work', 'done', 'ENG-1')]
  const inputs: NewBuildInput[] = []
  const assetSeeds: AssetSeed[] = []
  const slugs: string[] = []
  const add = async (
    slug: string,
    ref: { source: string; id: string },
    kind: 'node' | 'work',
    target?: string,
  ) => {
    const input: NewBuildInput = {
      slug,
      repo: operatorRepo,
      ticket: ref,
      created: {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: {
          repo: operatorRepo,
          ticket: ref,
          baseBranch: 'main',
          kind,
          ...(target
            ? { target: { ticket: { source: 'database', id: 'ENG-1' }, build: target } }
            : {}),
        },
      },
    }
    if (id === 'revise-supplied-preserves-assets' && input.created)
      input.created.payload.assets = [
        {
          kind: 'design',
          name: 'reference',
          revision: 0,
          layout: 'file',
          size: 4,
          fileCount: 1,
          dirCount: 0,
        },
      ]
    inputs.push(input)
    slugs.push(slug)
    await store.createBuild(input)
  }
  const nodeLand = id.startsWith('node-land')
  const nodeRevise = id.startsWith('node-revise')
  const noTicket = id === 'revise-no-ticket'
  const nonhosted = id === 'revise-nonhosted-store-assets'
  const ref = {
    source: nonhosted || id === 'node-land-source-mismatch' ? 'file' : 'hosted',
    id:
      id === 'node-land-source-mismatch'
        ? 'OLD-1'
        : id === 'revise-hosted-legacy-alias'
          ? 'storage-ticket-1'
          : 'ENG-1',
  }
  await add('advanced-build', ref, nodeLand || nodeRevise ? 'node' : 'work')
  if (id === 'revise-hosted-legacy-alias') {
    const originalGet = store.getBuild.bind(store)
    store.getBuild = async (slug) => {
      const record = await originalGet(slug)
      return record?.ticket?.id === 'storage-ticket-1'
        ? { ...record, ticket: { ...record.ticket, id: 'ENG-1' } }
        : record
    }
  }
  if (noTicket) {
    // The API's record gate is independent of build.created's frozen ticket.
    const originalGet = store.getBuild.bind(store)
    store.getBuild = async (slug) => {
      const record = await originalGet(slug)
      if (!record || slug !== 'advanced-build') return record
      const { ticket: _, ...rest } = record
      return rest
    }
    delete inputs[0]!.ticket
  }
  if (nodeLand || nodeRevise) {
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'node.opened',
      payload: { sha: 'head' },
    })
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'node.compared',
      payload: { headSha: 'head', parentSha: 'base', ahead: 1 },
    })
  } else {
    await store.append('advanced-build', {
      actor: { kind: 'kernel' },
      type: 'runner.attached',
      payload: { instance: 'test', host: 'test', resumedFromSeq: 0 },
    })
    await store.append('advanced-build', {
      actor: { kind: 'agent', role: 'implement', session: 'phase' },
      type: 'escalation.raised',
      payload: {
        id: 'esc-advanced',
        phase: 'implement',
        round: 1,
        source: 'agent',
        question: 'Revise?',
      },
    })
  }
  if (nodeLand) {
    if (id !== 'node-land-empty') {
      await add(
        'advanced-contribution',
        { source: 'database', id: 'ENG-2' },
        'work',
        'advanced-build',
      )
      await store.append('advanced-contribution', {
        actor: { kind: 'dispatcher' },
        type: 'pr.merged',
        payload: { sha: 'landed' },
      })
      await store.append('advanced-contribution', {
        actor: { kind: 'dispatcher' },
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
    }
    if (id === 'node-land-open-source-child')
      tickets.push(ticket('ENG-3', 'work', 'triage', 'ENG-1'))
    if (id === 'node-land-uncovered-frozen-child') {
      tickets.push(ticket('ENG-3', 'work', 'triage'))
      await add('advanced-open', { source: 'file', id: 'OLD-3' }, 'work', 'advanced-build')
    }
    if (id === 'node-land-frozen-child') {
      tickets.push(ticket('ENG-3', 'work', 'triage'))
      await add('advanced-open', { source: 'database', id: 'ENG-3' }, 'work', 'advanced-build')
    }
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'integration.prepared',
      payload: { id: 'cycle', head: 'head', parent: 'base', config: '{}' },
    })
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'pr.opened',
      payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
    })
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'landing.decided',
      payload: {
        candidate: { head: 'head', parent: 'base', cycle: 'cycle' },
        from: 'node',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
      },
    })
  }
  const wantsFile = [
    'revise-hosted-file',
    'revise-hosted-legacy-alias',
    'revise-hosted-latest-and-removed',
    'revise-supplied-preserves-assets',
    'revise-nonhosted-store-assets',
    'node-revise-hosted-file',
  ].includes(id)
  if (wantsFile)
    assetSeeds.push({
      ticketId: 'ENG-1',
      kind: 'design',
      name: 'reference',
      layout: 'file',
      entries: [
        {
          type: 'file',
          path: 'reference.bin',
          base64: Buffer.from([0, 255, 10, 38]).toString('base64'),
        },
      ],
    })
  if (id === 'revise-hosted-chunk-boundaries')
    assetSeeds.push({
      ticketId: 'ENG-1',
      kind: 'design',
      name: 'reference',
      layout: 'tree',
      entries: [
        { type: 'dir', path: 'empty-dir' },
        { type: 'file', path: 'empty.bin', base64: '' },
        {
          type: 'file',
          path: 'large.bin',
          base64: Buffer.from(
            Uint8Array.from({ length: 256 * 1024 + 1 }, (_, index) => index % 251),
          ).toString('base64'),
        },
      ],
    })
  if (id === 'revise-hosted-tree')
    assetSeeds.push({
      ticketId: 'ENG-1',
      kind: 'design',
      name: 'reference',
      layout: 'tree',
      entries: [
        { type: 'dir', path: 'empty' },
        {
          type: 'file',
          path: 'images/a.bin',
          base64: Buffer.from('asset bytes\n').toString('base64'),
        },
      ],
    })
  if (id === 'revise-hosted-latest-and-removed')
    assetSeeds.push(
      {
        ticketId: 'ENG-1',
        kind: 'design',
        name: 'reference',
        layout: 'file',
        entries: [
          {
            type: 'file',
            path: 'reference.bin',
            base64: Buffer.from('new revision').toString('base64'),
          },
        ],
      },
      {
        ticketId: 'ENG-1',
        kind: 'context',
        name: 'removed',
        layout: 'file',
        entries: [{ type: 'file', path: 'old', base64: Buffer.from('old').toString('base64') }],
        removed: true,
      },
    )
  for (const seed of assetSeeds) {
    await store.putTicketAsset(operatorRepo, seed.ticketId, {
      kind: seed.kind,
      name: seed.name,
      layout: seed.layout,
      entries: seed.entries.map((entry) =>
        entry.type === 'dir'
          ? entry
          : {
              type: 'file',
              path: entry.path,
              content: new Uint8Array(Buffer.from(entry.base64, 'base64')),
            },
      ),
    })
    if (seed.removed)
      await store.removeTicketAsset(operatorRepo, seed.ticketId, seed.kind, seed.name)
  }
  if (id === 'revise-supplied-preserves-assets') {
    await store.append('advanced-build', {
      actor: { kind: 'dispatcher' },
      type: 'spec.imported',
      payload: { ticket: ref, artifact: { kind: 'spec', rev: 0 } },
    })
    await store.putArtifact('advanced-build', { kind: 'spec', content: 'original spec' })
  }
  // FakeTicketSource's constructor clones, so seed after the scenario finishes shaping membership.
  const nativeSource = new FakeTicketSource(tickets, { doneState: 'done', createState: 'triage' })
  Object.defineProperty(nativeSource, 'name', { value: 'database' })
  Object.defineProperty(nativeSource, 'assets', { value: store })
  const backend = nonhosted
    ? undefined
    : {
        contextFor: async () => ({
          repo: operatorRepo,
          tickets: advancedConfig.tickets,
          teamKey: 'ENG',
        }),
        sourceFor: () => nativeSource as TicketSource,
        statesFor: () => ['triage', 'ready', 'doing', 'done'],
      }
  const seedSnapshot = await advancedSnapshot(store, operatorRepo, slugs, snapshotKinds)
  const path = nodeLand ? 'builds/advanced-build/control' : 'builds/advanced-build/answer'
  const body = nodeLand
    ? { action: 'land' }
    : {
        resolution: 'revise-spec',
        origin:
          id === 'revise-supplied-preserves-assets' || id === 'node-revise-supplied'
            ? 'body'
            : 'ticket',
        body: spec,
      }
  const server = createOperatorServer({
    store,
    secret,
    clock,
    projects: testProjects([operatorRepo]),
    ...(backend ? { ticketBackend: backend } : {}),
  })
  const token = mintToken(secret, {
    version: 1,
    internalOperator: { user: 'operator@example.com', repo: operatorRepo },
    exp: clock().getTime() + 60000,
  })
  const response = await server.fetch(
    new Request(
      `https://fixture.invalid/operator/v1/repos/${encodeURIComponent(operatorRepo)}/${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    ),
  )
  const after = await advancedSnapshot(store, operatorRepo, slugs, snapshotKinds)
  const result = {
    id,
    repo: operatorRepo,
    config: advancedConfig,
    ticketBackend: !nonhosted,
    tickets,
    inputs,
    assetSeeds,
    request: { path, body },
    seed: seedSnapshot,
    status: response.status,
    body: (await response.json()) as unknown,
    after,
  }
  return JSON.parse(
    JSON.stringify(advancedBindings(result, snapshotKinds, after.manifestHashes)),
  ) as typeof result
}
export async function generateAdvancedCorpus() {
  const fixtures = []
  for (const id of advancedScenarios) fixtures.push(await replayAdvancedScenario(id))
  return {
    format: 1,
    clock: operatorClock,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(sources()))
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    bindings: {
      snapshot: 'Generated ticket-snapshot UUIDs bound in deposit order',
      manifestHash:
        'SHA256 of gzip manifest containing bound UUIDs; actual hash independently checked against bytes before binding',
    },
    fixtures,
  }
}
export async function checkAdvancedCorpus() {
  const generated = await generateAdvancedCorpus()
  if (!isDeepStrictEqual(generated, JSON.parse(readFileSync(corpusPath, 'utf8'))))
    throw new Error('Advanced control corpus is stale')
  return generated
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    writeFileSync(corpusPath, `${JSON.stringify(await generateAdvancedCorpus(), null, 2)}\n`)
  else await checkAdvancedCorpus()
}

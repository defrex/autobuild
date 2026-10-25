/** Isolated producer replay. Never imports the shared-database dev seed entry. */
import { SQL } from 'bun'
import { randomBytes } from 'node:crypto'
import { PostgresConnectionStore } from '../../../packages/postgres-store/src/connections'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepareHappyScenario, prepareScenario } from '../../../tools/dashboard-capture'
import type { E2eHarness } from '../../../packages/core/src/scenarios/harness'
import type { BuildStore, Clock } from '../../../packages/core/src/store/types'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import { witnessEvent, schemas } from './fixture-core'
import { withDataServices } from './data-services'
import { seedExtendedBrowserControls, type ExtendedBrowserFixture } from './browser-extended-seed'

export interface ReplayEvidence {
  timestampShiftMs: number
  producer: string
  sourceHash: string
  sourceProject: string
  project: string
  builds: {
    source: string
    target: string
    events: number
    artifacts: { kind: string; revision: number }[]
  }[]
  repositoryEvents: number
  repositoryArtifacts: { kind: string; revision: number }[]
}
export interface SeedEvidence {
  adapterHash: string
  completedBeforeServerStart: true
  database: string
  loopback: true
  producers: ReplayEvidence[]
  supplemental: string[]
  detail: { project: string; slug: string }
  controls: Record<string, { project: string; slug: string }>
  extendedControls: ExtendedBrowserFixture[]
  connect?: Record<string, string>
}
const hash = () =>
  createHash('sha256')
    .update(readFileSync(resolve(import.meta.dir, '../../../tools/dashboard-capture.ts')))
    .digest('hex')
export async function replay(
  harness: E2eHarness,
  target: BuildStore,
  project: string,
  producer: string,
  clock: Clock & { set(date: Date): void },
): Promise<ReplayEvidence> {
  const source = harness.store
  const records = (await source.listBuilds()).filter((r) => r.repo === harness.origin)
  if (!records.length) throw Error(`${producer}: producer supplied no builds`)
  const logs = new Map(
    await Promise.all(
      records.map(async (record) => [record.slug, await source.getEvents(record.slug)] as const),
    ),
  )
  const repositoryLog = await source.getRepoEvents(harness.origin)
  const newest = Math.max(
    ...repositoryLog.map((e) => Date.parse(e.ts)),
    ...[...logs.values()].flat().map((e) => Date.parse(e.ts)),
  )
  const timestampShiftMs = Date.now() - 30_000 - newest
  const stamp = (ts: string) => clock.set(new Date(Date.parse(ts) + timestampShiftMs))
  const aliases = new Map(
    records.map((r) => [
      r.slug,
      `${producer === 'prepareHappyScenario' ? 'happy' : 'mixed'}-${r.slug}`,
    ]),
  )
  const rename = <T>(value: T): T => {
    const visit = (item: unknown): unknown =>
      typeof item === 'string'
        ? (aliases.get(item) ?? item.replaceAll(harness.origin, project))
        : Array.isArray(item)
          ? item.map(visit)
          : item && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]))
            : item
    return visit(value) as T
  }
  await target.ensureRepo(project)
  const repositoryArtifacts = []
  for (const meta of await source.listRepoArtifacts(harness.origin)) {
    const artifact = await source.getRepoArtifact(harness.origin, meta.kind, meta.revision)
    if (!artifact) throw Error('Producer repository artifact missing')
    stamp(meta.createdAt)
    const deposited = await target.putRepoArtifact(project, {
      kind: meta.kind,
      content: artifact.content,
      metadata: rename(meta.metadata),
    })
    if (deposited.revision !== meta.revision) throw Error('Repository artifact revision mismatch')
    repositoryArtifacts.push({ kind: meta.kind, revision: meta.revision })
  }
  const repositoryEvents = repositoryLog
  for (const event of repositoryEvents) {
    stamp(event.ts)
    const stored = await target.appendRepo(project, {
      actor: event.actor,
      type: event.type,
      payload: rename(event.payload),
    } as Parameters<BuildStore['appendRepo']>[1])
    if (stored.seq !== event.seq) throw Error('Repository event sequence mismatch')
  }
  const builds = []
  for (const record of records) {
    const slug = aliases.get(record.slug)!
    stamp(record.createdAt)
    await target.createBuild({ slug, repo: project, ticket: record.ticket, branch: record.branch })
    const artifacts = []
    for (const meta of await source.listArtifacts(record.slug)) {
      const artifact = await source.getArtifact(record.slug, meta.kind, meta.revision)
      if (!artifact) throw Error('Producer build artifact missing')
      stamp(meta.createdAt)
      const deposited = await target.putArtifact(slug, {
        kind: meta.kind,
        content: artifact.content,
        metadata: rename(meta.metadata),
      })
      if (deposited.revision !== meta.revision) throw Error('Build artifact revision mismatch')
      artifacts.push({ kind: meta.kind, revision: meta.revision })
    }
    const events = logs.get(record.slug)!
    for (const event of events) {
      stamp(event.ts)
      const stored = await target.append(slug, {
        actor: event.actor,
        type: event.type,
        payload: rename(event.payload),
      } as Parameters<BuildStore['append']>[1])
      if (stored.seq !== event.seq) throw Error('Build event sequence mismatch')
    }
    if ((await target.getEvents(slug)).length !== events.length) throw Error('Incomplete replay')
    for (const artifact of artifacts) {
      if (!(await target.getArtifact(slug, artifact.kind, artifact.revision)))
        throw Error('Replayed artifact missing')
    }
    builds.push({ source: record.slug, target: slug, events: events.length, artifacts })
  }
  const { verify, finalize, ...root } = harness.config
  await target.appendRepoWithArtifacts(
    project,
    [
      {
        kind: 'dispatcher-effective-config',
        content: JSON.stringify({
          ...root,
          verify: { steps: verify.steps, ...verify.stepConfigs },
          finalize: { steps: finalize.steps, ...finalize.stepConfigs },
        }),
      },
    ],
    ([artifact]) => ({
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.run-started',
      payload: {
        run: `proa-${producer}`,
        pid: process.pid,
        roleWarnings: [],
        effectiveConfig: { kind: artifact!.kind, rev: artifact!.revision },
      },
    }),
  )
  return {
    timestampShiftMs,
    producer,
    sourceHash: hash(),
    sourceProject: harness.origin,
    project,
    builds,
    repositoryEvents: repositoryEvents.length,
    repositoryArtifacts,
  }
}
export function validateProvenance(evidence: SeedEvidence) {
  if (
    !evidence.completedBeforeServerStart ||
    !evidence.loopback ||
    evidence.producers.length !== 2 ||
    !['prepareHappyScenario', 'prepareScenario'].every((name) =>
      evidence.producers.some(
        (p) =>
          p.producer === name &&
          p.sourceHash.length === 64 &&
          p.builds.length > 0 &&
          p.builds.every((b) => b.target && Number.isInteger(b.events) && b.events > 0),
      ),
    )
  )
    throw Error('Incomplete seed provenance')
}
export async function withCaptureSeed<T>(
  work: (
    env: Record<string, string | undefined>,
    evidence: SeedEvidence,
    store: BuildStore,
  ) => Promise<T>,
): Promise<T> {
  return withDataServices(async (adminUrl, environment) => {
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const database = `proa_capture_${suffix}`
    const role = `proa_capture_read_${suffix}`
    const password = crypto.randomUUID()
    const controlRole = `proa_capture_write_${suffix}`
    const controlPassword = crypto.randomUUID()
    const admin = new SQL(adminUrl, { max: 1 })
    const url = new URL(adminUrl)
    url.pathname = `/${database}`
    let store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
    let writer: SQL | undefined
    let created = false
    let roleCreated = false
    let controlRoleCreated = false
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`)
      created = true
      await migratePostgres(url.href)
      writer = new SQL(url.href, { max: 1 })
      const registry = new PostgresProjectRegistry(writer)
      let time = new Date()
      const clock = (() => time) as Clock & { set(date: Date): void }
      clock.set = (date) => {
        time = date
      }
      store = await openPostgresBuildStoreFromEnv(
        { ...environment, AB_POSTGRES_URL: url.href },
        { clock },
      )
      const producers: ReplayEvidence[] = []
      const happy = await prepareHappyScenario()
      try {
        const project = (await registry.add('https://github.com/proa/happy', 'capture')).repo
        producers.push(await replay(happy.harness, store, project, 'prepareHappyScenario', clock))
      } finally {
        await happy.harness.cleanup()
      }
      const mixed = await prepareScenario()
      try {
        const project = (await registry.add('https://github.com/proa/mixed', 'capture')).repo
        producers.push(await replay(mixed, store, project, 'prepareScenario', clock))
      } finally {
        await mixed.cleanup()
      }
      clock.set(new Date())
      const project = producers[1]!.project
      const slug = 'detail-case'
      await registry.add('https://github.com/proa/empty', 'capture')
      for (const [name, kind, parent] of [
        ['root-node', 'node', undefined],
        ['nested-node', 'node', 'root-node'],
        ['root-leaf', 'work', undefined],
        ['unreadable-neighbor', 'work', undefined],
      ] as const) {
        const created = buildCreatedWrite()
        created.payload.repo = project
        created.payload.kind = kind
        if (parent)
          created.payload.target = { build: parent, ticket: { source: 'file', id: parent } }
        await store.createBuild({
          slug: name,
          repo: project,
          ticket: { source: 'file', id: name, title: name },
          created,
        })
      }
      await writer`UPDATE events SET type='future.event' WHERE build='unreadable-neighbor' AND seq=1`

      const createdWrite = buildCreatedWrite()
      createdWrite.payload.repo = project
      createdWrite.payload.target = {
        build: 'nested-node',
        ticket: { source: 'file', id: 'nested-node' },
      }
      await store.createBuild({
        slug,
        repo: project,
        ticket: { source: 'file', id: 'DETAIL-1', title: 'Inspect a stored build trail' },
        created: createdWrite,
      })
      const append = async (type: keyof typeof schemas.build, payload: Record<string, unknown>) => {
        const event = witnessEvent('build', type, schemas.build[type])
        return store!.append(slug, {
          type,
          actor: event.actor,
          payload: { ...(event.payload as object), ...payload },
        } as Parameters<BuildStore['append']>[1])
      }
      await append('runner.attached', { instance: 'capture-detail', host: 'loopback' })
      const spec = await store.putArtifact(slug, {
        kind: 'spec',
        content: '# Stored spec\n\nRead the complete trail. <script>untrusted</script>',
      })
      const plan = await store.putArtifact(slug, {
        kind: 'plan',
        content: '# Stored plan\n\nServe read-only snapshots and suffix updates.',
      })
      await append('spec.imported', { artifact: { kind: 'spec', rev: spec.revision } })
      await append('plan.completed', { round: 1, artifact: { kind: 'plan', rev: plan.revision } })
      const frame = await store.putArtifact(slug, {
        kind: 'verify-frame',
        content: readFileSync(
          resolve(import.meta.dir, '../design/ansi/screens/desktop-builds-light.png'),
        ),
      })
      const report = await store.putArtifact(slug, {
        kind: 'verify-report',
        content: JSON.stringify({
          outcome: 'pass',
          frames: [
            {
              kind: frame.kind,
              rev: frame.revision,
              mediaType: 'image/png',
              caption: 'Stored verification frame',
            },
          ],
        }),
      })
      await append('verify.completed', {
        step: 'lint',
        attempt: 1,
        pass: true,
        report: { kind: report.kind, rev: report.revision },
      })
      await append('code-review.verdict', {
        round: 1,
        verdict: 'revise',
        findings: [
          { id: 'f_detail', severity: 'important', summary: 'Stored review finding', persists: [] },
        ],
      })
      const stream = await store.createStream(
        { kind: 'build', build: slug },
        'session:detail-session',
      )
      await append('session.started', {
        session: 'detail-session',
        role: 'implement',
        phase: 'implement',
        runner: 'capture',
        stream: stream.id,
      })
      await store.appendStreamParts(stream.id, [
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: 'Live transcript from the shared store.' },
      ])
      const closed = await store.createStream(
        { kind: 'build', build: slug },
        'session:closed-session',
      )
      await append('session.started', {
        session: 'closed-session',
        role: 'plan',
        phase: 'plan',
        runner: 'capture',
        stream: closed.id,
      })
      await store.appendStreamParts(closed.id, [
        { type: 'start', messageId: 'closed-message' },
        { type: 'text-start', id: 'closed-text' },
        { type: 'text-delta', id: 'closed-text', delta: 'A completed transcript from the store.' },
        { type: 'text-end', id: 'closed-text' },
        { type: 'finish' },
      ])
      const ended = await store.closeStream(closed.id, 'completed')
      if (!ended.artifact) throw Error('Closed stream transcript artifact missing')
      await append('session.ended', {
        session: 'closed-session',
        transcript: { kind: ended.artifact.kind, rev: ended.artifact.revision },
        usage: { inputTokens: 10, outputTokens: 20, turns: 1 },
      })
      await append('escalation.raised', {
        id: 'detail-question',
        phase: 'implement',
        source: 'agent',
        question: 'Should the stored frame remain attached?',
      })
      const controls: SeedEvidence['controls'] = {}
      for (const width of [1440, 390]) {
        for (const theme of ['light', 'dark']) {
          for (const state of ['answer', 'pausing', 'confirmation', 'refusal']) {
            const controlSlug = `control-${width}-${theme}-${state}`
            const created = buildCreatedWrite()
            created.payload.repo = project
            await store.createBuild({
              slug: controlSlug,
              repo: project,
              ticket: { source: 'file', id: controlSlug, title: 'Operate a stored build' },
              created,
            })
            const put = async (
              type: keyof typeof schemas.build,
              payload: Record<string, unknown>,
            ) => {
              const event = witnessEvent('build', type, schemas.build[type])
              return store!.append(controlSlug, {
                type,
                actor: event.actor,
                payload: { ...(event.payload as object), ...payload },
              } as Parameters<BuildStore['append']>[1])
            }
            await put('runner.attached', { instance: `capture-${controlSlug}`, host: 'loopback' })
            if (state === 'pausing') await put('build.pause-requested', {})
            if (state === 'answer' || state === 'refusal')
              await put('escalation.raised', {
                id: `${controlSlug}-question`,
                source: 'agent',
                phase: 'implement',
                question: 'Should the operator continue with the approved plan?',
              })
            controls[`builds-${width}-${theme}-control-${state}`] = { project, slug: controlSlug }
          }
        }
      }
      for (const mode of ['js', 'nojs'])
        for (const state of [
          'pause',
          'cancel-pause',
          'resume',
          'abort',
          'discard',
          'guidance',
          'retry',
          'dismiss',
        ]) {
          const controlSlug = `proof-${mode}-${state}`
          const created = buildCreatedWrite()
          created.payload.repo = project
          await store.createBuild({
            slug: controlSlug,
            repo: project,
            ticket: { source: 'file', id: controlSlug, title: 'Browser control proof' },
            created,
          })
          const put = async (
            type: keyof typeof schemas.build,
            payload: Record<string, unknown>,
          ) => {
            const event = witnessEvent('build', type, schemas.build[type])
            return store!.append(controlSlug, {
              type,
              actor: event.actor,
              payload: { ...(event.payload as object), ...payload },
            } as Parameters<BuildStore['append']>[1])
          }
          if (state !== 'discard')
            await put('runner.attached', { instance: controlSlug, host: 'loopback' })
          if (state === 'cancel-pause') await put('build.pause-requested', {})
          if (state === 'resume') await put('build.paused', {})
          if (['guidance', 'retry', 'dismiss'].includes(state)) {
            if (state === 'dismiss')
              await put('code-review.verdict', {
                round: 1,
                verdict: 'revise',
                findings: [
                  {
                    id: 'f_browser',
                    severity: 'important',
                    summary: 'Dismiss this finding',
                    persists: [],
                  },
                ],
              })
            await put('escalation.raised', {
              id: `${controlSlug}-question`,
              source: 'agent',
              phase: 'implement',
              refs: state === 'dismiss' ? ['f_browser'] : [],
              question: 'Continue the approved plan?',
            })
          }
          controls[`proof-${mode}-${state}`] = { project, slug: controlSlug }
        }
      const extendedControls = await seedExtendedBrowserControls(writer, store)
      let connectionNow = new Date()
      const connections = new PostgresConnectionStore(writer, () => connectionNow)
      const connect: Record<string, string> = { entry: '', unknown: '0000000000', error: 'INVALID' }
      for (const status of ['pending', 'approved', 'denied', 'expired']) {
        connectionNow = new Date(Date.now() - (status === 'expired' ? 11 * 60_000 : 0))
        const request = await connections.start({
          repo: `https://github.com/capture/connect-${status}`,
          credentialId: randomBytes(16).toString('hex'),
          digest: randomBytes(32).toString('hex'),
        })
        connect[status] = request.code
        if (status === 'approved' || status === 'denied')
          await connections.decide(request.code, 'seed@example.com', status === 'approved')
        if (status === 'expired') {
          connectionNow = new Date()
          await connections.lookup(request.code, 'seed@example.com')
          connectionNow = new Date()
        }
      }
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
      roleCreated = true
      await writer.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
      await writer.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await writer.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
      await admin.unsafe(`CREATE ROLE ${controlRole} LOGIN PASSWORD '${controlPassword}'`)
      controlRoleCreated = true
      await writer.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${controlRole}`)
      await writer.unsafe(`GRANT USAGE ON SCHEMA public TO ${controlRole}`)
      await writer.unsafe(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${controlRole}`,
      )
      await writer.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${controlRole}`)
      const controlUrl = new URL(url)
      controlUrl.username = controlRole
      controlUrl.password = controlPassword
      const readerUrl = new URL(url)
      readerUrl.username = role
      readerUrl.password = password
      const evidence: SeedEvidence = {
        adapterHash: createHash('sha256')
          .update(readFileSync(import.meta.filename))
          .digest('hex'),
        completedBeforeServerStart: true,
        database,
        loopback: true,
        producers,
        supplemental: [
          'detail-artifacts',
          'review-and-verify-frame',
          'live-transcript',
          'closed-transcript',
          'escaped-store-text',
          'nested-nodes',
          'root-leaf',
          'unreadable-neighbor',
          'empty-project',
        ],
        detail: { project, slug },
        controls,
        extendedControls,
        connect,
      }
      validateProvenance(evidence)
      return await work(
        {
          ...environment,
          AB_POSTGRES_URL: readerUrl.href,
          PROA_POSTGRES_WRITE_URL: controlUrl.href,
        },
        evidence,
        store,
      )
    } finally {
      await store?.close()
      await writer?.close()
      if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
      if (roleCreated) await admin.unsafe(`DROP ROLE ${role}`)
      if (controlRoleCreated) await admin.unsafe(`DROP ROLE ${controlRole}`)
      await admin.close()
    }
  })
}

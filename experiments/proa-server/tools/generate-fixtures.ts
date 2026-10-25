import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  root,
  experiment,
  schemas,
  eventSchemas,
  reducers,
  expected,
  oracleOutcome,
  unknownEvent,
  catalog,
  sources,
  boundaries,
  witnessEvent,
  type Scope,
  type Fixture,
  type FixtureEvent,
  deduplicateFixtures,
  gzipCorpus,
} from './fixture-core'
export function childEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !/^(AB_|DATABASE_URL$|VERCEL_|AWS_|BLOB_)/.test(key),
    ),
  ) as Record<string, string>
}
export function scenarioFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => resolve(directory, name))
}
export function normalizeEvents<T>(events: T): T {
  const roots = new Map<string, string>()
  return JSON.parse(
    JSON.stringify(events).replace(/\/tmp\/[A-Za-z0-9_.-]+/g, (path) => {
      if (!roots.has(path)) roots.set(path, `/tmp/proa-fixture-${roots.size + 1}`)
      return roots.get(path)!
    }),
  )
}
export function publishFixtures(
  candidate: string,
  destination: string,
  moveCandidate = renameSync,
) {
  const backup = resolve(dirname(candidate), 'previous-fixtures')
  const existed = existsSync(destination)
  if (existed) renameSync(destination, backup)
  try {
    moveCandidate(candidate, destination)
  } catch (error) {
    if (existed) renameSync(backup, destination)
    throw error
  }
  if (existed) rmSync(backup, { recursive: true })
}
export async function generate() {
  mkdirSync(resolve(root, '.ab'), { recursive: true })
  const scratch = mkdtempSync(resolve(root, '.ab/proa-corpus-'))
  let completed = false
  const fixtures: Fixture[] = []
  const producers: { file: string; passed: number; skipped: number; streams: number }[] = []
  const add = (id: string, scope: Scope, events: FixtureEvent[]) => {
    fixtures.push({
      id,
      scope,
      events,
      ...oracleOutcome(scope, events),
      ...(unknownEvent(scope, events) ? { rustUnreadable: unknownEvent(scope, events) } : {}),
      boundaries: boundaries(events.length),
    })
  }
  try {
    for (const scope of Object.keys(schemas) as Scope[]) add(`empty/${scope}`, scope, [])
    const scenarioDir = resolve(root, 'packages/core/src/scenarios')
    const producerFiles = scenarioFiles(scenarioDir)
    producerFiles.push(
      ...[
        'client-compatibility.contract.test.ts',
        'remote-store.seam.test.ts',
        'mixed-version.test.ts',
      ].map((name) => resolve(root, 'packages/hosted-store-service/src', name)),
    )
    producerFiles.push(
      ...[
        'store/session-reducer.incremental.test.ts',
        'store/repo-state-events.test.ts',
        'kernel/read-facts.test.ts',
        'kernel/reducer.test.ts',
        'kernel/reducer.incremental.test.ts',
        'kernel/repository-reducers.incremental.test.ts',
        'kernel/harvest.test.ts',
        'kernel/dispatch-upgrade.test.ts',
        'kernel/repository-attention.test.ts',
        'kernel/node-restack-state.test.ts',
      ].map((name) => resolve(root, 'packages/core/src', name)),
    )
    for (const [index, file] of producerFiles.entries()) {
      const output = resolve(scratch, `${index}.json`)
      const child = Bun.spawn(
        ['bun', 'test', '--preload', resolve(import.meta.dir, 'capture-scenario-logs.ts'), file],
        {
          cwd: root,
          env: { ...childEnvironment(), PROA_CAPTURE_FILE: output },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(`fixture producer failed: ${file}\n${stdout}\n${stderr}`)
      const streams = JSON.parse(readFileSync(output, 'utf8'))
      producers.push({
        file: file.slice(root.length + 1),
        passed: Number(stderr.match(/(\d+) pass/)?.[1] ?? 0),
        skipped: Number(stderr.match(/(\d+) skip/)?.[1] ?? 0),
        streams: streams.length,
      })
      for (const stream of streams) {
        // Normalize temporary roots only. Identity, timestamps, payloads and array order remain actual producer facts.
        const events = normalizeEvents(stream.events)
        for (const length of boundaries(events.length))
          add(`${index}/${stream.id}/${length}`, stream.scope, events.slice(0, length))
      }
      console.log(`captured ${producers.at(-1)!.file}: ${streams.length} streams`)
    }
    const decodingWitnesses = (Object.keys(schemas) as Scope[]).flatMap((scope) =>
      Object.entries(schemas[scope]).map(([type, schema]) => ({
        scope,
        event: witnessEvent(scope, type, schema),
      })),
    )
    const decodeOnly: string[] = []
    for (const { scope, event } of decodingWitnesses) {
      try {
        expected(scope, [event])
        add(`witness/${scope}/${event.type}`, scope, [event])
      } catch {
        decodeOnly.push(`${scope}/${event.type}`)
      }
    }
    const corpus = {
      manifest: {
        format: 1,
        catalog: catalog(),
        sources: sources(),
        versions: Object.fromEntries(
          Object.entries(reducers).map(([scope, entries]) => [
            scope,
            Object.fromEntries(
              Object.entries(entries).map(([name, reducer]) => [name, reducer.version]),
            ),
          ]),
        ),
        producers,
      },
      fixtures: deduplicateFixtures(fixtures),
      decodingWitnesses,
      decodeOnly,
    }
    const candidate = resolve(scratch, 'fixtures')
    mkdirSync(candidate)
    writeFileSync(resolve(candidate, 'corpus.json.gz'), gzipCorpus(corpus))
    writeFileSync(
      resolve(candidate, 'manifest.json'),
      `${JSON.stringify(corpus.manifest, null, 2)}\n`,
    )

    writeFileSync(
      resolve(candidate, 'event-schemas.json'),
      `${JSON.stringify(eventSchemas(), null, 2)}\n`,
    )
    for (const name of ['manifest.json', 'event-schemas.json']) {
      const file = resolve(candidate, name)
      const formatter = Bun.spawn(
        [
          'bunx',
          'biome',
          'format',
          '--config-path',
          resolve(root, 'biome.jsonc'),
          '--stdin-file-path',
          resolve(experiment, 'fixtures', name),
        ],
        { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      )
      formatter.stdin.write(readFileSync(file))
      formatter.stdin.end()
      const [formatted, error, code] = await Promise.all([
        new Response(formatter.stdout).text(),
        new Response(formatter.stderr).text(),
        formatter.exited,
      ])
      if (code !== 0) throw new Error(`fixture formatting failed: ${error}`)
      writeFileSync(file, formatted)
    }
    publishFixtures(candidate, resolve(experiment, 'fixtures'))
    completed = true
    console.log(
      `generated ${fixtures.length} fixtures; ${producers.reduce((n, p) => n + p.passed, 0)} tests passed, ${producers.reduce((n, p) => n + p.skipped, 0)} explicitly gated tests skipped`,
    )
  } finally {
    if (completed) rmSync(scratch, { recursive: true, force: true })
    else
      console.error(`fixture generation failed; diagnostic inputs/candidate retained at ${scratch}`)
  }
}
if (import.meta.main) await generate()

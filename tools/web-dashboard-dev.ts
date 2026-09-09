#!/usr/bin/env bun
/**
 * Local operator web app for interactive design work.
 *
 * Repository-local tooling. It never touches the hosted deployment: it runs
 * the Next.js app against a local PostgreSQL database plus a local
 * S3-compatible blob store, seeds that database with the same scripted
 * dispatch scenarios `capture:web-dashboard` renders, and mints a signed
 * Better Auth session so the browser skips GitHub OAuth.
 *
 *   bun tools/web-dashboard-dev.ts seed    # reset + migrate + replay scenarios
 *   bun tools/web-dashboard-dev.ts serve   # next dev on :3100 + sign-in helper on :3199
 *   bun tools/web-dashboard-dev.ts env     # print the environment `serve` uses
 *
 * Prerequisites: a local PostgreSQL reachable as AB_WEB_DEV_POSTGRES_URL
 * (default postgres://$USER@localhost:5432/autobuild_dev) and a MinIO
 * container on 127.0.0.1:9100 with bucket `autobuild-dev`:
 *
 *   docker run -d --name ab-dev-minio -p 127.0.0.1:9100:9000 \
 *     -e MINIO_ROOT_USER=abdev -e MINIO_ROOT_PASSWORD=abdevsecret123 \
 *     minio/minio server /data
 *   docker exec ab-dev-minio sh -c 'mc alias set local http://localhost:9000 abdev abdevsecret123 && mc mb --ignore-existing local/autobuild-dev'
 */
import { randomBytes, createHmac } from 'node:crypto'
import { resolve } from 'node:path'
import { SQL } from 'bun'
import type { Config } from '../packages/core/src/config/schema'
import { roleKeyWarnings } from '../packages/core/src/config/roles'
import { DISPATCHER } from '../packages/core/src/events/envelope'
import type { E2eHarness } from '../packages/core/src/integration/harness'
import type { BuildStore, Clock } from '../packages/core/src/store/types'
import { migratePostgres } from '../packages/postgres-store/src/schema'
import { openPostgresBuildStoreFromEnv } from '../packages/postgres-store/src/config'
import { prepareHappyScenario, prepareScenario } from './dashboard-capture'

const REPO_ROOT = resolve(import.meta.dir, '..')
const WEB_PORT = 3100
const SIGN_IN_PORT = 3199
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
const IDENTITY = process.env.AB_WEB_DEV_EMAIL ?? 'operator@example.com'
const REPOSITORIES = { happy: 'example/happy', mixed: 'example/mixed' } as const
const COOKIE_NAME = 'better-auth.session_token'
const SESSION_TOKEN_FILE = resolve(REPO_ROOT, '.autobuild', 'web-dev-session-token')

/** Everything the app needs, with dev-only secrets. Nothing here is real. */
export function devEnv(): Record<string, string> {
  const postgres =
    process.env.AB_WEB_DEV_POSTGRES_URL ??
    `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/autobuild_dev`
  return {
    NODE_ENV: 'development',
    AB_POSTGRES_URL: postgres,
    DATABASE_URL: postgres,
    AB_BLOB_BACKEND: 's3',
    AB_S3_ENDPOINT: 'http://127.0.0.1:9100',
    AB_S3_BUCKET: 'autobuild-dev',
    AB_S3_REGION: 'us-east-1',
    AB_S3_ACCESS_KEY_ID: 'abdev',
    AB_S3_SECRET_ACCESS_KEY: 'abdevsecret123',
    AB_S3_FORCE_PATH_STYLE: 'true',
    AB_STORE_SECRET: 'web-dev-store-secret-not-for-production-use',
    AB_TICKET_BACKEND: 'database',
    BETTER_AUTH_SECRET: 'web-dev-better-auth-secret-0123456789abcdefghij',
    BETTER_AUTH_URL: WEB_ORIGIN,
    AB_WEB_AUTH_PROVIDERS: 'github',
    AB_WEB_ALLOWED_EMAILS: IDENTITY,
    AB_WEB_REPOSITORIES: Object.values(REPOSITORIES).join(','),
    GITHUB_CLIENT_ID: 'web-dev-placeholder',
    GITHUB_CLIENT_SECRET: 'web-dev-placeholder',
  }
}

function settableClock(): Clock & { set(date: Date): void } {
  let current = new Date()
  const clock = (() => current) as Clock & { set(date: Date): void }
  clock.set = (date) => {
    current = date
  }
  return clock
}

/** Mirror of the dispatcher's effective-config deposit (cli/dispatch.ts). */
function effectiveConfigContent(config: Config): string {
  const { verify, finalize, ...root } = config
  return JSON.stringify({
    ...root,
    verify: { steps: verify.steps, ...verify.stepConfigs },
    finalize: { steps: finalize.steps, ...finalize.stepConfigs },
  })
}

interface ReplayOptions {
  harness: E2eHarness
  target: BuildStore
  clock: ReturnType<typeof settableClock>
  repo: string
}

/**
 * Copy one scenario's memory store into the target store under a stable
 * repository identity, shifting every timestamp so the newest event landed a
 * moment ago instead of on the capture's fixed July clock.
 */
async function replayScenario({ harness, target, clock, repo }: ReplayOptions): Promise<void> {
  const source = harness.store
  const origin = harness.origin
  const rename = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(origin, repo)) as T

  const builds = (await source.listBuilds()).filter((record) => record.repo === origin)
  const repoEvents = (await source.getRepo(origin)) ? await source.getRepoEvents(origin) : []
  const stamps = [
    ...repoEvents.map((event) => Date.parse(event.ts)),
    ...(await Promise.all(builds.map((b) => source.getEvents(b.slug))))
      .flat()
      .map((event) => Date.parse(event.ts)),
  ]
  const newest = Math.max(...stamps)
  const shift = Date.now() - 30_000 - newest
  const shifted = (iso: string) => new Date(Date.parse(iso) + shift)

  const repoRecord = await source.getRepo(origin)
  clock.set(shifted(repoRecord?.createdAt ?? new Date(newest).toISOString()))
  await target.ensureRepo(repo)
  for (const meta of await source.listRepoArtifacts(origin)) {
    const artifact = await source.getRepoArtifact(origin, meta.kind, meta.revision)
    if (!artifact) throw new Error(`repo artifact ${meta.kind}@${meta.revision} vanished`)
    clock.set(shifted(meta.createdAt))
    const deposited = await target.putRepoArtifact(repo, {
      kind: meta.kind,
      content: artifact.content,
      metadata: rename(meta.metadata),
    })
    if (deposited.revision !== meta.revision) {
      throw new Error(`repo artifact ${meta.kind} replayed as rev ${deposited.revision}`)
    }
  }
  for (const event of repoEvents) {
    clock.set(shifted(event.ts))
    await target.appendRepo(repo, {
      actor: event.actor,
      type: event.type,
      payload: rename(event.payload),
    } as Parameters<BuildStore['appendRepo']>[1])
  }

  for (const record of builds) {
    clock.set(shifted(record.createdAt))
    await target.createBuild({
      slug: record.slug,
      repo,
      ...(record.ticket ? { ticket: record.ticket } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
    })
    for (const meta of await source.listArtifacts(record.slug)) {
      const artifact = await source.getArtifact(record.slug, meta.kind, meta.revision)
      if (!artifact)
        throw new Error(`artifact ${record.slug}/${meta.kind}@${meta.revision} vanished`)
      clock.set(shifted(meta.createdAt))
      const deposited = await target.putArtifact(record.slug, {
        kind: meta.kind,
        content: artifact.content,
        metadata: rename(meta.metadata),
      })
      if (deposited.revision !== meta.revision) {
        throw new Error(
          `artifact ${record.slug}/${meta.kind} replayed as rev ${deposited.revision}`,
        )
      }
    }
    for (const event of await source.getEvents(record.slug)) {
      clock.set(shifted(event.ts))
      await target.append(record.slug, {
        actor: event.actor,
        type: event.type,
        payload: rename(event.payload),
      } as Parameters<BuildStore['append']>[1])
    }
  }

  // Leases are liveness, not history: re-claim them against the real clock.
  clock.set(new Date())
  for (const record of builds) {
    if (!record.lease) continue
    const ttl = shifted(record.lease.expiresAt).getTime() - Date.now()
    if (ttl <= 0) continue
    await target.claimLease(record.slug, record.lease.holder, ttl)
  }
  if (repoRecord?.lease) {
    const ttl = shifted(repoRecord.lease.expiresAt).getTime() - Date.now()
    if (ttl > 0) await target.claimRepoLease(repo, repoRecord.lease.holder, ttl)
  }

  // The operator API reads the effective config from the latest dispatcher
  // run; the scripted scenarios never start one, so record it here.
  const run = `web-dev-${repo.replace(/\W+/g, '-')}`
  await target.appendRepoWithArtifacts(
    repo,
    [
      {
        kind: 'dispatcher-effective-config',
        content: effectiveConfigContent(harness.config),
        metadata: { run, revision: 0 },
      },
    ],
    ([artifact]) => ({
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid: process.pid,
        effectiveConfig: { kind: artifact!.kind, rev: artifact!.revision },
        roleWarnings: roleKeyWarnings(harness.config),
      },
    }),
  )
  await target.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.tick-completed',
    payload: {
      run,
      queued: builds.filter((b) => !b.lease).length,
      counters: Object.fromEntries(
        [
          'merged',
          'closed',
          'conflicted',
          'abandoned',
          'discarded',
          'janitorFailed',
          'recovered',
          'dispatchFailed',
          'resumed',
          'swept',
          'dispatched',
          'authored',
          'bounced',
          'claimRaces',
          'invalidTickets',
          'creationWithheld',
          'dependencyBlocked',
          'harvestStarted',
          'harvestResumed',
          'harvestCompleted',
          'harvestEscalated',
          'harvestFailed',
        ].map((name) => [name, 0]),
      ),
      janitorDiagnostics: [],
      ticketDiagnostics: [],
      dependencyDiagnostics: [],
    },
  } as Parameters<BuildStore['appendRepo']>[1])
}

async function resetDatabase(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  } finally {
    await sql.close()
  }
  await migratePostgres(url)
}

/** Insert a Better Auth user + session and return the signed cookie value. */
async function mintSession(env: Record<string, string>): Promise<string> {
  const sql = new SQL(env.AB_POSTGRES_URL!)
  try {
    const now = new Date()
    const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000)
    const userId = `web-dev-${randomBytes(6).toString('hex')}`
    const token = randomBytes(32).toString('base64url')
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, ${'Local operator'}, ${IDENTITY}, true, ${now}, ${now})
      ON CONFLICT (email) DO NOTHING`
    const [user] = await sql`SELECT id FROM "user" WHERE email = ${IDENTITY}`
    await sql`INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      VALUES (${`session-${randomBytes(6).toString('hex')}`}, ${expires}, ${token}, ${now}, ${now}, ${user.id})`
    // better-call signs cookies as `${value}.${base64(hmac-sha256(secret, value))}`
    // and URL-encodes the result before setting it.
    const signature = createHmac('sha256', env.BETTER_AUTH_SECRET!).update(token).digest('base64')
    return encodeURIComponent(`${token}.${signature}`)
  } finally {
    await sql.close()
  }
}

async function seed(): Promise<void> {
  const env = devEnv()
  console.log(`resetting ${env.AB_POSTGRES_URL}`)
  await resetDatabase(env.AB_POSTGRES_URL!)
  const clock = settableClock()
  const target = await openPostgresBuildStoreFromEnv(env, { clock })
  try {
    console.log('preparing scripted scenarios')
    const happy = await prepareHappyScenario()
    try {
      await replayScenario({ harness: happy.harness, target, clock, repo: REPOSITORIES.happy })
    } finally {
      await happy.harness.cleanup()
    }
    const mixed = await prepareScenario()
    try {
      await replayScenario({ harness: mixed, target, clock, repo: REPOSITORIES.mixed })
    } finally {
      await mixed.cleanup()
    }
  } finally {
    await target.close()
  }
  const cookie = await mintSession(env)
  await Bun.write(SESSION_TOKEN_FILE, cookie)
  console.log(`seeded ${Object.values(REPOSITORIES).join(' and ')} for ${IDENTITY}`)
}

async function serve(): Promise<void> {
  const env = devEnv()
  const cookie = await Bun.file(SESSION_TOKEN_FILE)
    .text()
    .catch(() => null)
  if (!cookie) throw new Error('no session token; run `seed` first')

  Bun.serve({
    hostname: '127.0.0.1',
    port: SIGN_IN_PORT,
    fetch() {
      // Cookies ignore ports, so a host-only cookie set here reaches :3100.
      return new Response(null, {
        status: 303,
        headers: {
          location: `${WEB_ORIGIN}/`,
          'set-cookie': `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
        },
      })
    },
  })
  console.log(`sign in:  http://localhost:${SIGN_IN_PORT}/`)
  console.log(`web app:  ${WEB_ORIGIN}/`)

  const child = Bun.spawn(['bun', 'run', '--bun', 'next', 'dev', '-p', String(WEB_PORT)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const stop = () => {
    child.kill()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await child.exited
  process.exit(child.exitCode ?? 0)
}

if (import.meta.main) {
  const command = process.argv[2]
  const run =
    command === 'seed'
      ? seed()
      : command === 'serve'
        ? serve()
        : command === 'env'
          ? Promise.resolve(
              console.log(
                Object.entries(devEnv())
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n'),
              ),
            )
          : Promise.reject(new Error('usage: web-dashboard-dev.ts seed | serve | env'))
  run.catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  })
}

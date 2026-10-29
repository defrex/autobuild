import { chatgptStateSchema } from '@defrex/autobuild/project-secrets'
import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { migratePostgres } from './schema'
import {
  PostgresProjectSecrets,
  StaticSecretConflictError,
  type RefreshKind,
} from './project-secrets'
import { PostgresProjectRegistry } from './projects'
const testURL = process.env.AB_POSTGRES_TEST_URL
const live = testURL ? test : test.skip
const repo = 'https://github.com/example/project'
const key = Buffer.alloc(32, 1).toString('base64')
async function fixture(
  work: (sql: SQL, url: string, projects: PostgresProjectRegistry) => Promise<void>,
) {
  const admin = new SQL(testURL!),
    schema = `secrets_${crypto.randomUUID().replaceAll('-', '')}`
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  const url = new URL(testURL!)
  url.searchParams.set('options', `-csearch_path=${schema}`)
  let sql: SQL | undefined
  try {
    await migratePostgres(url.href)
    sql = new SQL(url.href)
    const projects = new PostgresProjectRegistry(sql)
    await projects.add(repo, 'owner')
    await work(sql, url.href, projects)
  } finally {
    await sql?.close()
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
    await admin.close()
  }
}
live(
  'encrypted mutations, audit, key verification, coherent delivery and replacement fencing',
  () =>
    fixture(async (sql, _url, projects) => {
      const store = new PostgresProjectSecrets(sql, projects, () => key)
      await store.set(repo, 'KIMI_API_KEY', 'marker-secret', 'member-a')
      const first = await store.resolveForTick(repo, Date.now() + 600000, Date.now() + 5000)
      expect(first.env).toEqual({ KIMI_API_KEY: 'marker-secret' })
      await store.markSupplied(first)
      expect((await store.list(repo))[0]?.lastSuppliedAt).not.toBeNull()
      await store.set(repo, 'KIMI_API_KEY', 'replacement-secret', 'member-b')
      await expect(store.markSupplied(first)).rejects.toThrow('stale-secrets')
      const row = (await store.list(repo))[0]!
      expect(row.owner).toBe('member-b')
      expect(row.lastSuppliedAt).toBeNull()
      const persisted =
        JSON.stringify(await sql`SELECT * FROM project_secrets`) +
        JSON.stringify(await sql`SELECT * FROM project_secret_audit`)
      expect(persisted).not.toContain('marker-secret')
      expect(persisted).not.toContain('replacement-secret')
      await expect(
        new PostgresProjectSecrets(sql, projects, () =>
          Buffer.alloc(32, 2).toString('base64'),
        ).remove(repo, 'KIMI_API_KEY', 'member'),
      ).rejects.toThrow('key-unavailable')
      await store.remove(repo, 'KIMI_API_KEY', 'member-c')
      expect(await store.list(repo)).toEqual([])
      // Even after a verifier exists, empty resolution needs no decryption.
      const empty = await new PostgresProjectSecrets(sql, projects, () => undefined).resolveForTick(
        repo,
        Date.now(),
        Date.now() + 1000,
      )
      expect(empty.env).toEqual({})
      expect(empty.versions).toEqual([])
      expect(
        (await sql`SELECT actor,action FROM project_secret_audit ORDER BY ts`).map(
          (r: Record<string, string>) => [r.actor, r.action],
        ),
      ).toEqual([
        ['member-a', 'set'],
        ['member-b', 'set'],
        ['member-c', 'remove'],
      ])
    }),
)

/** A pooler seam: each transaction opens and closes a new physical connection. */
function rebinding(url: string, inside: { count: number }, onRefreshingRead?: () => void): SQL {
  const run = async (query: unknown, params: unknown[] = []) => {
    const sql = new SQL(url)
    try {
      return await sql(query as TemplateStringsArray, ...params)
    } finally {
      await sql.close()
    }
  }
  const seam = ((query: unknown, ...params: unknown[]) => run(query, params)) as unknown as SQL
  seam.begin = (async (work: (tx: SQL) => Promise<unknown>) => {
    const sql = new SQL(url, { max: 1 })
    try {
      return await sql.begin(async (tx) => {
        inside.count++
        const guarded = ((q: TemplateStringsArray, ...p: unknown[]) => {
          if (/pg_advisory_lock\s*\(/.test(q.join(''))) throw new Error('session lock forbidden')
          const query = tx(q, ...p)
          // Preserve Bun SQL query objects used as SQL fragments by other tests.
          if (!onRefreshingRead || !/SELECT \* FROM project_secrets/.test(q.join(''))) return query
          return query.then((rows) => {
            if (rows.some((row: { status: string }) => row.status === 'refreshing'))
              onRefreshingRead()
            return rows
          })
        }) as unknown as SQL
        try {
          return await work(guarded)
        } finally {
          inside.count--
        }
      })
    } finally {
      await sql.close()
    }
  }) as SQL['begin']
  seam.reserve = (() => {
    throw new Error('backend affinity forbidden')
  }) as SQL['reserve']
  return seam
}
live(
  'refresh uses one committed claim across rebinding connections and persists rotated state before delivery',
  () =>
    fixture(async (sql, url, projects) => {
      let now = Date.now(),
        calls = 0
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>((r) => (release = r)),
        start = new Promise<void>((r) => (entered = r))
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          calls++
          expect(await request.text()).toBe('refresh-original')
          entered()
          await gate
          return Response.json({
            accessToken: 'access-rotated',
            state: 'refresh-rotated',
            expiresAt: now + 3600000,
          })
        },
      })
      const inside = { count: 0 }
      const kind: RefreshKind = {
        validateState: (s) => typeof s === 'string',
        async refresh(state, signal) {
          expect(inside.count).toBe(0)
          return await (
            await fetch(`http://localhost:${server.port}`, {
              method: 'POST',
              body: String(state),
              signal,
            })
          ).json()
        },
      }
      const pool = rebinding(url, inside),
        kinds = new Map([['fake', kind]])
      const a = new PostgresProjectSecrets(
          pool,
          projects,
          () => key,
          kinds,
          () => now,
        ),
        b = new PostgresProjectSecrets(
          pool,
          projects,
          () => key,
          kinds,
          () => now,
        )
      try {
        await a.setPayload(
          repo,
          'CLAUDE_CODE_OAUTH_TOKEN',
          'fake',
          { accessToken: 'access-old', state: 'refresh-original', expiresAt: now + 1000 },
          'member',
        )
        const left = a.resolveForTick(repo, now + 600000, now + 10000)
        await start
        const right = b.resolveForTick(repo, now + 600000, now + 10000)
        release()
        const results = await Promise.all([left, right])
        expect(calls).toBe(1)
        for (const result of results)
          expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('access-rotated')
        expect((await sql`SELECT status FROM project_secrets`)[0].status).toBe('ready')
        await b.markSupplied(results[0]!)
        await b.resolveForTick(repo, now + 600000, now + 10000)
        expect(calls).toBe(1)
        now += 3300001
        // A different endpoint contract sees the durably rotated refresh token.
        kinds.set('fake', {
          validateState: kind.validateState,
          async refresh(state) {
            expect(state).toBe('refresh-rotated')
            return { accessToken: 'access-next', state: 'refresh-next', expiresAt: now + 3600000 }
          },
        })
        expect(
          (await a.resolveForTick(repo, now + 600000, now + 10000)).env.CLAUDE_CODE_OAUTH_TOKEN,
        ).toBe('access-next')
      } finally {
        server.stop(true)
      }
    }),
  20000,
)

live(
  'failed refresh is durable and pending attempts expire without takeover; late completion cannot resurrect',
  () =>
    fixture(async (_sql, url, projects) => {
      let now = Date.now(),
        calls = 0
      let entered!: () => void, release!: () => void
      const start = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (release = r))
      const kinds = new Map<string, RefreshKind>([
        [
          'fake',
          {
            validateState: (s) => typeof s === 'string',
            async refresh() {
              calls++
              entered()
              await gate
              return { accessToken: 'late-token', state: 'rotated', expiresAt: now + 3600000 }
            },
          },
        ],
      ])
      const a = new PostgresProjectSecrets(
        rebinding(url, { count: 0 }),
        projects,
        () => key,
        kinds,
        () => now,
      )
      await a.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        { accessToken: 'old', expiresAt: now + 1000, state: 'original' },
        'member',
      )
      const pending = a.resolveForTick(repo, now + 600000, now + 120000)
      await start
      now += 61000
      await expect(a.resolveForTick(repo, now + 600000, now + 1000)).rejects.toThrow(
        'secret-unavailable',
      )
      release()
      await expect(pending).rejects.toThrow('secret-unavailable')
      expect(calls).toBe(1)
      expect((await a.list(repo))[0]!.status).toBe('failed')
      await expect(a.resolveForTick(repo, now + 600000, now + 1000)).rejects.toThrow(
        'secret-unavailable',
      )
      expect(calls).toBe(1)
      // Explicit replacement is the recovery boundary.
      kinds.set('fake', {
        validateState: (s) => typeof s === 'string',
        async refresh() {
          throw new Error('provider-secret-marker')
        },
      })
      await a.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        { accessToken: 'old', expiresAt: now + 1000, state: 'new-refresh' },
        'other',
      )
      await expect(a.resolveForTick(repo, now + 600000, now + 1000)).rejects.toThrow(
        'secret-unavailable',
      )
      const status = await a.list(repo)
      expect(status[0]!.failureCode).toBe('refresh-failed')
      expect(JSON.stringify(status)).not.toContain('provider-secret-marker')
    }),
)

live(
  'replacement, removal and recreate during HTTP fence the old generation and new names invalidate delivery',
  () =>
    fixture(async (sql, url, projects) => {
      const store = new PostgresProjectSecrets(sql, projects, () => key)
      for (const action of ['replace', 'remove', 'recreate']) {
        let release!: () => void, entered!: () => void
        const start = new Promise<void>((r) => (entered = r)),
          gate = new Promise<void>((r) => (release = r))
        const kinds = new Map<string, RefreshKind>([
          [
            'fake',
            {
              validateState: (s) => typeof s === 'string',
              async refresh() {
                entered()
                await gate
                return {
                  accessToken: 'stale-token',
                  state: 'stale-state',
                  expiresAt: Date.now() + 3600000,
                }
              },
            },
          ],
        ])
        const refreshing = new PostgresProjectSecrets(
          rebinding(url, { count: 0 }),
          projects,
          () => key,
          kinds,
        )
        await refreshing.setPayload(
          repo,
          'KIMI_API_KEY',
          'fake',
          { accessToken: 'old', expiresAt: Date.now() + 1000, state: 'original' },
          'member',
        )
        const pending = refreshing.resolveForTick(repo, Date.now() + 600000, Date.now() + 5000)
        await start
        if (action !== 'replace') await store.remove(repo, 'KIMI_API_KEY', 'member')
        if (action !== 'remove') await store.set(repo, 'KIMI_API_KEY', 'current-token', 'other')
        release()
        const result = await pending
        expect(result.env.KIMI_API_KEY).toBe(action === 'remove' ? undefined : 'current-token')
        expect(JSON.stringify(await sql`SELECT * FROM project_secrets`)).not.toContain(
          'stale-token',
        )
      }
      const snapshot = await store.resolveForTick(repo, Date.now() + 600000, Date.now() + 5000)
      await store.set(repo, 'ANTHROPIC_API_KEY', 'new-name', 'member')
      await expect(store.markSupplied(snapshot)).rejects.toThrow('stale-secrets')
      expect((await store.list(repo)).every((s) => s.lastSuppliedAt === null)).toBe(true)
    }),
)

/** Lose an acknowledgement after a real commit, or roll back a real completion. */
function uncertain(pool: SQL, match: RegExp, before = false): SQL {
  const begin = pool.begin.bind(pool)
  let armed = true
  pool.begin = (async (work: (tx: SQL) => Promise<unknown>) => {
    let matched = false
    const result = await begin(async (tx) => {
      const guarded = ((q: TemplateStringsArray, ...p: unknown[]) => {
        if (armed && match.test(q.join(''))) {
          matched = true
          if (before) {
            armed = false
            throw new Error('commit unavailable')
          }
        }
        return tx(q, ...p)
      }) as unknown as SQL
      return work(guarded)
    })
    if (armed && matched) {
      armed = false
      throw new Error('commit acknowledgement lost')
    }
    return result
  }) as SQL['begin']
  return pool
}
live('unknown claim/completion commit outcomes never repeat external rotation', () =>
  fixture(async (sql, url, projects) => {
    let now = Date.now(),
      calls = 0
    const kinds = new Map<string, RefreshKind>([
      [
        'fake',
        {
          validateState: (s) => typeof s === 'string',
          async refresh() {
            calls++
            return { accessToken: 'fresh', state: 'rotated', expiresAt: now + 3600000 }
          },
        },
      ],
    ])
    const setup = new PostgresProjectSecrets(
      sql,
      projects,
      () => key,
      kinds,
      () => now,
    )
    const payload = { accessToken: 'old', expiresAt: now + 1000, state: 'original' }
    await setup.setPayload(repo, 'KIMI_API_KEY', 'fake', payload, 'member')
    const claim = new PostgresProjectSecrets(
      uncertain(rebinding(url, { count: 0 }), /SET status='refreshing'/),
      projects,
      () => key,
      kinds,
      () => now,
    )
    await expect(claim.resolveForTick(repo, now + 600000, now + 5000)).rejects.toThrow(
      'acknowledgement lost',
    )
    expect(calls).toBe(0)
    expect((await setup.list(repo))[0]!.status).toBe('refreshing')
    now += 6000
    await expect(setup.resolveForTick(repo, now + 600000, now + 1000)).rejects.toThrow(
      'secret-unavailable',
    )
    expect(calls).toBe(0)
    for (const before of [false, true]) {
      await setup.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        { ...payload, expiresAt: now + 1000 },
        'member',
      )
      const store = new PostgresProjectSecrets(
        uncertain(rebinding(url, { count: 0 }), /SET payload=/, before),
        projects,
        () => key,
        kinds,
        () => now,
      )
      if (before) {
        await expect(store.resolveForTick(repo, now + 600000, now + 5000)).rejects.toThrow(
          'secret-unavailable',
        )
        expect((await store.list(repo))[0]!.status).toBe('failed')
        const beforeRetry = calls
        await expect(store.resolveForTick(repo, now + 600000, now + 5000)).rejects.toThrow(
          'secret-unavailable',
        )
        expect(calls).toBe(beforeRetry)
      } else
        expect((await store.resolveForTick(repo, now + 600000, now + 5000)).env.KIMI_API_KEY).toBe(
          'fresh',
        )
      const beforeRetry = calls
      if (!before) await store.resolveForTick(repo, now + 600000, now + 5000)
      expect(calls).toBe(beforeRetry)
    }
    expect(calls).toBe(2)
  }),
)

live(
  'valid tokens before the refresh window are supplied; due refresh, malformed refresh and timeout are handled safely',
  () =>
    fixture(async (sql, _url, projects) => {
      let now = Date.now(),
        calls = 0
      const kinds = new Map<string, RefreshKind>([
        [
          'fake',
          {
            validateState: (s) => typeof s === 'string',
            async refresh() {
              calls++
              return { accessToken: 'fresh', state: 'rotated', expiresAt: now + 600000 }
            },
          },
        ],
      ])
      const store = new PostgresProjectSecrets(
        sql,
        projects,
        () => key,
        kinds,
        () => now,
      )
      await store.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        {
          accessToken: 'old',
          expiresAt: now + 600000,
          earliestRefreshAt: now + 10000,
          state: 'original',
        },
        'member',
      )
      expect((await store.resolveForTick(repo, now + 600000, now + 1000)).env.KIMI_API_KEY).toBe(
        'old',
      )
      expect(calls).toBe(0)
      now += 10000
      expect((await store.resolveForTick(repo, now + 600000, now + 1000)).env.KIMI_API_KEY).toBe(
        'fresh',
      )
      expect(calls).toBe(1)
      kinds.set('fake', {
        validateState: (s) => typeof s === 'string',
        async refresh() {
          return { accessToken: '', state: 'rotated', expiresAt: now + 3600000 }
        },
      })
      await store.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        { accessToken: 'old', expiresAt: now + 1000, state: 'original' },
        'member',
      )
      await expect(store.resolveForTick(repo, now, now + 1000)).rejects.toThrow(
        'secret-unavailable',
      )
      kinds.set('fake', {
        validateState: (s) => typeof s === 'string',
        async refresh() {
          return new Promise(() => {})
        },
      })
      await store.setPayload(
        repo,
        'KIMI_API_KEY',
        'fake',
        { accessToken: 'old', expiresAt: now + 1000, state: 'original' },
        'member',
      )
      await expect(store.resolveForTick(repo, now, now + 50)).rejects.toThrow('secret-unavailable')
      expect((await store.list(repo))[0]!.status).toBe('failed')
    }),
)

live(
  'all payloads validate before provider work; corrupted or reserved rows prevent partial resolution',
  () =>
    fixture(async (sql, _url, projects) => {
      let calls = 0
      const now = Date.now(),
        kinds = new Map<string, RefreshKind>([
          [
            'fake',
            {
              validateState: (s) => typeof s === 'string',
              async refresh() {
                calls++
                return { accessToken: 'fresh', state: 'rotated', expiresAt: now + 3600000 }
              },
            },
          ],
        ])
      const store = new PostgresProjectSecrets(sql, projects, () => key, kinds)
      await store.setPayload(
        repo,
        'ANTHROPIC_API_KEY',
        'fake',
        { accessToken: 'old', state: 'original', expiresAt: now },
        'member',
      )
      await store.set(repo, 'KIMI_API_KEY', 'static-marker', 'member')
      await sql`UPDATE project_secrets SET payload='invalid-envelope' WHERE name='KIMI_API_KEY'`
      await expect(store.resolveForTick(repo, now + 600000, Date.now() + 5000)).rejects.toThrow(
        'key-unavailable',
      )
      expect(calls).toBe(0)
      await store.set(repo, 'KIMI_API_KEY', 'static-marker', 'member')
      await sql`UPDATE project_secrets SET name='AB_TOKEN' WHERE name='KIMI_API_KEY'`
      await expect(store.resolveForTick(repo, now + 600000, Date.now() + 5000)).rejects.toThrow(
        'invalid-secret',
      )
      expect(calls).toBe(0)
    }),
)

live('empty snapshots need no key, while writes and nonempty resolution still fail closed', () =>
  fixture(async (sql, _url, projects) => {
    const emptyRepo = 'https://github.com/example/empty'
    await projects.add(emptyRepo, 'owner')
    const writer = new PostgresProjectSecrets(sql, projects, () => key)
    for (const rawKey of [undefined, 'malformed', Buffer.alloc(32, 2).toString('base64')]) {
      const store = new PostgresProjectSecrets(sql, projects, () => rawKey)
      const snapshot = await store.resolveForTick(emptyRepo, Date.now() + 600000, Date.now() + 5000)
      expect(snapshot.env).toEqual({})
      expect(snapshot.versions).toEqual([])
      await store.markSupplied(snapshot)
    }
    const unconfigured = new PostgresProjectSecrets(sql, projects, () => undefined)
    await expect(unconfigured.set(emptyRepo, 'KIMI_API_KEY', 'secret', 'member')).rejects.toThrow(
      'key-unavailable',
    )
    await expect(unconfigured.remove(emptyRepo, 'KIMI_API_KEY', 'member')).rejects.toThrow(
      'key-unavailable',
    )
    // A verifier in another project must not turn an unused feature into an outage.
    await writer.set(repo, 'KIMI_API_KEY', 'secret', 'member')
    for (const rawKey of [undefined, 'malformed', Buffer.alloc(32, 2).toString('base64')]) {
      const store = new PostgresProjectSecrets(sql, projects, () => rawKey)
      const snapshot = await store.resolveForTick(emptyRepo, Date.now() + 600000, Date.now() + 5000)
      await store.markSupplied(snapshot)
      await expect(
        store.resolveForTick(repo, Date.now() + 600000, Date.now() + 5000),
      ).rejects.toThrow('key-unavailable')
      await expect(store.set(emptyRepo, 'KIMI_API_KEY', 'secret', 'member')).rejects.toThrow(
        'key-unavailable',
      )
      await expect(store.remove(emptyRepo, 'KIMI_API_KEY', 'member')).rejects.toThrow(
        'key-unavailable',
      )
    }
    const snapshot = await unconfigured.resolveForTick(
      emptyRepo,
      Date.now() + 600000,
      Date.now() + 5000,
    )
    await writer.set(emptyRepo, 'KIMI_API_KEY', 'new-secret', 'member')
    await expect(unconfigured.markSupplied(snapshot)).rejects.toThrow('stale-secrets')
    expect((await writer.list(emptyRepo))[0]!.lastSuppliedAt).toBeNull()
  }),
)

live(
  'minute 50 supplies a token expiring at 60; minute 55 refreshes and warns without failing',
  () =>
    fixture(async (sql, _url, projects) => {
      const origin = Date.now()
      let now = origin + 50 * 60000,
        calls = 0
      const store = new PostgresProjectSecrets(
        sql,
        projects,
        () => key,
        new Map([
          [
            'fake',
            {
              validateState: (s: unknown) => typeof s === 'string',
              async refresh() {
                calls++
                return {
                  accessToken: 'rotated-access',
                  state: 'rotated-refresh',
                  expiresAt: now + 60 * 60000,
                  earliestRefreshAt: now + 55 * 60000,
                }
              },
            },
          ],
        ]),
        () => now,
      )
      await store.setPayload(
        repo,
        'PLAN_ACCESS',
        'fake',
        {
          accessToken: 'old-access',
          state: 'old-refresh',
          expiresAt: origin + 60 * 60000,
          earliestRefreshAt: origin + 55 * 60000,
        },
        'member',
      )
      const before = await store.resolveForTick(repo, now + 600000, now + 1000)
      expect(before.env.PLAN_ACCESS).toBe('old-access')
      await store.markSupplied(before)
      expect(calls).toBe(0)
      expect((await store.list(repo))[0]!.warnings).toEqual(['refresh-window-too-short'])
      now = origin + 55 * 60000
      const after = await store.resolveForTick(repo, now + 600000, now + 1000)
      expect(after.env.PLAN_ACCESS).toBe('rotated-access')
      await store.markSupplied(after)
      expect(calls).toBe(1)
      expect((await store.list(repo))[0]!.status).toBe('ready')
    }),
)

live('a missed tick refreshes expired access state and retains static peers', () =>
  fixture(async (sql, _url, projects) => {
    let now = Date.now(),
      calls = 0
    const store = new PostgresProjectSecrets(
      sql,
      projects,
      () => key,
      new Map([
        [
          'fake',
          {
            validateState: (s: unknown) => typeof s === 'string',
            async refresh(state: unknown) {
              calls++
              expect(state).toBe('refresh-original')
              return { accessToken: 'renewed', state: 'rotated', expiresAt: now + 3600000 }
            },
          },
        ],
      ]),
      () => now,
    )
    await store.set(repo, 'STATIC_PEER', 'static-value', 'member')
    await store.setPayload(
      repo,
      'PLAN_ACCESS',
      'fake',
      {
        accessToken: 'old',
        state: 'refresh-original',
        expiresAt: now + 3600000,
      },
      'member',
    )
    now += 3700000
    const result = await store.resolveForTick(repo, now + 600000, now + 1000)
    expect(result.env).toEqual({ STATIC_PEER: 'static-value', PLAN_ACCESS: 'renewed' })
    expect(calls).toBe(1)
    expect((await store.list(repo)).every((entry) => entry.status === 'ready')).toBe(true)
    await store.markSupplied(result)
  }),
)

live('providers without a refresh window renew ten minutes before expiry', () =>
  fixture(async (sql, _url, projects) => {
    const now = Date.now()
    let calls = 0
    const store = new PostgresProjectSecrets(
      sql,
      projects,
      () => key,
      new Map([
        [
          'fake',
          {
            validateState: (s: unknown) => typeof s === 'string',
            async refresh() {
              calls++
              return { accessToken: 'renewed', state: 'rotated', expiresAt: now + 3600000 }
            },
          },
        ],
      ]),
      () => now,
    )
    await store.setPayload(
      repo,
      'PLAN_ACCESS',
      'fake',
      {
        accessToken: 'old',
        state: 'original',
        expiresAt: now + 9 * 60000,
      },
      'member',
    )
    expect((await store.resolveForTick(repo, now + 600000, now + 1000)).env.PLAN_ACCESS).toBe(
      'renewed',
    )
    expect(calls).toBe(1)
  }),
)

live(
  'a successful short-lived replacement is supplied once per resolution without a rotation loop',
  () =>
    fixture(async (sql, _url, projects) => {
      const now = Date.now()
      let calls = 0
      const store = new PostgresProjectSecrets(
        sql,
        projects,
        () => key,
        new Map([
          [
            'fake',
            {
              validateState: (s: unknown) => typeof s === 'string',
              async refresh() {
                calls++
                return {
                  accessToken: 'short-lived',
                  state: 'rotated',
                  expiresAt: now + 30000,
                  earliestRefreshAt: now,
                }
              },
            },
          ],
        ]),
        () => now,
      )
      await store.setPayload(
        repo,
        'PLAN_ACCESS',
        'fake',
        { accessToken: 'old', state: 'refresh-old', expiresAt: now + 1000 },
        'member',
      )
      const snapshot = await store.resolveForTick(repo, now + 600000, now + 1000)
      expect(snapshot.env.PLAN_ACCESS).toBe('short-lived')
      expect(calls).toBe(1)
      await store.markSupplied(snapshot)
    }),
)

live(
  'typed ChatGPT registrations retain encrypted rotating state and stable project host identity',
  () =>
    fixture(async (sql, url, projects) => {
      let now = 2_000_000_000_000
      let calls = 0
      let entered!: () => void, release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const adapter: RefreshKind = {
        validateState: (raw) => chatgptStateSchema.safeParse(raw).success,
        refresh: async (raw) => {
          calls++
          entered()
          await gate
          const state = chatgptStateSchema.parse(raw)
          const next = {
            ...state,
            accessToken: 'sentinel-next-access',
            refreshToken: 'sentinel-next-refresh',
            expiresAt: now + 7200000,
            earliestRefreshAt: now + 3600000,
          }
          return {
            accessToken: next.accessToken,
            expiresAt: next.expiresAt,
            earliestRefreshAt: next.earliestRefreshAt,
            state: next,
          }
        },
      }
      const store = new PostgresProjectSecrets(
        sql,
        projects,
        () => key,
        new Map([['chatgpt-subscription', adapter]]),
        () => now,
      )
      const hostId = await store.chatgptHost(repo)
      expect(hostId).toBe(await store.chatgptHost(repo))
      const state = {
        version: 1 as const,
        hostId,
        clientId: 'issued',
        subject: 'subject',
        accessToken: 'sentinel-initial-access',
        refreshToken: 'sentinel-initial-refresh',
        idToken: 'sentinel-id-token',
        scopes: ['chatgpt.tokens.use.direct', 'offline_access'],
        expiresAt: now + 3600000,
        earliestRefreshAt: now - 1000,
      }
      await store.setChatGPT(repo, 'CHATGPT_ACCESS', state, 'member')
      expect((await store.resolveForTick(repo, now + 7200000, now + 10000)).env).toEqual({
        CHATGPT_ACCESS: 'sentinel-initial-access',
      })
      expect(calls).toBe(0)
      now = state.expiresAt - 600000
      const first = store.resolveForTick(repo, now + 600000, now + 10000)
      await started
      let observed!: () => void
      const refreshingRead = new Promise<void>((resolve) => {
        observed = resolve
      })
      const peerPool = rebinding(url, { count: 0 }, observed)
      const peer = new PostgresProjectSecrets(
        peerPool,
        projects,
        () => key,
        new Map([['chatgpt-subscription', adapter]]),
        () => now,
      )
      const second = peer.resolveForTick(repo, now + 600000, now + 10000)
      await refreshingRead
      release()
      const snapshots = await Promise.all([first, second])
      expect(calls).toBe(1)
      for (const snapshot of snapshots)
        expect(snapshot.env).toEqual({ CHATGPT_ACCESS: 'sentinel-next-access' })
      expect(await store.chatgptHost(repo)).toBe(hostId)
      const persisted = JSON.stringify(await sql`SELECT * FROM project_secrets`)
      const metadata = JSON.stringify(await store.list(repo))
      for (const value of [
        'sentinel-initial-access',
        'sentinel-initial-refresh',
        'sentinel-next-access',
        'sentinel-next-refresh',
        'sentinel-id-token',
      ]) {
        expect(persisted).not.toContain(value)
        expect(metadata).not.toContain(value)
      }
    }),
)

live('browser writes are atomic static-only mutations and preserve refreshing registrations', () =>
  fixture(async (sql, _url, projects) => {
    const kinds = new Map<string, RefreshKind>([
      [
        'chatgpt-subscription',
        {
          validateState: () => true,
          refresh: async () => {
            throw Error('unused')
          },
        },
      ],
    ])
    const store = new PostgresProjectSecrets(sql, projects, () => key, kinds)
    await store.setStaticOnly(repo, 'TOKEN', 'first', 'browser')
    await store.setStaticOnly(repo, 'TOKEN', 'second', 'browser-two')
    expect((await store.resolveForObservation(repo)).env.TOKEN).toBe('second')
    const payload = {
      accessToken: 'provider-token',
      expiresAt: Date.now() + 3600000,
      state: { marker: 'provider-state' },
    }
    await store.setPayload(repo, 'TOKEN', 'chatgpt-subscription', payload, 'cli')
    for (const status of ['ready', 'refreshing', 'failed']) {
      await sql`UPDATE project_secrets SET status=${status} WHERE repo=${repo} AND name='TOKEN'`
      const before = JSON.stringify(await sql`SELECT * FROM project_secrets`)
      const audit = JSON.stringify(await sql`SELECT * FROM project_secret_audit ORDER BY id`)
      await expect(store.setStaticOnly(repo, 'TOKEN', 'pasted', 'browser')).rejects.toThrow(
        'Refreshing credentials',
      )
      expect(JSON.stringify(await sql`SELECT * FROM project_secrets`)).toBe(before)
      expect(JSON.stringify(await sql`SELECT * FROM project_secret_audit ORDER BY id`)).toBe(audit)
    }
    // A CLI registration that holds the shared lock wins before the browser checks kind.
    await store.set(repo, 'TOKEN', 'static', 'cli')
    let unlock!: () => void, locked!: () => void
    const held = new Promise<void>((resolve) => {
      locked = resolve
    })
    const release = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const registration = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`project-secrets:${repo}`},0))`
      locked()
      await release
      await tx`UPDATE project_secrets SET kind='chatgpt-subscription' WHERE repo=${repo} AND name='TOKEN'`
    })
    await held
    const write = store.setStaticOnly(repo, 'TOKEN', 'pasted', 'browser')
    const outcome = write.then(
      () => undefined,
      (error: unknown) => error,
    )
    unlock()
    await registration
    expect(await outcome).toBeInstanceOf(StaticSecretConflictError)
    // The unrestricted CLI operation retains its existing replacement semantics.
    await store.set(repo, 'TOKEN', 'cli-static', 'cli')
    expect((await store.list(repo))[0]?.kind).toBe('static')
  }),
)

for (const floorOffset of [undefined, -900000, 0, 300000]) {
  live(`hosted refresh gates expiry and provider floor: ${floorOffset}`, () =>
    fixture(async (sql, _url, projects) => {
      const expiry = 2_000_003_600_000
      const threshold = expiry - 600000
      const floor = floorOffset === undefined ? undefined : threshold + floorOffset
      const due = Math.max(threshold, floor ?? 0)
      let now = threshold - 900000
      const states: unknown[] = []
      const store = new PostgresProjectSecrets(
        sql,
        projects,
        () => key,
        new Map([
          [
            'fake',
            {
              validateState: (s: unknown) => typeof s === 'string',
              async refresh(state: unknown) {
                states.push(state)
                return {
                  accessToken: 'fresh',
                  state: `rotation-${states.length}`,
                  expiresAt: now + 3600000,
                }
              },
            },
          ],
        ]),
        () => now,
      )
      const register = () =>
        store.setPayload(
          repo,
          'PLAN_ACCESS',
          'fake',
          {
            accessToken: 'old',
            state: 'original',
            expiresAt: expiry,
            ...(floor === undefined ? {} : { earliestRefreshAt: floor }),
          },
          'member',
        )
      const resolve = () => store.resolveForTick(repo, now + 7200000, now + 10000)
      await register()
      for (const tick of [threshold - 600000, threshold - 300000, due - 1]) {
        now = tick
        expect((await resolve()).env.PLAN_ACCESS).toBe('old')
        expect(states).toEqual([])
        expect((await store.list(repo))[0]!.status).toBe('ready')
      }
      now = due
      expect((await resolve()).env.PLAN_ACCESS).toBe('fresh')
      expect(states).toEqual(['original'])
      now += 300000
      expect((await resolve()).env.PLAN_ACCESS).toBe('fresh')
      expect(states).toEqual(['original'])
      now = due + 3000000
      await resolve()
      expect(states).toEqual(['original', 'rotation-1'])
      // A fresh registration also becomes eligible immediately after the boundary.
      await register()
      now = due + 1
      await resolve()
      expect(states).toEqual(['original', 'rotation-1', 'original'])
    }),
  )
}

live('expired access behind a future provider floor fails closed without rotation', () =>
  fixture(async (sql, _url, projects) => {
    let now = 2_000_000_000_000
    let calls = 0
    const store = new PostgresProjectSecrets(
      sql,
      projects,
      () => key,
      new Map([
        [
          'fake',
          {
            validateState: () => true,
            async refresh() {
              calls++
              throw new Error('must not refresh')
            },
          },
        ],
      ]),
      () => now,
    )
    await store.setPayload(
      repo,
      'PLAN_ACCESS',
      'fake',
      {
        accessToken: 'expired',
        state: 'original',
        expiresAt: now - 1,
        earliestRefreshAt: now + 300000,
      },
      'member',
    )
    for (let tick = 0; tick < 2; tick++) {
      const deadline = now + 100
      const advance = setTimeout(() => {
        now = deadline
      }, 20)
      try {
        await expect(store.resolveForTick(repo, now + 600000, deadline)).rejects.toThrow(
          'secret-unavailable',
        )
      } finally {
        clearTimeout(advance)
      }
    }
    expect(calls).toBe(0)
  }),
)

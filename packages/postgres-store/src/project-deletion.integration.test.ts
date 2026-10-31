import { afterEach, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { migratePostgres } from './schema'
import { PostgresProjectRegistry } from './projects'
import { PostgresProjectDeletion } from './project-deletion'

const url = process.env.AB_POSTGRES_TEST_URL?.trim()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const admin = new SQL(url!)
  const schema = `deletion_${crypto.randomUUID().replaceAll('-', '')}`
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  const scoped = new URL(url!)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  const address = scoped.toString()
  const sql = new SQL(address)
  cleanups.push(async () => {
    await sql.close()
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
    await admin.close()
  })
  await migratePostgres(address)
  const registry = new PostgresProjectRegistry(sql)
  const actor = { email: 'operator@example.com', isSuperUser: () => true }
  const objects = new Set<string>()
  let fail = false
  const maintenance = {
    delete: async (ref: string) => {
      if (fail) throw new Error('provider unavailable')
      objects.delete(ref)
    },
  }
  return {
    sql,
    address,
    registry,
    actor,
    objects,
    maintenance,
    setFailure: (value: boolean) => {
      fail = value
    },
  }
}
const repo = 'https://github.com/acme/one'
const other = 'https://github.com/acme/two'

test.skipIf(!url)(
  'generation-bound deletion is resumable and old confirmation never deletes a reconnection',
  async () => {
    const f = await fixture()
    await f.registry.add(repo, f.actor.email)
    const lifecycle = new PostgresProjectDeletion(f.sql, f.maintenance)
    const preview = await lifecycle.preview(f.actor, repo)
    f.objects.add('exclusive')
    await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},'exclusive')`
    f.setFailure(true)
    await expect(lifecycle.delete(f.actor, repo, preview.token)).rejects.toThrow(
      'provider unavailable',
    )
    expect(await f.registry.has(repo)).toBe(false)
    const [rotated] = await f.sql`SELECT generation FROM project_generations WHERE repo = ${repo}`
    expect(`"${rotated.generation}"`).not.toBe(preview.token)
    expect((await lifecycle.preview(f.actor, repo)).token).toBe(preview.token)
    const { admitProject } = await import('./project-lifecycle')
    await expect(
      f.sql.begin(async (tx) => {
        await admitProject(tx as SQL, { repo, generation: preview.token.slice(1, -1) })
      }),
    ).rejects.toThrow('project not registered')
    await expect(f.registry.add(repo, f.actor.email)).rejects.toThrow('unfinished')
    expect((await f.sql`SELECT * FROM project_deletion_blobs WHERE repo = ${repo}`).length).toBe(1)
    f.setFailure(false)
    await new PostgresProjectDeletion(f.sql, f.maintenance).delete(f.actor, repo, preview.token)
    expect(f.objects.size).toBe(0)
    const [audit] = await f.sql`SELECT * FROM project_deletion_audit WHERE repo = ${repo}`
    expect(Object.keys(audit).sort()).toEqual(['actor', 'generation', 'repo', 'ts'])
    expect((await f.sql`SELECT * FROM project_deletions WHERE repo = ${repo}`).length).toBe(0)
    await f.registry.add(repo, f.actor.email)
    const fresh = await lifecycle.preview(f.actor, repo)
    expect(fresh.token).not.toBe(preview.token)
    await lifecycle.delete(f.actor, repo, preview.token)
    expect(await f.registry.has(repo)).toBe(true)
    await expect(lifecycle.delete(f.actor, repo, '"different-generation"')).rejects.toMatchObject({
      status: 412,
    })
    await expect(lifecycle.delete(f.actor, repo, null)).rejects.toMatchObject({ status: 428 })
  },
)

test.skipIf(!url)('another project reservation preserves shared bytes', async () => {
  const f = await fixture()
  await f.registry.add(repo, f.actor.email)
  await f.registry.add(other, f.actor.email)
  f.objects.add('shared')
  await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},'shared'),(${other},'shared')`
  const lifecycle = new PostgresProjectDeletion(f.sql, f.maintenance)
  await lifecycle.delete(f.actor, repo, (await lifecycle.preview(f.actor, repo)).token)
  expect(f.objects.has('shared')).toBe(true)
  expect(await f.registry.has(other)).toBe(true)
  expect((await f.sql`SELECT * FROM project_blob_ownership WHERE repo = ${other}`).length).toBe(1)
})

test.skipIf(!url)(
  'purges legacy references and every project row while preserving a sibling organization project',
  async () => {
    const f = await fixture()
    const { PostgresOrganizationStore } = await import('./organizations')
    const orgs = new PostgresOrganizationStore(f.sql)
    const org = await orgs.create(f.actor, 'Acme', 'acme')
    await orgs.addMember(f.actor, org.id, 'owner@example.com')
    await orgs.setOwner(f.actor, org.id, 'owner@example.com')
    const owner = { email: 'owner@example.com', isSuperUser: () => false }
    const member = { email: 'member@example.com', isSuperUser: () => false }
    await orgs.addMember(f.actor, org.id, member.email)
    for (const [index, repository] of [repo, other].entries()) {
      await f.registry.add(repository, f.actor.email)
      await orgs.assign(f.actor, org.id, repository)
      const build = `build-${index}`,
        session = `session-${index}`
      await f.sql`INSERT INTO builds (slug,repo,created_at,updated_at) VALUES (${build},${repository},now(),now())`
      await f.sql`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repository},now(),now())`
      await f.sql`INSERT INTO sessions (id,repo,operator,creation_seq,created_at,updated_at) VALUES (${session},${repository},'operator',1,now(),now())`
      for (const [table, column, key] of [
        ['events', 'build', build],
        ['session_events', 'session', session],
        ['repo_events', 'repo', repository],
      ]) {
        await f.sql.unsafe(
          `INSERT INTO ${table} (${column},seq,ts,actor,type,payload) VALUES ($1,1,now(),'{}','legacy',$2::jsonb)`,
          [key, { artifact: { blobRef: `event-${index}` } }],
        )
      }
      await f.sql`INSERT INTO artifacts (build,kind,revision,blob_ref,metadata,created_at) VALUES (${build},'legacy',0,${`artifact-${index}`},'{}',now())`
      await f.sql`INSERT INTO session_artifacts (session,kind,revision,blob_ref,metadata,created_at) VALUES (${session},'legacy',0,${`session-${index}`},'{}',now())`
      await f.sql`INSERT INTO repo_artifacts (repo,kind,revision,blob_ref,metadata,created_at) VALUES (${repository},'legacy',0,${`repo-${index}`},'{}',now())`
      await f.sql`INSERT INTO ticket_assets (repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES (${repository},'ticket','design','reference',0,'file',${JSON.stringify([{ type: 'file', path: 'reference', blobRef: `asset-${index}`, size: 1 }])}::jsonb,1,true,now())`
      await f.sql`INSERT INTO ab_tickets (repo,id,readable_id,ticket_number,title,body,state,created_at,updated_at) VALUES (${repository},'ticket','AUT-3',3,'Ticket','body','Ready',now(),now())`
      await f.sql`INSERT INTO ab_ticket_comments (repo,ticket_id,seq,body,created_at) VALUES (${repository},'ticket',1,'comment',now())`
      await f.sql`INSERT INTO ab_ticket_states (repo,name) VALUES (${repository},'Ready')`
      await f.sql`INSERT INTO ab_ticket_counters (repo,last_number) VALUES (${repository},3)`
      await f.sql`INSERT INTO reducer_snapshots (scope_kind,scope_key,reducer,version,cursor,state,updated_at) VALUES ('build',${build},'legacy',1,1,'{}',now()),('repo',${repository},'legacy',1,1,'{}',now())`
      for (const [kind, key] of [
        ['build', build],
        ['repo', repository],
      ]) {
        await f.sql`INSERT INTO stream_seed_generations(scope_kind,scope_key,identity) VALUES (${kind},${key},'test-seed')`
        await f.sql`INSERT INTO stream_seed_checkpoints(scope_kind,scope_key,identity,cursor,snapshot) VALUES (${kind},${key},'test-seed',1,'{}')`
      }
      await f.sql`INSERT INTO project_secret_audit (id,repo,name,actor,ts,action) VALUES (${`audit-${index}`},${repository},'KEY','actor',now(),'set')`
      await f.sql`INSERT INTO project_secrets (repo,name,kind,owner,set_at,fingerprint,payload,generation,revision,status) VALUES (${repository},'KEY','static','owner',now(),'fingerprint','encrypted','generation',1,'ready')`
      await f.sql`INSERT INTO streams (id,scope_kind,build,label,format,status,artifact_blob_ref,created_at,creation_seq) VALUES (${`stream-${index}`},'build',${build},'legacy','ui-message','closed',${`stream-${index}`},now(),1)`
      await f.sql`INSERT INTO stream_chunks (stream,seq,ts,parts) VALUES (${`stream-${index}`},1,now(),'[]')`
      await f.sql`UPDATE builds SET node_writer_holder='writer',node_writer_expires_at=now(),node_writer_ttl_ms=1000 WHERE slug=${build}`
      await f.sql`INSERT INTO project_credentials (id,digest,repo,created_at,created_by,purpose) VALUES (${`credential-${index}`},'digest',${repository},now(),'owner','project-owner')`
      await f.sql`INSERT INTO project_connections (id,repo,credential_id,digest,capability_hash,code,created_at,expires_at,status) VALUES (${`connection-${index}`},${repository},'credential','digest','capability',${`code-${index}`},now(),now(),'pending')`
      await f.sql`INSERT INTO project_ticket_policy (repo,registration,policy,writer,updated_at) VALUES (${repository},1,'{}','owner',now())`
      await f.sql`INSERT INTO ticket_grants (id,digest,repo,registration,execution,kind,expires_at) VALUES (${`grant-${index}`},${`digest-${index}`},${repository},1,'execution','runner',now())`
      await f.sql`INSERT INTO ticket_grants (id,digest,repo,registration,execution,kind,parent,expires_at) VALUES (${`child-${index}`},${`child-digest-${index}`},${repository},1,'execution','phase',${`grant-${index}`},now())`
      await f.sql`INSERT INTO project_secrets (repo,name,kind,owner,set_at,fingerprint,payload,generation,revision,status) VALUES (${repository},'ACCOUNT','subscription','owner',now(),'fingerprint','encrypted','generation',1,'ready')`
      await f.sql`INSERT INTO scan_cadence (repo,value) VALUES (${repository},'{}')`
      await f.sql`INSERT INTO operator_presence (repo,id,host,pid,started_at,heartbeat_at) VALUES (${repository},'operator','host',1,now(),now())`
      for (const prefix of ['event', 'artifact', 'session', 'repo', 'asset', 'stream'])
        f.objects.add(`${prefix}-${index}`)
    }
    const deletion = new PostgresProjectDeletion(f.sql, f.maintenance)
    await expect(deletion.preview(member, repo)).rejects.toMatchObject({ status: 403 })
    await expect(
      deletion.delete(member, repo, (await deletion.preview(owner, repo)).token),
    ).rejects.toMatchObject({ status: 403 })
    expect(await deletion.preview(owner, repo)).toMatchObject({
      builds: 1,
      tickets: 1,
      secrets: 1,
      subscriptionAccounts: 1,
    })
    await deletion.delete(owner, repo, (await deletion.preview(owner, repo)).token)
    const tables =
      await f.sql`SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='repo'`
    for (const { table_name: table } of tables) {
      const rows: unknown[] = await f.sql.unsafe(`SELECT * FROM "${table}" WHERE repo=$1`, [repo])
      expect(rows.length, table).toBe(table === 'project_deletion_audit' ? 1 : 0)
    }
    for (const table of [
      'events',
      'session_events',
      'artifacts',
      'session_artifacts',
      'streams',
      'stream_chunks',
    ]) {
      expect((await f.sql.unsafe(`SELECT * FROM ${table}`)).length, table).toBe(1)
    }
    expect((await f.sql`SELECT * FROM reducer_snapshots`).length).toBe(2)
    for (const table of ['stream_seed_generations', 'stream_seed_checkpoints']) {
      const remaining = await f.sql.unsafe(`SELECT scope_kind,scope_key FROM ${table}`)
      expect(remaining).toHaveLength(2)
      expect(
        remaining.every(
          (row: { scope_key: string }) => row.scope_key === other || row.scope_key === 'build-1',
        ),
      ).toBe(true)
    }
    expect([...f.objects].sort()).toEqual([
      'artifact-1',
      'asset-1',
      'event-1',
      'repo-1',
      'session-1',
      'stream-1',
    ])
    expect(await orgs.projects(owner)).toEqual([other])
    expect((await orgs.inspect(owner, org.id)).projects).toEqual([other])
  },
)

test.skipIf(!url)(
  'concurrent deletion of both owners of shared bytes leaves no orphan',
  async () => {
    const f = await fixture()
    for (const repository of [repo, other]) {
      await f.registry.add(repository, f.actor.email)
      await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repository},'shared')`
    }
    f.objects.add('shared')
    const deletion = new PostgresProjectDeletion(f.sql, f.maintenance)
    const previews = await Promise.all(
      [repo, other].map((repository) => deletion.preview(f.actor, repository)),
    )
    await Promise.all(
      previews.map((preview) => deletion.delete(f.actor, preview.repo, preview.token)),
    )
    expect(f.objects.size).toBe(0)
  },
)

/** Rebind every transaction like a transaction-mode pooler and reject every
 * session-affine API, including unsafe SQL and shared session advisory locks. */
function rebinding(address: string, active: { n: number }): SQL {
  const forbidden = (text: string) => {
    if (/pg_advisory_(?:lock|unlock)(?:_shared)?\s*\(|^\s*SET\s/i.test(text))
      throw new Error('session affinity forbidden')
  }
  const wrap = (sql: SQL): SQL => {
    const q = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      forbidden(parts.join(''))
      return sql(parts, ...values)
    }) as SQL
    q.unsafe = ((text: string, params?: unknown[]) => {
      forbidden(text)
      return sql.unsafe(text, params)
    }) as SQL['unsafe']
    q.array = sql.array.bind(sql)
    return q
  }
  const q = ((..._args: unknown[]) => {
    throw new Error('nontransactional query forbidden')
  }) as unknown as SQL
  q.begin = (async (work: (tx: SQL) => Promise<unknown>) => {
    const sql = new SQL(address, { max: 1 })
    try {
      return await sql.begin(async (tx) => {
        active.n++
        try {
          return await work(wrap(tx as SQL))
        } finally {
          active.n--
        }
      })
    } finally {
      await sql.close()
    }
  }) as SQL['begin']
  q.reserve = (() => {
    throw new Error('reserve forbidden')
  }) as SQL['reserve']
  return q
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test.skipIf(!url)(
  'transaction-pooler deposits reserve before upload and deletion waits for publication',
  async () => {
    const f = await fixture()
    const { PostgresBuildStore } = await import('./store')
    const { withHostedProjectContext, rememberProjectGeneration } = await import(
      './request-context'
    )
    const { captureProject } = await import('./project-lifecycle')
    for (const repository of [repo, other]) await f.registry.add(repository, f.actor.email)
    const admissions = await Promise.all(
      [repo, other].map((repository) => captureProject(f.sql, repository)),
    )
    const hosted = <T>(index: number, work: () => Promise<T>) =>
      withHostedProjectContext(() => {
        const admission = admissions[index]!
        rememberProjectGeneration(admission.repo, admission.generation)
        return work()
      })
    const active = { n: 0 },
      entered = barrier(),
      release = barrier()
    let block = false
    const objects = new Set<string>()
    const blobs = {
      put: async (ref: string, _bytes: Uint8Array) => {
        expect(active.n).toBeGreaterThan(0)
        expect(
          (await f.sql`SELECT 1 FROM project_blob_ownership WHERE blob_ref=${ref}`).length,
        ).toBeGreaterThan(0)
        objects.add(ref)
        if (block) {
          entered.resolve()
          await release.promise
        }
      },
      get: async (_ref: string) => null,
    }
    const store = new PostgresBuildStore(rebinding(f.address, active), { blobs })
    for (const repository of [repo, other])
      await hosted(repository === repo ? 0 : 1, () => store.ensureRepo(repository))
    await hosted(0, () => store.putRepoArtifact(repo, { kind: 'shared', content: 'shared bytes' }))
    block = true
    const upload = hosted(1, () =>
      store.putRepoArtifact(other, { kind: 'shared', content: 'shared bytes' }),
    )
    await entered.promise
    const deletion = new PostgresProjectDeletion(f.sql, {
      delete: async (ref) => {
        objects.delete(ref)
      },
    })
    const preview = await deletion.preview(f.actor, repo)
    let deleted = false
    const cleanup = deletion.delete(f.actor, repo, preview.token).then(() => {
      deleted = true
    })
    await Bun.sleep(25)
    expect(deleted).toBe(false)
    release.resolve()
    await upload
    await cleanup
    expect(objects.size).toBe(1)
    expect((await f.sql`SELECT * FROM repo_artifacts WHERE repo=${other}`).length).toBe(1)
    await expect(hosted(0, () => store.ensureRepo(repo))).rejects.toThrow('project not registered')
    await f.registry.add(repo, f.actor.email)
    await expect(hosted(0, () => store.ensureRepo(repo))).rejects.toThrow('project not registered')
  },
)

test.skipIf(!url)(
  'all blob deposits and stream reassembly survive backend rebinding and publication rollback',
  async () => {
    const f = await fixture()
    const { PostgresBuildStore } = await import('./store')
    const { withHostedProjectContext, rememberProjectGeneration } = await import(
      './request-context'
    )
    const { captureProject } = await import('./project-lifecycle')
    await f.registry.add(repo, f.actor.email)
    const admission = await captureProject(f.sql, repo),
      active = { n: 0 }
    let raceStream: string | undefined,
      uploads = 0
    const bytes = new Map<string, Uint8Array>()
    let store: InstanceType<typeof PostgresBuildStore>
    const blobs = {
      put: async (ref: string, data: Uint8Array) => {
        expect(active.n).toBeGreaterThan(0)
        expect(
          (await f.sql`SELECT 1 FROM project_blob_ownership WHERE repo=${repo} AND blob_ref=${ref}`)
            .length,
        ).toBe(1)
        uploads++
        bytes.set(ref, data)
        if (raceStream) {
          const stream = raceStream
          raceStream = undefined
          await store.appendStreamParts(stream, [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'concurrent chunk' },
            { type: 'text-end', id: 't' },
          ])
        }
      },
      get: async (ref: string) => bytes.get(ref) ?? null,
    }
    store = new PostgresBuildStore(rebinding(f.address, active), { blobs })
    await withHostedProjectContext(async () => {
      rememberProjectGeneration(repo, admission.generation)
      await store.ensureRepo(repo)
      await store.createBuild({ slug: 'pooler-build', repo })
      const session = await store.createSession({ repo, operator: 'owner' })
      await store.putArtifact('pooler-build', { kind: 'test', content: 'build bytes' })
      await store.putSessionArtifact(session.id, { kind: 'test', content: 'session bytes' })
      await store.putRepoArtifact(repo, { kind: 'test', content: 'repository bytes' })
      await store.putTicketAsset(repo, 'ticket', {
        kind: 'design',
        name: 'image',
        layout: 'file',
        entries: [
          { type: 'file', path: 'image', content: new TextEncoder().encode('asset bytes') },
        ],
      })
      await expect(
        store.appendWithArtifacts(
          'pooler-build',
          [{ kind: 'failed', content: 'rolled back bytes' }],
          () => {
            throw new Error('reject publication')
          },
        ),
      ).rejects.toThrow('reject publication')
      expect(await store.getArtifact('pooler-build', 'failed')).toBeNull()
      for (const scope of [
        { kind: 'build' as const, build: 'pooler-build' },
        { kind: 'session' as const, session: session.id },
        { kind: 'repo' as const, repo },
      ]) {
        const stream = await store.createStream(scope, 'stream')
        raceStream = stream.id
        const before = uploads
        expect((await store.closeStream(stream.id, 'completed')).status).toBe('closed')
        expect(uploads - before).toBe(2)
      }
    })
    const deletion = new PostgresProjectDeletion(f.sql, {
      delete: async (ref) => {
        bytes.delete(ref)
      },
    })
    await deletion.delete(f.actor, repo, (await deletion.preview(f.actor, repo)).token)
    expect(bytes.size).toBe(0)
  },
)

test.skipIf(!url)(
  'upload waits for exclusive physical deletion then restores valid shared bytes',
  async () => {
    const f = await fixture()
    const { PostgresBuildStore } = await import('./store')
    const { withHostedProjectContext, rememberProjectGeneration } = await import(
      './request-context'
    )
    const { captureProject } = await import('./project-lifecycle')
    for (const repository of [repo, other]) await f.registry.add(repository, f.actor.email)
    const active = { n: 0 },
      bytes = new Map<string, Uint8Array>(),
      entered = barrier(),
      release = barrier()
    const store = new PostgresBuildStore(rebinding(f.address, active), {
      blobs: {
        put: async (ref, data) => {
          bytes.set(ref, data)
        },
        get: async (ref) => bytes.get(ref) ?? null,
      },
    })
    const hosted = async <T>(repository: string, work: () => Promise<T>) => {
      const admission = await captureProject(f.sql, repository)
      return withHostedProjectContext(() => {
        rememberProjectGeneration(repository, admission.generation)
        return work()
      })
    }
    await hosted(repo, async () => {
      await store.ensureRepo(repo)
      await store.putRepoArtifact(repo, { kind: 'bytes', content: 'shared' })
    })
    const deletion = new PostgresProjectDeletion(f.sql, {
      delete: async (ref) => {
        entered.resolve()
        await release.promise
        bytes.delete(ref)
      },
    })
    const cleanup = deletion.delete(f.actor, repo, (await deletion.preview(f.actor, repo)).token)
    await entered.promise
    let published = false
    const upload = hosted(other, async () => {
      await store.ensureRepo(other)
      await store.putRepoArtifact(other, { kind: 'bytes', content: 'shared' })
      published = true
    })
    await Bun.sleep(25)
    expect(published).toBe(false)
    release.resolve()
    await cleanup
    await upload
    expect(bytes.size).toBe(1)
  },
)

test.skipIf(!url)(
  'v18 promotion preserves unregistered legacy projects for authorized full cleanup',
  async () => {
    const f = await fixture()
    const { SCHEMA_V18_CHECKSUM } = await import('./schema')
    await f.registry.add(repo, f.actor.email)
    await f.registry.remove(repo, f.actor.email)
    await f.sql`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repo},now(),now())`
    await f.sql`INSERT INTO repo_artifacts (repo,kind,revision,blob_ref,metadata,created_at) VALUES (${repo},'legacy',0,'legacy-bytes','{}',now())`
    f.objects.add('legacy-bytes')
    for (const table of [
      'project_generations',
      'project_deletions',
      'project_deletion_blobs',
      'project_blob_ownership',
      'project_deletion_audit',
    ])
      await f.sql.unsafe(`DROP TABLE ${table}`)
    await f.sql`UPDATE ab_schema_migrations SET version=18,checksum=${SCHEMA_V18_CHECKSUM}`
    await migratePostgres(f.address)
    const deletion = new PostgresProjectDeletion(f.sql, f.maintenance)
    await deletion.delete(f.actor, repo, (await deletion.preview(f.actor, repo)).token)
    expect(f.objects.size).toBe(0)
    expect((await f.sql`SELECT * FROM repo_streams WHERE repo=${repo}`).length).toBe(0)
  },
)

test.skipIf(!url)(
  'deletion rechecks ownership after Move and owner transfer, including retries',
  async () => {
    const f = await fixture()
    const { PostgresOrganizationStore } = await import('./organizations')
    const orgs = new PostgresOrganizationStore(f.sql)
    const a = await orgs.create(f.actor, 'A', 'a'),
      b = await orgs.create(f.actor, 'B', 'b')
    const owner = { email: 'a@example.com', isSuperUser: () => false },
      next = { email: 'b@example.com', isSuperUser: () => false }
    await orgs.addMember(f.actor, a.id, owner.email)
    await orgs.setOwner(f.actor, a.id, owner.email)
    await orgs.addMember(f.actor, b.id, next.email)
    await orgs.setOwner(f.actor, b.id, next.email)
    await f.registry.add(repo, f.actor.email)
    await orgs.assign(f.actor, a.id, repo)
    const deletion = new PostgresProjectDeletion(f.sql, f.maintenance)
    const preview = await deletion.preview(owner, repo)
    await orgs.assign(f.actor, b.id, repo)
    await expect(deletion.delete(owner, repo, preview.token)).rejects.toMatchObject({ status: 403 })
    expect(await f.registry.has(repo)).toBe(true)
    f.objects.add('blob')
    await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},'blob')`
    f.setFailure(true)
    await expect(deletion.delete(next, repo, preview.token)).rejects.toThrow('provider unavailable')
    const reloaded = new PostgresProjectDeletion(f.sql, f.maintenance)
    expect(await reloaded.pending(next)).toEqual([repo])
    expect(await reloaded.pending(f.actor)).toEqual([repo])
    expect(await reloaded.pending(owner)).toEqual([])
    expect(await orgs.projects(next)).not.toContain(repo)
    expect((await orgs.inspect(next, b.id)).projects).not.toContain(repo)
    await orgs.addMember(f.actor, b.id, owner.email)
    await orgs.setOwner(f.actor, b.id, owner.email)
    await expect(deletion.delete(next, repo, preview.token)).rejects.toMatchObject({ status: 403 })
    expect(await reloaded.pending(next)).toEqual([])
    expect(await reloaded.pending(owner)).toEqual([repo])
    f.setFailure(false)
    await reloaded.delete(owner, repo, preview.token)
    const [audit] = await f.sql`SELECT actor FROM project_deletion_audit WHERE repo=${repo}`
    expect(audit.actor).toBe(next.email)
    expect(await reloaded.pending(owner)).toEqual([])
  },
)

test.skipIf(!url)(
  'bounded cleanup batches retain all candidates on partial provider failure',
  async () => {
    const f = await fixture()
    await f.registry.add(repo, f.actor.email)
    const refs = Array.from({ length: 70 }, (_, i) => `blob-${String(i).padStart(3, '0')}`)
    for (const ref of refs) {
      f.objects.add(ref)
      await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},${ref})`
    }
    const batches: string[][] = []
    let failure = true
    const lifecycle = new PostgresProjectDeletion(f.sql, {
      delete: async () => {
        throw new Error('single-object path used')
      },
      deleteMany: async (batch) => {
        batches.push([...batch])
        for (const ref of batch) f.objects.delete(ref)
        if (failure && batches.length === 2) throw new Error('partial batch failure')
      },
    })
    const preview = await lifecycle.preview(f.actor, repo)
    await expect(lifecycle.delete(f.actor, repo, preview.token)).rejects.toThrow(
      'partial batch failure',
    )
    expect(batches.map((batch) => batch.length)).toEqual([32, 32])
    expect((await f.sql`SELECT * FROM project_deletion_blobs WHERE repo=${repo}`).length).toBe(38)
    expect(await lifecycle.pending(f.actor)).toEqual([repo])
    failure = false
    await lifecycle.delete(f.actor, repo, preview.token)
    expect(batches.map((batch) => batch.length)).toEqual([32, 32, 32, 6])
    expect(f.objects.size).toBe(0)
    expect(await lifecycle.pending(f.actor)).toEqual([])
  },
)

test.skipIf(!url)(
  'batch reference proof preserves legacy event-only and removed asset references',
  async () => {
    const f = await fixture()
    for (const repository of [repo, other]) await f.registry.add(repository, f.actor.email)
    const refs = ['legacy-event', 'legacy-asset', 'exclusive']
    for (const ref of refs) {
      f.objects.add(ref)
      await f.sql`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},${ref})`
    }
    await f.sql`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${other},now(),now())`
    await f.sql`INSERT INTO repo_events (repo,seq,ts,actor,type,payload) VALUES (${other},1,now(),'{}','legacy',${{ artifact: { blobRef: 'legacy-event' } }}::jsonb)`
    await f.sql`INSERT INTO ticket_assets (repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES (${other},'ticket','design','reference',0,'file',${JSON.stringify([{ type: 'file', path: 'ref', blobRef: 'legacy-asset', size: 1 }])}::jsonb,1,true,now())`
    const batches: string[][] = []
    const lifecycle = new PostgresProjectDeletion(f.sql, {
      delete: async () => {
        throw new Error('single-object path used')
      },
      deleteMany: async (batch) => {
        batches.push(batch)
        for (const ref of batch) f.objects.delete(ref)
      },
    })
    await lifecycle.delete(f.actor, repo, (await lifecycle.preview(f.actor, repo)).token)
    expect(batches).toEqual([['exclusive']])
    expect([...f.objects].sort()).toEqual(['legacy-asset', 'legacy-event'])
  },
)

test.skipIf(!url)(
  'deletion invalidates an admitted request at the next mutation, including blob publication',
  async () => {
    const { withHostedProjectContext } = await import('./request-context')
    const { captureProject, admitProject, reserveProjectBlobs } = await import(
      './project-lifecycle'
    )
    const f = await fixture()
    await f.registry.add(repo, f.actor.email)
    const lifecycle = new PostgresProjectDeletion(f.sql, f.maintenance)
    const preview = await lifecycle.preview(f.actor, repo)
    await withHostedProjectContext(async () => {
      const admission = await captureProject(f.sql, repo)
      await f.sql.begin(async (tx) => {
        await admitProject(tx as SQL, admission)
        await tx`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repo},now(),now())`
      })
      await reserveProjectBlobs(f.sql, admission, ['unpublished'])
      f.objects.add('unpublished')
      await lifecycle.delete(f.actor, repo, preview.token)
      expect(f.objects.has('unpublished')).toBe(false)
      // Request admission remains cached; only a fresh transaction may authorize writes.
      expect(await captureProject(f.sql, repo)).toEqual(admission)
      await expect(
        f.sql.begin(async (tx) => {
          await admitProject(tx as SQL, admission)
          await tx`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repo},now(),now())`
        }),
      ).rejects.toThrow('project not registered')
      expect(await f.sql`SELECT 1 FROM repo_streams WHERE repo = ${repo}`).toHaveLength(0)
    })
    await withHostedProjectContext(async () => {
      await expect(captureProject(f.sql, repo)).rejects.toThrow('project not registered')
    })
  },
)

test.skipIf(!url)(
  'generation locks last through commit; queued deletion does not block another project',
  async () => {
    const { captureProject, admitProject } = await import('./project-lifecycle')
    const f = await fixture()
    await f.registry.add(repo, f.actor.email)
    await f.registry.add(other, f.actor.email)
    const lifecycle = new PostgresProjectDeletion(f.sql, f.maintenance)
    const preview = await lifecycle.preview(f.actor, repo)
    const admission = await captureProject(f.sql, repo)
    const otherAdmission = await captureProject(f.sql, other)
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutation = f.sql.begin(async (tx) => {
      await admitProject(tx as SQL, admission)
      locked.resolve()
      await release.promise
      await tx`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repo},now(),now())`
    })
    await locked.promise
    const deletion = lifecycle.delete(f.actor, repo, preview.token)
    try {
      // Observe PostgreSQL's durable lock wait, not elapsed time.
      for (;;) {
        const [waiting] = await f.sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
        AND query LIKE 'SELECT generation FROM project_generations%FOR UPDATE%'`
        if (waiting) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(
        await f.sql`SELECT generation FROM project_generations WHERE repo = ${other}`,
      ).toHaveLength(1)
      await f.sql.begin(async (tx) => {
        await admitProject(tx as SQL, otherAdmission)
        await tx`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${other},now(),now())`
      })
    } finally {
      release.resolve()
      await mutation
      await deletion
    }
    expect(await f.sql`SELECT 1 FROM repo_streams WHERE repo = ${repo}`).toHaveLength(0)
    expect(await f.sql`SELECT 1 FROM repo_streams WHERE repo = ${other}`).toHaveLength(1)
  },
)

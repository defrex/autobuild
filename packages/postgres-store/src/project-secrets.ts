import { SQL } from 'bun'
import { randomUUID, createHmac } from 'node:crypto'
import {
  ProjectSecretError,
  chatgptStateSchema,
  refreshChatGPT,
  type ChatGPTState,
  validateSecretName,
  validateSecretValue,
  type ProjectSecretMetadata,
} from '@defrex/autobuild/project-secrets'
import { SecretCipher } from './project-secrets-crypto'
import {
  normalizeProjectRepository,
  PostgresProjectRegistry,
  type ProjectRegistryReader,
} from './projects'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertSchema } from './schema'

export type SecretPayload =
  | { value: string }
  | { accessToken: string; expiresAt: number; earliestRefreshAt?: number; state: unknown }
export interface RefreshKind {
  validateState(state: unknown): boolean
  refresh(
    state: unknown,
    signal: AbortSignal,
  ): Promise<{ accessToken: string; expiresAt: number; earliestRefreshAt?: number; state: unknown }>
}
export interface SecretSnapshot {
  repo: string
  minimumValidUntil?: number
  env: Record<string, string>
  versions: { name: string; generation: string; revision: string }[]
}
export interface ProjectSecretsManagement {
  list(repo: string): Promise<ProjectSecretMetadata[]>
  set(repo: string, name: string, value: string, actor: string): Promise<void>
  chatgptHost?(repo: string): Promise<string>
  setChatGPT?(repo: string, name: string, state: ChatGPTState, actor: string): Promise<void>
  remove(repo: string, name: string, actor: string): Promise<void>
}
export interface ProjectSecretsResolver {
  resolveForTick(repo: string, minimumValidUntil: number, deadline: number): Promise<SecretSnapshot>
  markSupplied(snapshot: SecretSnapshot): Promise<void>
}
interface Row {
  repo: string
  name: string
  kind: string
  owner: string
  set_at: string | Date
  fingerprint: string
  payload: string
  generation: string
  revision: string | number
  status: ProjectSecretMetadata['status']
  failure_code: string | null
  last_supplied_at: string | Date | null
  attempt_id: string | null
  attempt_deadline: string | Date
}
const stamp = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())
const context = (repo: string, name: string, kind: string) =>
  JSON.stringify(['project-secret', 1, repo, name, kind])
const metadata = (r: Row): ProjectSecretMetadata => ({
  name: r.name,
  kind: r.kind,
  owner: r.owner,
  setAt: stamp(r.set_at)!,
  fingerprint: r.fingerprint,
  status: r.status,
  failureCode: r.failure_code,
  lastSuppliedAt: stamp(r.last_supplied_at),
})
/** Every transaction may use a different backend; no session state is required. */
export class PostgresProjectSecrets implements ProjectSecretsManagement, ProjectSecretsResolver {
  constructor(
    private readonly sql: SQL,
    private readonly projects: ProjectRegistryReader,
    private readonly key: () => string | undefined,
    private readonly kinds: ReadonlyMap<string, RefreshKind> = new Map(),
    private readonly now: () => number = Date.now,
    private readonly ownsPool = false,
  ) {}
  private async registered(raw: string): Promise<string> {
    const repo = normalizeProjectRepository(raw)
    if (!(await this.projects.has(repo))) throw new ProjectSecretError('secret-unavailable')
    return repo
  }
  private async lock(tx: SQL, repo: string) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`project-secrets:${repo}`},0))`
  }
  private async cipher(tx: SQL, initialize = false): Promise<SecretCipher> {
    const cipher = new SecretCipher(this.key())
    if (initialize)
      await tx`INSERT INTO project_secret_keys (id,verifier) VALUES ('deployment',${cipher.encrypt('deployment-key-v1', 'verified')}) ON CONFLICT DO NOTHING`
    const [row] = await tx`SELECT verifier FROM project_secret_keys WHERE id = 'deployment'`
    if (row && cipher.decrypt('deployment-key-v1', row.verifier) !== 'verified')
      throw new ProjectSecretError('key-unavailable')
    return cipher
  }
  async list(raw: string): Promise<ProjectSecretMetadata[]> {
    const repo = await this.registered(raw)
    try {
      const { rows, payloads } = await this.read(repo)
      return rows.map((row, i) => {
        const payload = payloads[i]!
        return {
          ...metadata(row),
          ...('expiresAt' in payload &&
          payload.earliestRefreshAt !== undefined &&
          payload.expiresAt - payload.earliestRefreshAt < 360_000
            ? { warnings: ['refresh-window-too-short' as const] }
            : {}),
        }
      })
    } catch (error) {
      // Diagnosis remains possible with an unavailable key or malformed provider
      // state. Omitted warnings do not assert that a refresh window is sufficient.
      if (!(error instanceof ProjectSecretError)) throw error
      return (
        await this
          .sql`SELECT name,kind,owner,set_at,fingerprint,status,failure_code,last_supplied_at FROM project_secrets WHERE repo=${repo} ORDER BY name`
      ).map(metadata)
    }
  }

  async set(repo: string, name: string, value: string, actor: string): Promise<void> {
    validateSecretValue(value)
    return this.setPayload(repo, name, 'static', { value }, actor)
  }
  async chatgptHost(raw: string): Promise<string> {
    const repo = await this.registered(raw)
    const key = this.key()
    if (!key) throw new ProjectSecretError('key-unavailable')
    const bytes = createHmac('sha256', key)
      .update(JSON.stringify(['chatgpt-host', repo]))
      .digest()
      .subarray(0, 16)
    bytes[6] = (bytes[6]! & 15) | 64
    bytes[8] = (bytes[8]! & 63) | 128
    const hex = bytes.toString('hex')
    return (
      'urn:uuid:' +
      [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join(
        '-',
      )
    )
  }
  async setChatGPT(repo: string, name: string, raw: ChatGPTState, actor: string): Promise<void> {
    const result = chatgptStateSchema.safeParse(raw)
    if (!result.success || result.data.expiresAt <= this.now())
      throw new ProjectSecretError('invalid-secret')
    const state = result.data
    if (state.hostId !== (await this.chatgptHost(repo)))
      throw new ProjectSecretError('invalid-secret')
    await this.setPayload(
      repo,
      name,
      'chatgpt-subscription',
      {
        accessToken: state.accessToken,
        expiresAt: state.expiresAt,
        ...(state.earliestRefreshAt === undefined
          ? {}
          : { earliestRefreshAt: state.earliestRefreshAt }),
        state,
      },
      actor,
    )
  }
  /** Internal provider state never crosses the metadata read protocol. */
  async setPayload(
    raw: string,
    name: string,
    kind: string,
    payload: SecretPayload,
    actor: string,
  ): Promise<void> {
    validateSecretName(name)
    if (!actor.trim()) throw new ProjectSecretError('invalid-secret')
    this.validatePayload(kind, payload)
    const repo = await this.registered(raw)
    await this.sql.begin(async (tx) => {
      await this.lock(tx as SQL, repo)
      const cipher = await this.cipher(tx as SQL, true)
      const encrypted = cipher.encrypt(context(repo, name, kind), payload)
      await tx`INSERT INTO project_secrets (repo,name,kind,owner,set_at,fingerprint,payload,generation,revision,status)
        VALUES (${repo},${name},${kind},${actor},${new Date(this.now()).toISOString()},${cipher.fingerprint(payload)},${encrypted},${randomUUID()},1,'ready')
        ON CONFLICT(repo,name) DO UPDATE SET kind=EXCLUDED.kind,owner=EXCLUDED.owner,set_at=EXCLUDED.set_at,fingerprint=EXCLUDED.fingerprint,payload=EXCLUDED.payload,generation=EXCLUDED.generation,revision=1,status='ready',failure_code=NULL,last_supplied_at=NULL,attempt_id=NULL,attempt_deadline=NULL`
      await this.audit(tx as SQL, repo, name, actor, 'set')
    })
  }
  private validatePayload(kind: string, payload: SecretPayload): void {
    if (kind === 'static') {
      validateSecretValue((payload as { value: string }).value)
      return
    }
    const p = payload as Exclude<SecretPayload, { value: string }>
    const adapter = this.kinds.get(kind)
    if (
      !adapter ||
      !p ||
      !adapter.validateState(p.state) ||
      !Number.isFinite(p.expiresAt) ||
      (p.earliestRefreshAt !== undefined && !Number.isFinite(p.earliestRefreshAt))
    )
      throw new ProjectSecretError('secret-unavailable')
    validateSecretValue(p.accessToken)
    if (!p.accessToken.trim()) throw new ProjectSecretError('secret-unavailable')
  }
  private async audit(tx: SQL, repo: string, name: string, actor: string, action: string) {
    await tx`INSERT INTO project_secret_audit (id,repo,name,actor,ts,action) VALUES (${randomUUID()},${repo},${name},${actor},${new Date(this.now()).toISOString()},${action})`
  }
  async remove(raw: string, name: string, actor: string): Promise<void> {
    validateSecretName(name)
    if (!actor.trim()) throw new ProjectSecretError('invalid-secret')
    const repo = await this.registered(raw)
    await this.sql.begin(async (tx) => {
      await this.lock(tx as SQL, repo)
      await this.cipher(tx as SQL)
      await tx`DELETE FROM project_secrets WHERE repo=${repo} AND name=${name}`
      await this.audit(tx as SQL, repo, name, actor, 'remove')
    })
  }
  private async read(repo: string): Promise<{ rows: Row[]; payloads: SecretPayload[] }> {
    return this.sql.begin(async (tx) => {
      await this.lock(tx as SQL, repo)
      const rows: Row[] = await tx`SELECT * FROM project_secrets WHERE repo=${repo} ORDER BY name`
      // Projects that have not opted into secrets need no encryption configuration.
      if (rows.length === 0) return { rows, payloads: [] }
      const cipher = await this.cipher(tx as SQL)
      const payloads = rows.map((r) => {
        validateSecretName(r.name)
        const payload = cipher.decrypt(context(repo, r.name, r.kind), r.payload) as SecretPayload
        this.validatePayload(r.kind, payload)
        return payload
      })
      return { rows, payloads }
    })
  }
  async resolveForTick(
    raw: string,
    _minimumValidUntil: number,
    deadline: number,
  ): Promise<SecretSnapshot> {
    const repo = await this.registered(raw)
    // Provider refresh windows determine eligibility; a future validity horizon
    // must never reject a credential that is valid now but cannot yet rotate.
    const refreshed = new Set<string>()
    while (this.now() < deadline) {
      const { rows, payloads } = await this.read(repo)
      // Reject an unusable complete set before consuming any provider's state.
      if (rows.some((row) => row.status === 'failed'))
        throw new ProjectSecretError('secret-unavailable')
      const expired = rows.find(
        (row) =>
          row.status === 'refreshing' && new Date(row.attempt_deadline).getTime() <= this.now(),
      )
      if (expired) {
        await this.fail(expired, 'refresh-expired')
        throw new ProjectSecretError('secret-unavailable')
      }
      if (payloads.some((payload) => 'expiresAt' in payload && payload.expiresAt <= this.now()))
        throw new ProjectSecretError('secret-unavailable')
      let retry = false
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!,
          p = payloads[i]!
        if (r.status === 'failed') throw new ProjectSecretError('secret-unavailable')
        if (r.status === 'refreshing') {
          if (new Date(r.attempt_deadline).getTime() <= this.now()) {
            await this.fail(r, 'refresh-expired')
            throw new ProjectSecretError('secret-unavailable')
          }
          retry = true
          continue
        }
        if (r.kind === 'static' || refreshed.has(JSON.stringify([r.name, r.generation]))) continue
        if ('expiresAt' in p && p.expiresAt <= this.now())
          throw new ProjectSecretError('secret-unavailable')
        if ('expiresAt' in p && (p.earliestRefreshAt ?? p.expiresAt - 300_000) > this.now())
          continue
        if (!('state' in p) || (p.earliestRefreshAt ?? 0) > this.now())
          throw new ProjectSecretError('secret-unavailable')
        const attempt = randomUUID(),
          until = Math.min(deadline, this.now() + 60_000)
        // An uncertain claim commit is never followed by HTTP: propagate safely.
        const claimed: Row[] = await this.sql.begin(async (tx) => {
          await this.lock(tx as SQL, repo)
          return tx`UPDATE project_secrets SET status='refreshing',revision=revision+1,attempt_id=${attempt},attempt_deadline=${new Date(until).toISOString()}
          WHERE repo=${repo} AND name=${r.name} AND generation=${r.generation} AND revision=${r.revision} AND status='ready' RETURNING *`
        })
        if (claimed.length) {
          const claim = claimed[0]!
          try {
            if (this.now() >= until) throw new ProjectSecretError('secret-unavailable')
            const controller = new AbortController()
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  controller.abort()
                  reject(new ProjectSecretError('secret-unavailable'))
                },
                Math.max(1, until - this.now()),
              )
            })
            const result = await Promise.race([
              this.kinds.get(r.kind)!.refresh(p.state, controller.signal),
              timeout,
            ]).finally(() => clearTimeout(timer))
            this.validatePayload(r.kind, result)
            if (result.expiresAt <= this.now() || this.now() >= until)
              throw new ProjectSecretError('secret-unavailable')
            // Commit rotated material before returning to resolution. Never repeat HTTP.
            await this.sql.begin(async (tx) => {
              await this.lock(tx as SQL, repo)
              const cipher = await this.cipher(tx as SQL)
              await tx`UPDATE project_secrets SET payload=${cipher.encrypt(context(repo, r.name, r.kind), result)},status='ready',revision=revision+1,attempt_id=NULL,attempt_deadline=NULL,failure_code=NULL
                WHERE repo=${repo} AND name=${r.name} AND generation=${claim.generation} AND revision=${claim.revision} AND status='refreshing' AND attempt_id=${attempt} AND attempt_deadline>${new Date(this.now()).toISOString()}`
            })
            refreshed.add(JSON.stringify([r.name, r.generation]))
          } catch {
            // A completion may have committed despite a lost acknowledgement.
            // Reread durable state before classifying failure; never repeat HTTP.
            const [durable] = await this
              .sql`SELECT generation,revision,status FROM project_secrets WHERE repo=${repo} AND name=${r.name}`
            if (
              !durable ||
              durable.generation !== claim.generation ||
              (durable.status === 'ready' && BigInt(durable.revision) > BigInt(claim.revision))
            ) {
              refreshed.add(JSON.stringify([r.name, r.generation]))
              retry = true
              continue
            }
            await this.fail(claim, 'refresh-failed')
            throw new ProjectSecretError('secret-unavailable')
          }
        }
        retry = true
      }
      if (retry) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        continue
      }
      const snapshot: SecretSnapshot = {
        repo,
        minimumValidUntil: this.now(),
        env: {},
        versions: rows.map((r) => ({
          name: r.name,
          generation: r.generation,
          revision: String(r.revision),
        })),
      }
      rows.forEach((r, i) => {
        const p = payloads[i]!
        snapshot.env[r.name] = 'value' in p ? p.value : p.accessToken
      })
      if (await this.current(snapshot, false)) return snapshot
    }
    throw new ProjectSecretError('secret-unavailable')
  }
  private async fail(r: Row, code: string) {
    await this.sql.begin(async (tx) => {
      await this.lock(tx as SQL, r.repo)
      await tx`UPDATE project_secrets SET status='failed',failure_code=${code},revision=revision+1
        WHERE repo=${r.repo} AND name=${r.name} AND generation=${r.generation} AND revision=${r.revision} AND status='refreshing' AND attempt_id=${r.attempt_id}`
    })
  }

  private async current(snapshot: SecretSnapshot, supplied: boolean): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await this.lock(tx as SQL, snapshot.repo)
      const rows: Row[] =
        await tx`SELECT * FROM project_secrets WHERE repo=${snapshot.repo} ORDER BY name`
      if (
        rows.some((r) => r.status !== 'ready') ||
        JSON.stringify(
          rows.map((r) => ({
            name: r.name,
            generation: r.generation,
            revision: String(r.revision),
          })),
        ) !== JSON.stringify(snapshot.versions)
      )
        return false
      // The complete version set still matches, so an empty handoff is safe without a key.
      if (rows.length === 0) return true
      const cipher = await this.cipher(tx as SQL)
      for (const row of rows) {
        validateSecretName(row.name)
        const payload = cipher.decrypt(
          context(snapshot.repo, row.name, row.kind),
          row.payload,
        ) as SecretPayload
        this.validatePayload(row.kind, payload)
        if (
          'expiresAt' in payload &&
          payload.expiresAt <= Math.max(snapshot.minimumValidUntil ?? 0, this.now())
        )
          return false
      }
      if (supplied)
        await tx`UPDATE project_secrets SET last_supplied_at=${new Date(this.now()).toISOString()} WHERE repo=${snapshot.repo}`
      return true
    })
  }
  async markSupplied(snapshot: SecretSnapshot): Promise<void> {
    if (!(await this.current(snapshot, true))) throw new ProjectSecretError('stale-secrets')
  }
  async close(): Promise<void> {
    if (this.ownsPool) await this.sql.close()
  }
}
export async function openPostgresProjectSecretsFromEnv(
  env: PostgresEnv,
): Promise<PostgresProjectSecrets> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    const projects = new PostgresProjectRegistry(sql)
    await projects.initializeFromEnv(env)
    return new PostgresProjectSecrets(
      sql,
      projects,
      () => env.AB_PROJECT_SECRETS_KEY,
      new Map([
        [
          'chatgpt-subscription',
          {
            validateState: (state: unknown) => chatgptStateSchema.safeParse(state).success,
            refresh: async (raw: unknown, signal: AbortSignal) => {
              const state = await refreshChatGPT(chatgptStateSchema.parse(raw), signal)
              return {
                accessToken: state.accessToken,
                expiresAt: state.expiresAt,
                ...(state.earliestRefreshAt === undefined
                  ? {}
                  : { earliestRefreshAt: state.earliestRefreshAt }),
                state,
              }
            },
          },
        ],
      ]),
      Date.now,
      true,
    )
  } catch (error) {
    await sql.close()
    throw error
  }
}

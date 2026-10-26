/** Test-owned failure boundaries and two-connection answer races. Production
 * has no fault injection: SQL triggers and the held S3 proxy exist only in an
 * isolated database/service owned by this proof. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import type { SQL } from 'bun'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import type { BuildStore, NewBuildInput } from '../../../packages/core/src/store/types'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { sources } from './fixture-core'
import { operatorClock } from './operator-fixtures'
import type { OperatorOperationWitness } from './operator-coverage-types'
const clock = () => new Date(operatorClock)
const secret = 'offline-operator-fixture-secret'
const spec = '## Acceptance criteria\n- Race-safe replacement\n## Out of scope\nOther work\n'
interface NativeServer {
  address: string
  close(): Promise<void>
}
export interface AnswerFailureOptions {
  sql: SQL
  store: BuildStore
  address: string
  upstreamS3Endpoint: string
  witnesses?: OperatorOperationWitness[]
  spawnServer(overrides: Record<string, string>): Promise<NativeServer>
}
type Case =
  | 'cancelled-verifier'
  | 'second-answer-prefix'
  | 'spec-publication-prefix'
  | 'upload-failure'
  | 'terminal-during-upload'
  | 'node-writer-fence'
  | 'node-runner-fence'
  | 'node-tail-moved-during-upload'
function request(repo: string, slug: string, body: unknown, address: string) {
  const token = mintToken(secret, {
    version: 1,
    internalOperator: { repo, user: 'operator@example.com' },
    exp: clock().getTime() + 60000,
  })
  return new Request(
    `${address}/operator/v1/repos/${encodeURIComponent(repo)}/builds/${slug}/answer`,
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
  )
}
async function seed(
  store: BuildStore,
  repo: string,
  slug: string,
  node = false,
  cancelled = false,
) {
  const input: NewBuildInput = {
    slug,
    repo,
    ticket: { source: 'file', id: 'FILE' },
    created: {
      actor: { kind: 'dispatcher' },
      type: 'build.created',
      payload: {
        ticket: { source: 'file', id: 'FILE' },
        repo,
        baseBranch: 'main',
        ...(node ? { kind: 'node' as const } : {}),
      },
    },
  }
  await store.createBuild(input)
  if (node) {
    await store.append(slug, {
      actor: { kind: 'dispatcher' },
      type: 'node.opened',
      payload: { sha: 'head' },
    })
    await store.append(slug, {
      actor: { kind: 'dispatcher' },
      type: 'node.compared',
      payload: { headSha: 'head', parentSha: 'base', ahead: 1 },
    })
    return input
  }
  await store.append(slug, {
    actor: { kind: 'kernel' },
    type: 'runner.attached',
    payload: { instance: 'test', host: 'test', resumedFromSeq: 0 },
  })
  if (cancelled) {
    await store.append(slug, {
      actor: { kind: 'kernel' },
      type: 'verify.started',
      payload: { step: 'unit', attempt: 1 },
    })
    await store.append(slug, {
      actor: { kind: 'kernel' },
      type: 'session.started',
      payload: {
        session: 'cancelled-verifier',
        role: 'verify:unit',
        runner: 'test',
        phase: 'verify:unit',
        round: 1,
      },
    })
    await store.append(slug, {
      actor: { kind: 'agent', role: 'verify:unit', session: 'cancelled-verifier' },
      type: 'escalation.raised',
      payload: {
        id: 'esc-cancelled',
        phase: 'verify:unit',
        round: 1,
        source: 'agent',
        question: 'Stale question',
      },
    })
    await store.append(slug, {
      actor: { kind: 'kernel' },
      type: 'verify.cancelled',
      payload: { step: 'unit', attempt: 1, cause: { step: 'types' } },
    })
    return input
  }
  for (const id of ['esc-first', 'esc-second'])
    await store.append(slug, {
      actor: { kind: 'agent', role: 'implement', session: 'phase' },
      type: 'escalation.raised',
      payload: { id, phase: 'implement', round: 1, source: 'agent', question: `Question ${id}` },
    })
  return input
}
async function snapshot(store: BuildStore, slug: string) {
  const events = await store.getEvents(slug)
  events.forEach(validateEventWrite)
  return {
    record: await store.getBuild(slug),
    events,
    state: encodeReducerValue(reduceBuild(events)),
    artifacts: await Promise.all(
      (await store.listArtifacts(slug)).map(async (meta) => {
        const artifact = await store.getArtifact(slug, meta.kind, meta.revision)
        assert.ok(artifact, 'metadata authorizes only readable complete uploads')
        assert.equal(createHash('sha256').update(artifact.content).digest('hex'), meta.blobRef)
        return { meta, base64: Buffer.from(artifact.content).toString('base64') }
      }),
    ),
  }
}
async function oracle(kind: Case, repo: string, slug: string) {
  const store = new MemoryBuildStore({ clock })
  await seed(store, repo, slug, kind.startsWith('node-'), kind === 'cancelled-verifier')
  if (kind === 'node-writer-fence')
    await store.claimNodeWriter(slug, 'competing-node-writer', 60000)
  if (kind === 'node-runner-fence') await store.claimLease(slug, 'competing-runner', 60000)
  const originalAppend = store.append.bind(store),
    originalConditional = store.appendIfCurrent.bind(store),
    originalPut = store.putArtifact.bind(store)
  if (kind === 'second-answer-prefix' || kind === 'spec-publication-prefix') {
    const check = (write: { type: string; payload: unknown }) => {
      if (
        (kind === 'second-answer-prefix' &&
          write.type === 'escalation.answered' &&
          (write.payload as { id?: string }).id === 'esc-second') ||
        (kind === 'spec-publication-prefix' && write.type === 'spec.revised')
      )
        throw new Error('injected publication failure')
    }
    store.append = (async (target, write) => {
      check(write)
      return originalAppend(target, write)
    }) as typeof store.append
    store.appendIfCurrent = (async (target, expectedSeq, write) => {
      check(write)
      return originalConditional(target, expectedSeq, write)
    }) as typeof store.appendIfCurrent
  }
  if (kind === 'upload-failure')
    store.putArtifact = async () => {
      throw new Error('injected provider failure')
    }
  if (kind === 'terminal-during-upload' || kind === 'node-tail-moved-during-upload')
    store.putArtifact = async (target, input) => {
      await originalAppend(target, raceWrite(kind))
      return originalPut(target, input)
    }
  const api = createOperatorServer({ store, projects: testProjects([repo]), secret, clock })
  const body =
    kind === 'second-answer-prefix' || kind === 'cancelled-verifier'
      ? { resolution: 'guidance', text: 'Continue the selected work' }
      : { resolution: 'revise-spec', origin: 'body', body: spec }
  const response = await api.fetch(request(repo, slug, body, 'http://oracle.invalid'))
  const first = {
    status: response.status,
    body: (await response.json()) as unknown,
    after: await snapshot(store, slug),
  }
  if (kind === 'second-answer-prefix' || kind === 'spec-publication-prefix')
    assert.equal(first.status, 500, `${kind}: publication fault must be exercised`)
  if (kind === 'cancelled-verifier') assert.equal(first.status, 409)
  store.append = originalAppend
  store.appendIfCurrent = originalConditional
  store.putArtifact = originalPut
  let retry: typeof first | undefined
  const retryBody =
    kind === 'second-answer-prefix'
      ? body
      : {
          resolution: 'revise-spec',
          origin: 'body',
          body: 'Intentionally nonconforming: prior authorization wins lazily',
        }
  if (kind === 'second-answer-prefix' || kind === 'spec-publication-prefix') {
    const response = await api.fetch(request(repo, slug, retryBody, 'http://oracle.invalid'))
    retry = {
      status: response.status,
      body: (await response.json()) as unknown,
      after: await snapshot(store, slug),
    }
  }
  return { body, first, retryBody, retry }
}
function raceWrite(kind: Case) {
  return validateEventWrite(
    kind === 'node-tail-moved-during-upload'
      ? {
          actor: { kind: 'agent', role: 'implement', session: 'concurrent' },
          type: 'observation.recorded',
          payload: {
            id: 'obs-race',
            kind: 'followup',
            summary: 'An unrelated durable fact moved the node tail',
          },
        }
      : { actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} },
  )
}
async function deadline<T>(work: Promise<T>, label: string, milliseconds = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export const answerFailureCaseIds: Case[] = [
  'cancelled-verifier',
  'second-answer-prefix',
  'spec-publication-prefix',
  'upload-failure',
  'terminal-during-upload',
  'node-writer-fence',
  'node-runner-fence',
  'node-tail-moved-during-upload',
]
export async function replayAnswerFailures(options: AnswerFailureOptions) {
  for (const kind of answerFailureCaseIds) {
    const repo = `answer-failure/${kind}`,
      slug = `answer-failure-${kind}`
    const expected = await oracle(kind, repo, slug)
    await options.sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    await seed(options.store, repo, slug, kind.startsWith('node-'), kind === 'cancelled-verifier')
    if (kind === 'node-writer-fence')
      await options.store.claimNodeWriter(slug, 'competing-node-writer', 60000)
    if (kind === 'node-runner-fence')
      await options.store.claimLease(slug, 'competing-runner', 60000)
    let server: NativeServer | undefined
    let proxy: ReturnType<typeof Bun.serve> | undefined
    let releaseUpload: (() => void) | undefined
    let arrived: Promise<void> | undefined
    let trigger: string | undefined
    let address = options.address
    try {
      if (kind === 'second-answer-prefix' || kind === 'spec-publication-prefix') {
        // Identifiers/values are constants from the closed Case union; no
        // credentials or external input are interpolated into test SQL.
        trigger = `proa_answer_failure_${kind.replaceAll('-', '_')}`
        const predicate =
          kind === 'second-answer-prefix'
            ? "NEW.type='escalation.answered' AND NEW.payload->>'id'='esc-second'"
            : "NEW.type='spec.revised'"
        await options.sql.unsafe(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.build='${slug}' AND (${predicate}) THEN RAISE EXCEPTION 'test-owned publication failure'; END IF; RETURN NEW; END $$`,
        )
        await options.sql.unsafe(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        )
      }
      if (kind === 'upload-failure') {
        server = await options.spawnServer({ AB_S3_BUCKET: 'proa-deliberately-missing-bucket' })
        address = server.address
      }
      if (kind === 'terminal-during-upload' || kind === 'node-tail-moved-during-upload') {
        let signal!: () => void
        arrived = new Promise<void>((resolve) => {
          signal = resolve
        })
        const held = new Promise<void>((resolve) => {
          releaseUpload = resolve
        })
        let armed = true
        proxy = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: async (incoming) => {
            if (incoming.method === 'PUT' && armed) {
              armed = false
              signal()
              await held
            }
            const target = new URL(incoming.url)
            const upstream = new URL(options.upstreamS3Endpoint)
            target.protocol = upstream.protocol
            target.host = upstream.host
            // Preserve the original signed Host header and raw AWS SDK body.
            // The real S3 service continues checking the request's signature.
            return fetch(target, {
              method: incoming.method,
              headers: incoming.headers,
              body:
                incoming.method === 'GET' || incoming.method === 'HEAD'
                  ? undefined
                  : await incoming.arrayBuffer(),
              redirect: 'manual',
            })
          },
        })
        server = await options.spawnServer({ AB_S3_ENDPOINT: `http://127.0.0.1:${proxy.port}` })
        address = server.address
      }
      const pending = fetch(request(repo, slug, expected.body, address))
      if (kind === 'terminal-during-upload' || kind === 'node-tail-moved-during-upload') {
        await deadline(arrived!, 'native upload did not reach the test-owned proxy')
        // A separate TypeScript store connection commits a real terminal fact
        // while the native HTTP request is waiting on provider I/O.
        await options.store.append(slug, raceWrite(kind))
        releaseUpload!()
      }
      const response = await deadline(pending, `${kind}: native answer request timed out`, 30000)
      assert.equal(response.status, expected.first.status, `${kind}: status`)
      const responseBody: unknown = await response.json()
      assert.deepEqual(responseBody, expected.first.body, `${kind}: refusal`)
      options.witnesses?.push({
        suite: 'answer-failures',
        id: kind,
        method: 'POST',
        path: `builds/${slug}/answer`,
        requestBody: expected.body,
        status: response.status,
        responseBody,
      })
      assert.deepEqual(
        await snapshot(options.store, slug),
        expected.first.after,
        `${kind}: surviving prefix and immutable artifact bytes`,
      )
      if (trigger) {
        await options.sql.unsafe(`DROP TRIGGER ${trigger} ON events`)
        await options.sql.unsafe(`DROP FUNCTION ${trigger}()`)
        trigger = undefined
      }
      if (expected.retry) {
        const response = await deadline(
          fetch(request(repo, slug, expected.retryBody, address)),
          `${kind}: retry timed out`,
        )
        assert.equal(response.status, expected.retry.status, `${kind}: retry status`)
        assert.deepEqual(await response.json(), expected.retry.body, `${kind}: retry receipt`)
        assert.deepEqual(
          await snapshot(options.store, slug),
          expected.retry.after,
          `${kind}: retry must not repeat recorded answers or deposit another spec`,
        )
      }
    } finally {
      releaseUpload?.()
      await server?.close()
      proxy?.stop(true)
      if (trigger) {
        await options.sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON events`)
        await options.sql.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`)
      }
    }
  }
  return {
    cases: answerFailureCaseIds,
    sourceClosureSha256: createHash('sha256').update(JSON.stringify(sources())).digest('hex'),
  }
}

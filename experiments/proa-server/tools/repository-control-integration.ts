/** Real TypeScript/PostgreSQL versus Rust HTTP proof for restack, concrete
 * harvest controls and bulk's surviving failure prefixes. Test triggers live
 * only in this disposable database; ordinary control handlers are unchanged. */
import { strict as assert } from 'node:assert'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { readRepositoryFacts } from '../../../packages/core/src/store/reduced-reads'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { operatorClock } from './operator-fixtures'
import type { OperatorOperationWitness } from './operator-coverage-types'
const clock = () => new Date(operatorClock)
const secret = 'offline-operator-fixture-secret'
type Case =
  | 'restack-new'
  | 'restack-coalesced'
  | 'restack-paused'
  | 'restack-blocked'
  | 'harvest-resume'
  | 'harvest-acknowledge'
  | 'harvest-exhausted'
  | 'harvest-paused'
  | 'harvest-pending'
  | 'harvest-unavailable'
  | 'bulk-hold-failure'
  | 'bulk-intake-failure'
  | 'bulk-build-failure'
export const repositoryControlCaseIds: Case[] = [
  'restack-new',
  'restack-coalesced',
  'restack-paused',
  'restack-blocked',
  'harvest-resume',
  'harvest-acknowledge',
  'harvest-exhausted',
  'harvest-paused',
  'harvest-pending',
  'harvest-unavailable',
  'bulk-hold-failure',
  'bulk-intake-failure',
  'bulk-build-failure',
]
function normalize(value: unknown, repo: string, prefix: string, id?: string): unknown {
  const replace = (text: string) => {
    let result = text.replaceAll(repo, '$repo').replaceAll(prefix, '$build')
    if (id) result = result.replaceAll(id, '$restack-request')
    return result
  }
  if (typeof value === 'string') return replace(value)
  if (Array.isArray(value)) return value.map((item) => normalize(item, repo, prefix, id))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [replace(key), normalize(item, repo, prefix, id)]),
    )
  return value
}
function request(repo: string, path: string, body: unknown, address: string) {
  const token = mintToken(secret, {
    version: 1,
    internalOperator: { repo, user: 'operator@example.com' },
    exp: clock().getTime() + 60000,
  })
  return new Request(`${address}/operator/v1/repos/${encodeURIComponent(repo)}/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-autobuild-version': AUTOBUILD_VERSION,
      'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function seed(store: BuildStore, repo: string, prefix: string, kind: Case) {
  await store.ensureRepo(repo)
  const slugs: string[] = []
  if (!kind.startsWith('harvest-')) {
    for (const suffix of kind.startsWith('bulk-') ? ['a', 'b', 'c'] : ['node']) {
      const slug = `${prefix}-${suffix}`
      slugs.push(slug)
      await store.createBuild({
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
            ...(kind.startsWith('restack-') ? { kind: 'node' as const } : {}),
          },
        },
      })
      if (kind.startsWith('restack-')) {
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
        if (kind === 'restack-coalesced')
          await store.append(slug, {
            actor: { kind: 'human', user: 'earlier' },
            type: 'node.restack-requested',
            payload: {
              id: 'existing-restack-request',
              reason: 'operator',
              branch: 'main',
              parent: 'base',
            },
          })
        if (kind === 'restack-paused')
          await store.append(slug, { actor: { kind: 'kernel' }, type: 'build.paused', payload: {} })
        if (kind === 'restack-blocked')
          await store.append(slug, {
            actor: { kind: 'agent', role: 'implement', session: 'phase' },
            type: 'escalation.raised',
            payload: {
              id: 'esc-node',
              phase: 'implement',
              round: 1,
              source: 'agent',
              question: 'Parked node',
            },
          })
      } else
        await store.append(slug, {
          actor: { kind: 'kernel' },
          type: 'runner.attached',
          payload: { instance: 'runner', host: 'host', resumedFromSeq: 0 },
        })
    }
  } else {
    await store.appendRepo(repo, {
      actor: { kind: 'kernel' },
      type: 'harvest.started',
      payload: {
        run: 'run-target',
        observations: [{ build: 'observed-build', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    if (kind === 'harvest-acknowledge')
      await store.appendRepo(repo, {
        actor: { kind: 'kernel' },
        type: 'harvest.escalated',
        payload: {
          run: 'run-target',
          source: 'agent',
          reason: 'Human attention requested',
          observations: [{ build: 'observed-build', seq: 1 }],
        },
      })
    else if (kind !== 'harvest-unavailable')
      await store.appendRepo(repo, {
        actor: { kind: 'kernel' },
        type: 'harvest.failed',
        payload: {
          run: 'run-target',
          step: 'scan',
          attempt: 1,
          error: 'Provider unavailable',
          willRetry: false,
        },
      })
    if (kind === 'harvest-exhausted') {
      for (const attempt of [1, 2]) {
        await store.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.recovery-requested',
          payload: { run: 'run-target', attempt, limit: 2 },
        })
        await store.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.resumed',
          payload: {},
        })
        await store.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.failed',
          payload: {
            run: 'run-target',
            step: 'scan',
            attempt: attempt + 1,
            error: 'Provider unavailable',
            willRetry: false,
          },
        })
      }
    }
    if (kind === 'harvest-exhausted')
      await store.appendRepo(repo, {
        actor: { kind: 'kernel' },
        type: 'harvest.recovery-exhausted',
        payload: {
          run: 'run-target',
          step: 'scan',
          error: 'Provider unavailable',
          attempts: 2,
          limit: 2,
          releasedObservations: [{ build: 'observed-build', seq: 1 }],
          committedDispositions: [],
          pendingProposals: [],
        },
      })
    if (kind === 'harvest-paused')
      await store.appendRepo(repo, {
        actor: { kind: 'kernel' },
        type: 'harvest.paused',
        payload: {},
      })
    if (kind === 'harvest-pending')
      await store.appendRepo(repo, {
        actor: { kind: 'human', user: 'earlier' },
        type: 'harvest.resume-requested',
        payload: {},
      })
  }
  return slugs
}
async function snapshot(store: BuildStore, repo: string, slugs: string[]) {
  const repository = await store.getRepoEvents(repo)
  repository.forEach(validateRepositoryEventWrite)
  return {
    repository,
    facts: encodeReducerValue((await readRepositoryFacts(store, repo)).value),
    builds: await Promise.all(
      slugs.map(async (slug) => {
        const events = await store.getEvents(slug)
        events.forEach(validateEventWrite)
        return {
          record: await store.getBuild(slug),
          events,
          state: encodeReducerValue(reduceBuild(events)),
        }
      }),
    ),
  }
}
export async function replayRepositoryControls(options: {
  sql: SQL
  store: BuildStore
  address: string
  witnesses?: OperatorOperationWitness[]
}) {
  const checked: string[] = []
  for (const kind of repositoryControlCaseIds) {
    const nativeRepo = `repository-control/native/${kind}`,
      oracleRepo = `repository-control/oracle/${kind}`
    const nativePrefix = `native-${kind}`,
      oraclePrefix = `oracle-${kind}`
    for (const repo of [nativeRepo, oracleRepo])
      await options.sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    const nativeSlugs = await seed(options.store, nativeRepo, nativePrefix, kind),
      oracleSlugs = await seed(options.store, oracleRepo, oraclePrefix, kind)
    const oracle = createOperatorServer({
      store: options.store,
      projects: testProjects([oracleRepo]),
      secret,
      clock,
    })
    const path = (prefix: string) =>
      kind.startsWith('restack-')
        ? `builds/${prefix}-node/restack`
        : kind.startsWith('harvest-')
          ? 'harvest/control'
          : 'bulk-control'
    const body = kind.startsWith('restack-')
      ? undefined
      : kind.startsWith('harvest-')
        ? { action: 'run', run: 'run-target' }
        : { action: 'pause' }
    let trigger: string | undefined, table: string | undefined
    try {
      if (kind.startsWith('bulk-')) {
        trigger = `proa_bulk_failure_${kind.replaceAll('-', '_')}`
        table = kind === 'bulk-build-failure' ? 'events' : 'repo_events'
        const predicate =
          table === 'events'
            ? `NEW.build IN('${nativePrefix}-b','${oraclePrefix}-b') AND NEW.type='build.pause-requested'`
            : `NEW.repo IN('${nativeRepo}','${oracleRepo}') AND NEW.type='${kind === 'bulk-hold-failure' ? 'dispatcher.pause-set' : 'dispatcher.intake-set'}'`
        await options.sql.unsafe(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RAISE EXCEPTION 'test-owned bulk storage failure'; END IF; RETURN NEW; END $$`,
        )
        await options.sql.unsafe(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        )
      }
      const compare = async (label: string) => {
        const expected = await oracle.fetch(
          request(oracleRepo, path(oraclePrefix), body, 'http://oracle.invalid'),
        )
        const actual = await fetch(request(nativeRepo, path(nativePrefix), body, options.address))
        const expectedBody = (await expected.json()) as {
          request?: { id: string }
          coalesced?: boolean
        }
        const actualBody = (await actual.json()) as {
          request?: { id: string }
          coalesced?: boolean
        }
        const expectedId =
          kind.startsWith('restack-') && kind !== 'restack-coalesced'
            ? expectedBody.request?.id
            : undefined
        const actualId =
          kind.startsWith('restack-') && kind !== 'restack-coalesced'
            ? actualBody.request?.id
            : undefined
        assert.equal(
          actual.status,
          expected.status,
          `${kind}/${label}: ${JSON.stringify(actualBody)}`,
        )
        assert.deepEqual(
          normalize(actualBody, nativeRepo, nativePrefix, actualId),
          normalize(expectedBody, oracleRepo, oraclePrefix, expectedId),
          `${kind}/${label}: HTTP result/progress`,
        )
        assert.deepEqual(
          normalize(
            await snapshot(options.store, nativeRepo, nativeSlugs),
            nativeRepo,
            nativePrefix,
            actualId,
          ),
          normalize(
            await snapshot(options.store, oracleRepo, oracleSlugs),
            oracleRepo,
            oraclePrefix,
            expectedId,
          ),
          `${kind}/${label}: exact ordered durable facts/reduced state`,
        )
        if (label === 'first')
          options.witnesses?.push({
            suite: 'repository-controls',
            id: kind,
            method: 'POST',
            path: path(nativePrefix),
            requestBody: body,
            status: actual.status,
            responseBody: actualBody,
          })
      }
      await compare('first')
      if (trigger) {
        await options.sql.unsafe(`DROP TRIGGER ${trigger} ON ${table}`)
        await options.sql.unsafe(`DROP FUNCTION ${trigger}()`)
        trigger = undefined
        await compare('retry')
      } else if (kind.startsWith('restack-')) await compare('coalesced-retry')
      checked.push(kind)
    } finally {
      if (trigger) {
        await options.sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`)
        await options.sql.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`)
      }
    }
  }
  return checked
}

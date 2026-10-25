/** Differential native HTTP control replay against an isolated test database. */
import { strict as assert } from 'node:assert'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite, type EventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { checkControlCorpus } from './control-fixtures'
import { operatorClock, operatorRepo } from './operator-fixtures'

function bind(value: unknown, repo: string, slug: string): unknown {
  if (typeof value === 'string')
    return value.replaceAll(operatorRepo, repo).replaceAll('control-build', slug)
  if (Array.isArray(value)) return value.map((item) => bind(item, repo, slug))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bind(item, repo, slug)]),
    )
  return value
}
export async function replayNativeControls(options: {
  sql: SQL
  store: BuildStore
  address: string
}) {
  const corpus = await checkControlCorpus()
  const checked: string[] = []
  for (const original of corpus.fixtures) {
    const repo = `control-fixture/${original.scenario.id}`
    const slug = `control-fixture-${original.scenario.id}`
    const fixture = bind(original, repo, slug) as typeof original
    await options.sql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    const first = fixture.seed.events[0]!
    assert.equal(first.type, 'build.created')
    await options.store.createBuild({
      slug,
      repo,
      created: validateEventWrite(first) as EventWrite<'build.created'>,
    })
    for (const event of fixture.seed.events.slice(1))
      await options.store.append(slug, validateEventWrite(event))
    await options.store.ensureRepo(repo)
    for (const event of fixture.seed.repository)
      await options.store.appendRepo(repo, validateRepositoryEventWrite(event))
    const token = mintToken('offline-operator-fixture-secret', {
      version: 1,
      internalOperator: { user: 'operator@example.com', repo },
      exp: new Date(operatorClock).getTime() + 60_000,
    })
    const response = await fetch(
      `${options.address}/operator/v1/repos/${encodeURIComponent(repo)}/${fixture.scenario.path}`,
      {
        method: fixture.scenario.method ?? 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        ...(fixture.scenario.rawBody !== undefined
          ? { body: fixture.scenario.rawBody }
          : fixture.scenario.body === undefined
            ? {}
            : { body: JSON.stringify(fixture.scenario.body) }),
      },
    )
    const body: unknown = await response.json()
    assert.equal(
      response.status,
      fixture.status,
      `${fixture.scenario.id}: status; ${JSON.stringify(body)}`,
    )
    assert.deepEqual(body, fixture.body, `${fixture.scenario.id}: result/refusal`)
    const events = await options.store.getEvents(slug)
    events.forEach(validateEventWrite)
    assert.deepEqual(
      events,
      fixture.after.events,
      `${fixture.scenario.id}: ordered durable build facts`,
    )
    const repoEvents = await options.store.getRepoEvents(repo)
    repoEvents.forEach(validateRepositoryEventWrite)
    assert.deepEqual(
      repoEvents,
      fixture.after.repository,
      `${fixture.scenario.id}: ordered repository facts`,
    )
    assert.deepEqual(
      encodeReducerValue(reduceBuild(events)),
      fixture.after.state,
      `${fixture.scenario.id}: TypeScript-reduced native writes`,
    )
    checked.push(fixture.scenario.id)
  }
  return checked
}

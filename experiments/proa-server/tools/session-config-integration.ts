/** Session configuration inheritance uses the configured TypeScript service as
 * oracle. No turn/model runner is started; creation writes session facts only. */
import type { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { configSchema } from '../../../packages/core/src/config/schema'
import { effectiveBuildConfigContent } from '../../../packages/core/src/processes/build-execution-state'
import { reduceSession } from '../../../packages/core/src/store/session-reducer'
import { validateSessionEventWrite } from '../../../packages/core/src/events/sessions'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { bindOperatorIds, operatorClock } from './operator-fixtures'

export const sessionConfigCases = [
  'absent',
  'disabled',
  'enabled-default',
  'enabled-empty',
  'enabled-custom',
  'invalid-json',
  'invalid-config',
] as const
export async function replaySessionConfiguration(options: {
  sql: SQL
  store: BuildStore
  address: string
}) {
  const clock = () => new Date(operatorClock),
    secret = 'offline-operator-fixture-secret'
  const checked: string[] = []
  for (const id of sessionConfigCases) {
    const repo = `session-config/${id}`,
      oracle = new MemoryBuildStore({ clock })
    await options.sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    await oracle.ensureRepo(repo)
    await options.store.ensureRepo(repo)
    if (id !== 'absent') {
      const config = configSchema.parse({
        tickets: { source: 'hosted', teamKey: 'ENG', readyState: 'ready' },
        orchestrator: {
          enabled: id !== 'disabled',
          ...(id !== 'disabled' ? { model: 'fixture/model' } : {}),
          ...(id === 'enabled-empty'
            ? { wake: [] }
            : id === 'enabled-custom'
              ? { wake: ['escalation.raised', 'build.completed'] }
              : {}),
        },
      })
      const content =
        id === 'invalid-json'
          ? '{'
          : id === 'invalid-config'
            ? '{}'
            : effectiveBuildConfigContent(config)
      for (const store of [oracle, options.store])
        await store.putRepoArtifact(repo, { kind: 'dispatcher-effective-config', content })
    }
    const server = createOperatorServer({
      store: oracle,
      projects: testProjects([repo]),
      secret,
      clock,
      orchestrator: {
        scheduleBackground: () => {
          throw new Error('Session creation must not schedule a turn')
        },
        createRunner: async () => {
          throw new Error('Session creation must not start a turn runner')
        },
      },
    })
    const headers = {
      authorization: `Bearer ${mintToken(secret, { version: 1, internalOperator: { repo, user: 'operator@example.com' }, exp: clock().getTime() + 60000 })}`,
      'x-autobuild-version': AUTOBUILD_VERSION,
      'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
      'content-type': 'application/json',
    }
    const path = `/operator/v1/repos/${encodeURIComponent(repo)}/sessions`
    const init = { method: 'POST', headers, body: JSON.stringify({ title: 'Configured session' }) }
    const expected = await server.fetch(new Request(`http://oracle.invalid${path}`, init))
    const actual = await fetch(`${options.address}${path}`, init)
    assert.equal(actual.status, expected.status, `${id}: status`)
    const expectedBody = (await expected.json()) as { id?: string },
      actualBody = (await actual.json()) as { id?: string }
    assert.deepEqual(
      bindOperatorIds(actualBody, actualBody.id ? [actualBody.id] : []),
      bindOperatorIds(expectedBody, expectedBody.id ? [expectedBody.id] : []),
      `${id}: response`,
    )
    const nativeRecords = await options.store.listSessions(repo),
      oracleRecords = await oracle.listSessions(repo)
    assert.equal(nativeRecords.length, oracleRecords.length, `${id}: creation count`)
    if (actualBody.id && expectedBody.id) {
      const nativeEvents = await options.store.getSessionEvents(actualBody.id),
        events = await oracle.getSessionEvents(expectedBody.id)
      nativeEvents.forEach(validateSessionEventWrite)
      assert.deepEqual(
        bindOperatorIds(
          { record: nativeRecords[0], events: nativeEvents, state: reduceSession(nativeEvents) },
          [actualBody.id],
        ),
        bindOperatorIds({ record: oracleRecords[0], events, state: reduceSession(events) }, [
          expectedBody.id,
        ]),
        `${id}: exact durable owner/wake prefix`,
      )
    }
    checked.push(id)
  }
  return checked
}

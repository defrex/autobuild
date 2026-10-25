/** Real HTTP registry replay. Caller supplies an isolated database and fixed-clock server. */
import type { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { operatorClock, operatorRepo } from './operator-fixtures'
import { checkRegistryContract } from './registry-fixtures'

export async function replayNativeRegistry(options: {
  sql: SQL
  store: BuildStore
  address: string
  outcomeCases?: string[]
  schemaCases?: string[]
}) {
  const corpus = await checkRegistryContract()
  const repo = 'registry/fixture'
  await options.sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
  const token = mintToken('offline-operator-fixture-secret', {
    version: 1,
    internalOperator: { user: 'operator@example.com', repo },
    exp: new Date(operatorClock).getTime() + 60000,
  })
  const headers = {
    authorization: `Bearer ${token}`,
    'x-autobuild-version': AUTOBUILD_VERSION,
    'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
    'content-type': 'application/json',
  }
  const call = async (name: string, body: unknown) =>
    fetch(
      `${options.address}/operator/v1/repos/${encodeURIComponent(repo)}/tools/${encodeURIComponent(name)}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    )
  const checked: string[] = []
  for (const [index, entry] of corpus.outcomes.entries()) {
    const input = { ...entry.input, repo }
    const response = await call(entry.name, input)
    const body = await response.json()
    if ('error' in entry) {
      assert.ok(response.status >= 400, entry.name)
      assert.deepEqual(body, entry.error, entry.name)
    } else {
      assert.equal(response.status, 200, entry.name)
      assert.deepEqual(body, entry.result, entry.name)
    }
    checked.push(entry.name)
    options.outcomeCases?.push(`${entry.name}:${index}`)
  }
  for (const [index, entry] of corpus.cases.entries()) {
    if (
      !('error' in entry) ||
      !entry.input ||
      typeof entry.input !== 'object' ||
      !('repo' in entry.input) ||
      entry.input.repo !== operatorRepo
    )
      continue
    const response = await call(entry.name, { ...entry.input, repo })
    assert.equal(response.status, 400, entry.name)
    assert.deepEqual(await response.json(), { kind: 'validation', error: entry.error }, entry.name)
    options.schemaCases?.push(`${entry.name}:${index}`)
  }
  const notes = await options.store.getRepoArtifact(repo, 'operator-notes')
  assert.ok(notes)
  assert.equal(new TextDecoder().decode(notes.content), 'notes\nbytes')
  assert.deepEqual(notes.meta.metadata, { user: 'operator@example.com' })
  return checked
}

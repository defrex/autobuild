import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { schemas, type Scope } from './fixture-core'
import {
  corpusPath,
  encodeCorpus,
  generateWriteCorpus,
  readWriteCorpus,
} from './protocol-fixtures-core'

test('strict append corpus is reproducible from validator and HTTP oracles', async () => {
  expect(encodeCorpus(await generateWriteCorpus())).toEqual(readFileSync(corpusPath))
})

test('strict append corpus covers every catalog and retains rejection classes separately', () => {
  const corpus = readWriteCorpus()
  for (const scope of Object.keys(schemas) as Scope[]) {
    for (const type of Object.keys(schemas[scope])) {
      const cases = corpus.cases.filter((item) => item.scope === scope && item.input.type === type)
      expect(cases.some((item) => item.id.endsWith('/valid') && 'accepted' in item.oracle)).toBe(
        true,
      )
      expect(cases.some((item) => 'rejected' in item.oracle)).toBe(true)
      expect(cases.some((item) => item.http.status === 422)).toBe(true)
      expect(cases.some((item) => item.http.status === 400)).toBe(true)
      expect(corpus.actorRules[scope][type]!.length).toBeGreaterThan(0)
    }
  }
  const wake = corpus.cases.find((item) => item.id === 'session/turn.started/wake-both')!
  expect(wake.http.status).toBe(422)
  expect(wake.http.body).toEqual({
    kind: 'validation',
    error: 'rejected' in wake.oracle ? wake.oracle.rejected.message : '',
  })
  expect(corpus.requests.length).toBeGreaterThan(100)
})

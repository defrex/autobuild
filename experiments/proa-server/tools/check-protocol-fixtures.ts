import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import {
  sessionWriteSchemas,
  requestWriteSchemas,
  requestSchemas,
  catalogPayloadSchemas,
} from './protocol-fixtures-schema'
import {
  readWriteCorpus,
  rulesPath,
  oracle,
  httpOracle,
  protocolSources,
  sessionSchemasPath,
  requestSchemasPath,
  payloadSchemasPath,
} from './protocol-fixtures-core'
const corpus = readWriteCorpus()
if (!isDeepStrictEqual(corpus.sources, protocolSources()))
  throw new Error('Stale protocol oracle sources; regenerate protocol fixtures')
if (!isDeepStrictEqual(corpus.actorRules, JSON.parse(readFileSync(rulesPath, 'utf8'))))
  throw new Error('Protocol actor rules differ from corpus')
for (const item of corpus.cases) {
  if (!isDeepStrictEqual(item.oracle, oracle(item.scope, item.input)))
    throw new Error(`Stale validator oracle: ${item.id}`)
  if (!isDeepStrictEqual(item.http, await httpOracle(item.scope, item.input)))
    throw new Error(`Stale HTTP oracle: ${item.id}`)
}
console.log(`Protocol append freshness passed: ${corpus.cases.length} validator and HTTP outcomes`)
if (!isDeepStrictEqual(sessionWriteSchemas(), JSON.parse(readFileSync(sessionSchemasPath, 'utf8'))))
  throw new Error('Stale session schema interpreter input')

if (!isDeepStrictEqual(requestWriteSchemas(), JSON.parse(readFileSync(requestSchemasPath, 'utf8'))))
  throw new Error('Stale request schemas')
for (const item of corpus.requests) {
  const result = requestSchemas[item.name as keyof typeof requestSchemas].safeParse(item.input)
  const outcome = result.success
    ? { accepted: result.data }
    : { rejected: { name: result.error.name, message: result.error.message } }
  if (!isDeepStrictEqual(item.oracle, outcome)) throw new Error(`Stale request oracle ${item.id}`)
}
if (
  !isDeepStrictEqual(catalogPayloadSchemas(), JSON.parse(readFileSync(payloadSchemasPath, 'utf8')))
)
  throw new Error('Stale catalog payload schema coverage')

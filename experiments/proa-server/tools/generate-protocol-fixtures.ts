import { resolve } from 'node:path'
import { root } from './fixture-core'
import {
  sessionWriteSchemas,
  requestWriteSchemas,
  catalogPayloadSchemas,
} from './protocol-fixtures-schema'
import { writeFile } from 'node:fs/promises'
import {
  corpusPath,
  rulesPath,
  encodeCorpus,
  generateWriteCorpus,
  sessionSchemasPath,
  requestSchemasPath,
  payloadSchemasPath,
} from './protocol-fixtures-core'
async function writeJson(path: string, value: unknown) {
  const formatted = Bun.spawnSync(
    [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', path],
    { stdin: Buffer.from(JSON.stringify(value)), stdout: 'pipe', stderr: 'pipe' },
  )
  if (formatted.exitCode !== 0)
    throw new Error(`Fixture formatting failed: ${formatted.stderr.toString()}`)
  await writeFile(path, formatted.stdout)
}
const corpus = await generateWriteCorpus()
await writeFile(corpusPath, encodeCorpus(corpus))
await writeJson(rulesPath, corpus.actorRules)
console.log(
  `Generated ${corpus.cases.length} strict append cases with independent validator/HTTP outcomes`,
)
await writeJson(sessionSchemasPath, sessionWriteSchemas())
await writeJson(requestSchemasPath, requestWriteSchemas())
await writeJson(payloadSchemasPath, catalogPayloadSchemas())

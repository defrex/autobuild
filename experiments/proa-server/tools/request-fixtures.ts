/** Source-derived request validation contract. Never imported by runtime Rust. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import * as protocol from '../../../packages/core/src/operator/protocol'

const entries = Object.entries(protocol)
const path = resolve(import.meta.dir, '../fixtures/operator-requests.json')
export function requestContract() {
  const schemas = Object.fromEntries(
    entries
      .filter(([key, value]) => key.endsWith('RequestSchema') && value instanceof z.ZodType)
      .map(([key, value]) => [key, z.toJSONSchema(value as z.ZodType, { unrepresentable: 'any' })]),
  )
  const samples: unknown[] = [
    undefined,
    null,
    true,
    1,
    '',
    [],
    {},
    { action: 'unknown' },
    { action: 'pause', extra: 1 },
    { resolution: 'retry', text: 'forbidden' },
    { resolution: 'guidance', text: '  ' },
    { resolution: 'guidance', text: ' x ' },
    { resolution: 'review-round-ceiling', ceiling: 0 },
    { resolution: 'review-round-ceiling', ceiling: 1.5 },
    { resolution: 'review-round-ceiling', ceiling: 9007199254740992 },
    { resolution: 'review-round-ceiling', ceiling: -9007199254740992 },
    { target: 3 },
    { resolution: 'revise-spec', origin: 'body', body: '', ceiling: 1 },
    { enabled: false },
    { enabled: 1 },
    { action: 'run', run: '' },
    { text: '\uFEFF x \uFEFF' },
    { globs: Array(101).fill('x') },
    { expectedRevision: ' ' },
    { target: null },
    { title: '', body: '' },
    { blockerIds: [] },
    { turn: 't', toolCallId: 'c', decision: 'wrong' },
  ]
  const cases = Object.entries(schemas).flatMap(([name]) =>
    samples.map((input) => {
      const schema = entries.find(([key]) => key === name)![1] as z.ZodType
      const result = schema.safeParse(input)
      return {
        name,
        ...(input === undefined ? {} : { input }),
        ...(result.success
          ? { output: result.data }
          : { error: `invalid request body: ${result.error.message}` }),
      }
    }),
  )
  return {
    source: createHash('sha256')
      .update(
        readFileSync(resolve(import.meta.dir, '../../../packages/core/src/operator/protocol.ts')),
      )
      .digest('hex'),
    schemas,
    cases,
  }
}
export async function checkRequestContract() {
  if (!isDeepStrictEqual(await Bun.file(path).json(), requestContract()))
    throw new Error('Operator request schemas drifted; run tools/request-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(
      path,
      `${JSON.stringify(requestContract(), null, 2).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
  else await checkRequestContract()
}

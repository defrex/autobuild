import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  decodeBase64,
  substitutePlaceholderRefs,
} from '../../../packages/core/src/store/remote/protocol'
import { experiment, root } from './fixture-core'

export const artifactFixturePath = resolve(
  experiment,
  'fixtures/protocol-artifact-preparation.json',
)

export function artifactPreparationFixtures() {
  const samples = [
    '',
    'Zg==',
    'Zm8=',
    'Zm9v',
    'AAECAwQF',
    'AA==',
    '/w==',
    '////',
    'Zg',
    'Zg=',
    'Zg===',
    'Zg====',
    'Zh==',
    'Zm9=',
    'Zg==\n',
    ' Zg==',
    'Zg== ',
    'Zg==\r\n',
    'Zg-_',
    '-w==',
    '_w==',
    'A===',
    '====',
    'a',
    '\u0000',
    'éééé',
    '😀😀',
    'Z g=',
    'AA=A',
    'AAA=',
    'AAAA',
    'AAAA=',
  ]
  for (let byte = 0; byte < 256; byte++) samples.push(Buffer.from([byte]).toString('base64'))
  const decode = samples.map((contentBase64, index) => {
    const input = { kind: 'notes', contentBase64, ...(index % 2 ? { metadata: { n: index } } : {}) }
    let oracle: unknown
    try {
      const bytes = decodeBase64(contentBase64)
      oracle = {
        accepted: {
          kind: input.kind,
          hex: Buffer.from(bytes).toString('hex'),
          blobRef: createHash('sha256').update(bytes).digest('hex'),
          metadata: input.metadata ?? {},
        },
      }
    } catch {
      oracle = {
        rejected: {
          status: 400,
          kind: 'validation',
          error: 'artifact content is not valid base64',
        },
      }
    }
    return { id: `decode/${index}`, input, oracle }
  })
  const deposited = [
    { build: 'b', kind: 'plan', revision: 4, blobRef: 'a', metadata: {}, createdAt: 'ts' },
    { build: 'b', kind: 'notes', revision: 2, blobRef: 'b', metadata: {}, createdAt: 'ts' },
  ]
  const variants: unknown[] = [
    null,
    true,
    'text',
    0,
    [],
    {},
    { kind: 'wrong-kind', rev: -1 },
    { kind: '', rev: -2 },
    { rev: -1, kind: 'reversed' },
    { kind: 'plan', rev: -3 },
    { kind: 'plan', rev: -1.5 },
    { kind: 'plan', rev: 0 },
    { kind: 'plan', rev: -0 },
    { kind: 'plan', rev: 1 },
    { kind: 'plan', rev: '-1' },
    { kind: 'plan', rev: null },
    { kind: 1, rev: -1 },
    { rev: -1 },
    { kind: 'plan' },
    { kind: 'plan', rev: -1, extra: true },
    { kind: 'plan', rev: -1e25 },
    { kind: 'plan', rev: -9007199254740991 },
    { kind: { kind: 'wrong', rev: -1 }, rev: -1 },
    { kind: 'plan', rev: -1, nested: { kind: 'wrong', rev: -2 } },
  ]
  for (const input of [...variants]) {
    variants.push([input, { nested: input }])
    variants.push({ array: [input], nested: { child: input } })
  }
  const substitution = variants.map((value, index) => {
    const input = JSON.parse(JSON.stringify(value))
    return {
      id: `substitution/${index}`,
      input,
      deposited,
      oracle: substitutePlaceholderRefs(input, deposited),
    }
  })
  const paths = [
    'packages/core/src/store/remote/protocol.ts',
    'experiments/proa-server/tools/protocol-artifact-preparation-fixtures.ts',
  ]
  return {
    sources: Object.fromEntries(
      paths.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
      ]),
    ),
    decode,
    substitution,
  }
}
export function checkArtifactPreparationFixtures() {
  if (
    !isDeepStrictEqual(
      JSON.parse(readFileSync(artifactFixturePath, 'utf8')),
      artifactPreparationFixtures(),
    )
  )
    throw new Error(
      'Stale artifact preparation fixtures; run bun tools/protocol-artifact-preparation-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [
        resolve(root, 'node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        artifactFixturePath,
      ],
      {
        stdin: Buffer.from(JSON.stringify(artifactPreparationFixtures())),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    if (formatted.exitCode !== 0) throw new Error('Cannot format artifact preparation fixtures')
    await Bun.write(artifactFixturePath, formatted.stdout)
  } else checkArtifactPreparationFixtures()
  console.log(
    'Artifact preparation fixtures match current canonical base64 and placeholder oracles',
  )
}

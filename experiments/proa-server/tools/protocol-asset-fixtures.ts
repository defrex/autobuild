import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { validateTicketAssetStructure } from '../../../packages/core/src/store/ticket-assets'
import { root, experiment } from './fixture-core'
import { z } from 'zod'
import { schemaNode } from './protocol-fixtures-schema'

export const assetFixturePath = resolve(experiment, 'fixtures/protocol-assets.json')
function snapshotSchema() {
  const source = readFileSync(
    resolve(root, 'packages/core/src/store/ticket-asset-snapshots.ts'),
    'utf8',
  )
  const start = source.indexOf('const refSchema =')
  const end = source.indexOf('function verifyMetadata', start)
  if (start < 0 || end < 0) throw new Error('Cannot locate provider snapshot schema')
  // This closed pure-JavaScript declaration block is the authoritative private
  // core schema; source hashes and generation reject drift in its constructs.
  return new Function('z', 'CHUNK_BYTES', `${source.slice(start, end)}; return manifestSchema`)(
    z,
    256 * 1024,
  ) as z.ZodType
}
export function assetFixtures() {
  const base = {
    kind: 'design',
    name: 'reference',
    layout: 'tree' as const,
    entries: [
      { type: 'dir' as const, path: 'empty' },
      { type: 'file' as const, path: 'index.html', size: 4 },
    ],
  }
  const inputs: unknown[] = [
    base,
    { ...base, entries: [] },
    { ...base, layout: 'file', entries: [{ type: 'file', path: 'index.html', size: 0 }] },
  ]
  for (const field of ['kind', 'name'] as const)
    for (const value of [
      '',
      ' ',
      '\u00a0',
      '\u200b',
      '.',
      '..',
      'a/b',
      'a b',
      'a\n',
      'a'.repeat(64),
      'a'.repeat(65),
      '雪'.repeat(30),
      'abc._-09',
    ])
      inputs.push({ ...base, [field]: value })
  for (const path of [
    '',
    '/a',
    'a/',
    'a//b',
    './a',
    'a/../b',
    'a\\b',
    'a\u0000b',
    'a'.repeat(129),
    'a'.repeat(128),
    `${'a'.repeat(128)}/${'b'.repeat(127)}`,
    `${'a'.repeat(128)}/${'b'.repeat(128)}`,
    '雪'.repeat(43),
    '雪'.repeat(42),
    'a/\n',
    'empty',
  ])
    inputs.push({ ...base, entries: [{ type: 'file', path, size: 1 }] })
  inputs.push(
    { ...base, layout: 'file', entries: [] },
    { ...base, layout: 'file', entries: [{ type: 'dir', path: 'a' }] },
    { ...base, layout: 'file', entries: [{ type: 'file', path: 'a/b', size: 1 }] },
    {
      ...base,
      entries: [
        { type: 'file', path: 'a', size: 1 },
        { type: 'file', path: 'a/b', size: 1 },
      ],
    },
    {
      ...base,
      entries: [
        { type: 'file', path: 'a/b', size: 1 },
        { type: 'file', path: 'a', size: 1 },
      ],
    },
    {
      ...base,
      entries: [
        { type: 'dir', path: 'a' },
        { type: 'file', path: 'a', size: 1 },
      ],
    },
    { ...base, entries: [{ type: 'file', path: 'a', size: 25 * 1024 * 1024 }] },
    { ...base, entries: [{ type: 'file', path: 'a', size: 25 * 1024 * 1024 + 1 }] },
    { ...base, entries: Array.from({ length: 1000 }, (_, i) => ({ type: 'dir', path: `d${i}` })) },
    { ...base, entries: Array.from({ length: 1001 }, (_, i) => ({ type: 'dir', path: `d${i}` })) },
  )
  const schema = snapshotSchema()
  const manifest = {
    version: 1,
    meta: {
      repo: 'repo',
      ticketId: 'ticket',
      kind: 'design',
      name: 'ref',
      revision: 0,
      layout: 'tree',
      size: 0,
      createdAt: 'date',
      entries: [{ type: 'dir', path: 'empty' }],
    },
    files: [],
  }
  const snapshotCases: unknown[] = [
    manifest,
    { ...manifest, extra: true },
    { ...manifest, version: 2 },
    { ...manifest, meta: { ...manifest.meta, extra: true } },
    { ...manifest, meta: { ...manifest.meta, size: -1 } },
    {
      ...manifest,
      files: [{ path: 'a', chunks: [{ kind: 'invalid', revision: 0, hash: 'h', size: 1 }] }],
    },
    {
      ...manifest,
      files: [
        { path: 'a', chunks: [{ kind: 'ticket-snapshot-abc', revision: 0, hash: 'h', size: 0 }] },
      ],
    },
  ]
  for (const key of ['version', 'meta', 'files']) {
    const input: Record<string, unknown> = { ...manifest }
    delete input[key]
    snapshotCases.push(input)
  }
  return {
    manifestSchema: schemaNode(schema, 'asset.snapshotManifest'),
    snapshots: snapshotCases.map((input, index) => {
      const result = schema.safeParse(input)
      return {
        id: `snapshot/${index}`,
        input,
        oracle: result.success ? { accepted: result.data } : { rejected: result.error.message },
      }
    }),
    sources: Object.fromEntries(
      [
        'packages/core/src/store/ticket-assets.ts',
        'packages/core/src/store/ticket-asset-snapshots.ts',
        'packages/postgres-store/src/store.ts',
      ].map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
      ]),
    ),
    cases: inputs.map((input, index) => {
      let oracle: unknown
      try {
        oracle = {
          accepted: validateTicketAssetStructure(
            input as Parameters<typeof validateTicketAssetStructure>[0],
          ),
        }
      } catch (error) {
        oracle = {
          rejected: {
            status: 422,
            kind: 'validation',
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
      return { id: `structure/${index}`, input, oracle }
    }),
  }
}
export function checkAssetFixtures() {
  if (!isDeepStrictEqual(assetFixtures(), JSON.parse(readFileSync(assetFixturePath, 'utf8'))))
    throw new Error('Stale ticket asset fixtures; regenerate protocol-asset-fixtures.ts --generate')
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', assetFixturePath],
      {
        stdin: Buffer.from(JSON.stringify(assetFixtures()).replaceAll('\u200b', '\\u200b')),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    if (formatted.exitCode) throw new Error('Cannot format ticket asset fixture')
    await Bun.write(assetFixturePath, formatted.stdout)
  } else checkAssetFixtures()
  console.log('Ticket asset fixtures fresh')
}

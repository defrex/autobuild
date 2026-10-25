/** Pinned SDK classifier/processor oracle. Rust consumes only generated data. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { uiMessageChunkSchema } from '../../../packages/core/node_modules/ai'
import { assembleUIMessageDocument } from '../../../packages/core/src/store/streams/assemble'
import {
  streamArtifactInput,
  type StreamPart,
} from '../../../packages/core/src/store/streams/types'
import { experiment, root } from './fixture-core'

export const streamDocumentFixturePath = resolve(
  experiment,
  'fixtures/protocol-stream-document.json',
)
const witnesses: Record<string, unknown>[] = [
  { type: 'text-start', id: 't', providerMetadata: { p: { v: 1 } } },
  { type: 'text-delta', id: 't', delta: 'hello ', providerMetadata: { p: { v: 2 } } },
  { type: 'text-end', id: 't', providerMetadata: { p: { v: 3 } } },
  { type: 'reasoning-start', id: 'r', providerMetadata: { p: { v: 1 } } },
  { type: 'reasoning-delta', id: 'r', delta: 'think', providerMetadata: { p: { v: 2 } } },
  { type: 'reasoning-end', id: 'r', providerMetadata: { p: { v: 3 } } },
  { type: 'error', errorText: 'failed' },
  {
    type: 'tool-input-start',
    toolCallId: 'c',
    toolName: 'grep',
    providerExecuted: false,
    providerMetadata: { p: { v: 1 } },
    toolMetadata: { title: 'meta' },
    dynamic: false,
    title: 'title',
  },
  { type: 'tool-input-delta', toolCallId: 'c', inputTextDelta: '{"q":"x"}' },
  {
    type: 'tool-input-available',
    toolCallId: 'c',
    toolName: 'grep',
    input: { q: 'x' },
    providerExecuted: false,
    providerMetadata: { p: { v: 1 } },
    toolMetadata: { title: 'meta' },
    dynamic: false,
    title: 'title',
  },
  {
    type: 'tool-input-error',
    toolCallId: 'c',
    toolName: 'grep',
    input: 'bad',
    errorText: 'bad',
    providerExecuted: false,
    providerMetadata: { p: { v: 1 } },
    toolMetadata: { title: 'meta' },
    dynamic: false,
    title: 'title',
  },
  {
    type: 'tool-approval-request',
    toolCallId: 'c',
    approvalId: 'a',
    approvalDescriptor: { text: 'approve' },
    reason: 'reason',
    isAutomatic: true,
    signature: 'sig',
  },
  {
    type: 'tool-approval-response',
    approvalId: 'a',
    approved: true,
    reason: 'yes',
    providerExecuted: false,
    providerMetadata: { p: { v: 2 } },
  },
  {
    type: 'tool-output-available',
    toolCallId: 'c',
    output: { hits: 3 },
    providerExecuted: true,
    providerMetadata: { p: { v: 2 } },
    toolMetadata: { ignored: true },
    dynamic: false,
    preliminary: false,
  },
  {
    type: 'tool-output-error',
    toolCallId: 'c',
    errorText: 'failure',
    providerExecuted: false,
    providerMetadata: { p: { v: 2 } },
    toolMetadata: { ignored: true },
    dynamic: false,
  },
  { type: 'tool-output-denied', toolCallId: 'c' },
  { type: 'custom', kind: 'provider-item', providerMetadata: { p: { v: true } } },
  {
    type: 'file',
    url: 'https://example.com/file',
    mediaType: 'image/png',
    providerMetadata: { p: { v: 1 } },
  },
  {
    type: 'reasoning-file',
    url: 'https://example.com/file',
    mediaType: 'image/png',
    providerMetadata: { p: { v: 1 } },
  },
  {
    type: 'source-url',
    sourceId: 's',
    url: 'https://example.com',
    title: 'title',
    providerMetadata: { p: { v: 1 } },
  },
  {
    type: 'source-document',
    sourceId: 's',
    mediaType: 'text/plain',
    title: 'title',
    filename: 'file.txt',
    providerMetadata: { p: { v: 1 } },
  },
  { type: 'data-probe', id: 'd', data: { n: 1 }, transient: false },
  { type: 'start-step' },
  { type: 'finish-step' },
  { type: 'reset-step' },
  { type: 'start', messageId: 'm', messageMetadata: { base: { x: 1 }, list: [1] } },
  { type: 'finish', finishReason: 'stop', messageMetadata: { base: { y: 2 }, list: [2] } },
  { type: 'abort', reason: 'stopped' },
  { type: 'message-metadata', messageMetadata: { extra: 1 } },
]
const sourceFiles = [
  'packages/core/src/store/streams/assemble.ts',
  'packages/core/src/store/streams/types.ts',
  'packages/core/node_modules/ai/dist/index.js',
  'packages/core/node_modules/ai/package.json',
]
function hashes() {
  return Object.fromEntries([
    [
      'AI SDK resolved provider-utils',
      createHash('sha256')
        .update(
          readFileSync(
            Bun.resolveSync(
              '@ai-sdk/provider-utils',
              resolve(root, 'packages/core/node_modules/ai'),
            ),
          ),
        )
        .digest('hex'),
    ],
    ...sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(root, file)))
        .digest('hex'),
    ]),
    [
      'generator',
      createHash('sha256')
        .update(readFileSync(import.meta.filename))
        .digest('hex'),
    ],
  ])
}
export async function streamDocumentFixtures() {
  const sdk = readFileSync(resolve(root, 'packages/core/node_modules/ai/dist/index.js'), 'utf8')
  const schema = sdk.slice(
    sdk.indexOf('var uiMessageChunkSchema ='),
    sdk.indexOf('function isDataUIMessageChunk'),
  )
  const literalTypes = [...schema.matchAll(/type: z\.literal\("([^"]+)"\)/g)].map((m) => m[1]!)
  if (literalTypes.some((type) => !witnesses.some((w) => w.type === type)))
    throw new Error('New SDK chunk type needs a witness and native implementation')
  const classifier = uiMessageChunkSchema() as unknown as {
    validate(value: unknown): Promise<{ success: boolean }>
  }
  const classified: { id: string; part: unknown; defined: boolean }[] = []
  const classificationInputs: unknown[] = [
    null,
    [],
    0,
    'text',
    {},
    { type: '' },
    { type: 'mystery' },
    { type: 'data-', data: null },
    { type: 'data-x', data: null, extra: true },
  ]
  for (const witness of witnesses) {
    classificationInputs.push(witness, { ...witness, extra: { preserved: true } })
    for (const key of Object.keys(witness)) {
      const missing = { ...witness }
      delete missing[key]
      classificationInputs.push(missing)
      for (const value of [null, 0, false, [], {}, ''])
        classificationInputs.push({ ...witness, [key]: value })
    }
  }
  for (const [index, part] of classificationInputs.entries())
    classified.push({
      id: `classify/${index}`,
      part,
      defined: (await classifier.validate(part)).success,
    })
  const cases: { id: string; parts: unknown[] }[] = []
  const add = (id: string, parts: unknown[]) => cases.push({ id, parts })
  const byType = (type: string) => structuredClone(witnesses.find((w) => w.type === type)!)
  const start = { type: 'start', messageId: 'm' }
  const text = [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'one' },
    { type: 'text-end', id: 't' },
  ]
  add('empty', [])
  add('undefined', [{ type: 'mystery' }])
  add('representative', [
    start,
    ...text,
    byType('reasoning-start'),
    byType('reasoning-delta'),
    byType('reasoning-end'),
    byType('tool-input-available'),
    byType('tool-output-available'),
    byType('data-probe'),
    byType('error'),
    { type: 'mystery' },
    byType('finish'),
  ])
  for (const witness of witnesses) {
    add(`alone/${witness.type}`, [witness])
    add(`after-text/${witness.type}`, [start, ...text, witness])
    add(`extras/${witness.type}`, [
      start,
      byType('tool-input-start'),
      byType('tool-approval-request'),
      {
        ...witness,
        input: 'extra-input',
        output: 'extra-output',
        rawInput: 'extra-raw',
        title: 'extra-title',
        errorText: 'extra-error',
        preliminary: true,
        extra: { keep: true },
      },
    ])
  }
  for (const type of [
    'text-delta',
    'text-end',
    'reasoning-delta',
    'reasoning-end',
    'tool-input-delta',
    'tool-output-available',
    'tool-output-error',
    'tool-output-denied',
    'tool-approval-request',
    'tool-approval-response',
  ])
    add(`halt/${type}`, [
      start,
      ...text,
      { ...byType(type), id: 'ghost', toolCallId: 'ghost', approvalId: 'ghost' },
      { type: 'data-after', data: true },
      { type: 'start', messageId: 'second' },
      ...text,
    ])
  add('multiple-start', [...text, start, ...text, { type: 'start', messageId: 'last' }, ...text])
  add('duplicates', [
    start,
    byType('text-start'),
    byType('text-start'),
    byType('text-delta'),
    byType('text-end'),
    byType('text-delta'),
    { type: 'data-never', data: 1 },
  ])
  add('steps-and-reset', [
    start,
    ...text,
    { type: 'start-step' },
    byType('tool-input-available'),
    { type: 'reset-step' },
    { type: 'data-end', data: 1 },
  ])
  add('reset-leading', [start, ...text, { type: 'reset-step' }])
  add('step-no-write', [start, ...text, { type: 'start-step' }])
  add('step-write-later', [start, ...text, { type: 'start-step' }, { type: 'data-end', data: 1 }])
  add('data-replacement', [
    start,
    byType('data-probe'),
    { type: 'data-probe', id: 'd', data: { n: 2 }, extra: 'new' },
    byType('data-probe'),
    { type: 'data-probe', id: 'd', data: 5, transient: true },
  ])
  add('data-no-id', [start, { type: 'data-x', data: 1 }, { type: 'data-x', data: 2 }])
  add('metadata-merge', [byType('start'), byType('finish'), byType('message-metadata')])
  for (const base of [null, 0, false, 'abc', [], [1], {}, { a: 1, nested: { a: 1 }, list: [1] }])
    for (const override of [
      null,
      0,
      false,
      'abc',
      [],
      [2],
      {},
      { b: 2, nested: { b: 2 }, list: [2] },
    ])
      add(`metadata/${JSON.stringify(base)}/${JSON.stringify(override)}`, [
        { type: 'start', messageId: 'm', messageMetadata: base },
        { type: 'message-metadata', messageMetadata: override },
        { type: 'data-after', data: 1 },
      ])
  add('metadata-proto', [
    {
      type: 'start',
      messageId: 'm',
      messageMetadata: JSON.parse('{"__proto__":{"keep":1},"constructor":3,"base":{"a":1}}'),
    },
    {
      type: 'message-metadata',
      messageMetadata: JSON.parse(
        '{"__proto__":{"drop":1},"constructor":4,"prototype":5,"base":{"b":2}}',
      ),
    },
  ])
  for (const dynamic of [false, true]) {
    const input = { ...byType('tool-input-start'), dynamic }
    for (const terminal of ['tool-output-available', 'tool-output-error', 'tool-output-denied'])
      add(`tool/${dynamic}/${terminal}`, [
        start,
        input,
        byType('tool-input-delta'),
        { ...byType('tool-input-available'), dynamic },
        byType(terminal),
      ])
    add(`tool/${dynamic}/approval`, [
      start,
      { ...byType('tool-input-available'), dynamic },
      byType('tool-approval-request'),
      byType('tool-approval-response'),
      byType('tool-output-available'),
    ])
    add(`tool/${dynamic}/input-error`, [
      start,
      input,
      { ...byType('tool-input-error'), dynamic },
      byType('tool-output-error'),
    ])
    add(`tool/${dynamic}/change-type`, [
      start,
      input,
      { ...byType('tool-input-available'), dynamic: !dynamic },
      byType('tool-output-available'),
    ])
    add(`tool/${dynamic}/previous-step`, [
      start,
      { ...byType('tool-input-available'), dynamic },
      { type: 'start-step' },
      byType('tool-output-available'),
    ])
    add(`tool/${dynamic}/downgrade`, [
      start,
      input,
      byType('tool-input-delta'),
      byType('tool-output-available'),
      byType('tool-input-delta'),
    ])
  }
  const partialTexts = [
    '',
    '{',
    '{"',
    '{"q',
    '{"q"',
    '{"q":',
    '{"q":"',
    '{"q":"x',
    '{"q":"x"',
    '{"q":true',
    '{"q":tru',
    '{"q":false',
    '{"q":nu',
    '{"q":-',
    '{"q":12e',
    '{"q":[',
    '{"q":[1,',
    '{"q":[1,2',
    '{"q":{"a":',
    '{"q":"\\u12',
    '{"q":"\\u1234',
    '[',
    '[1,',
    '[tru',
    '"abc',
    'true',
    'f',
    'null',
    '-',
    '1e',
    '1e+',
    'nonsense',
    '{"q":"雪',
    '{"q":"a\\',
    '{"q":"a\\n',
    '{"__proto__":1}',
    '{"constructor":{"prototype":{}}}',
  ]
  for (const [i, inputTextDelta] of partialTexts.entries())
    add(`partial/${i}`, [
      start,
      { type: 'tool-input-start', toolCallId: 'c', toolName: 'tool' },
      { type: 'tool-input-delta', toolCallId: 'c', inputTextDelta },
    ])
  const losslessInputs: { id: string; parts: unknown[] }[] = []
  const unicodeTexts = [
    '{"q":"\\uD800"}',
    '{"q":"\\uDC00"}',
    '{"\\uD800":"value"}',
    '{"q":["\\uD800",{"\\uDC00":"\\uDFFF"}],"n":9007199254740993}',
    '"\\ud800"',
    '{"q":"\\uD83D\\uDE00"}',
    '{"q":"\\uD800\\u0041"}',
    '{"q":"\\uD800',
    '{"q":"\\uD800\\u',
    '{"q":"\\uD800\\n"}',
    '{"\\ud800":1,"\\ud801":2,"2":2,"1":1,"dup":1,"dup":2}',
    '{"\\u005f_proto__":"\\ud800"}',
    '{"$serde_json::private::Number":"\\ud800"}',
  ]
  for (const dynamic of [false, true])
    for (const [index, inputTextDelta] of unicodeTexts.entries())
      for (const tail of ['streaming', 'output', 'denied', 'approval', 'replace']) {
        const parts: unknown[] = [
          start,
          { type: 'tool-input-start', toolCallId: 'c', toolName: 'unicode', dynamic },
          { type: 'tool-input-delta', toolCallId: 'c', inputTextDelta },
        ]
        if (tail === 'output')
          parts.push({ type: 'tool-output-available', toolCallId: 'c', output: { ok: true } })
        if (tail === 'denied') parts.push({ type: 'tool-output-denied', toolCallId: 'c' })
        if (tail === 'approval')
          parts.push(byType('tool-approval-request'), byType('tool-approval-response'))
        if (tail === 'replace')
          parts.push({
            type: 'tool-input-available',
            toolCallId: 'c',
            toolName: 'unicode',
            dynamic,
            input: { replaced: true },
          })
        losslessInputs.push({ id: `utf16/${dynamic}/${index}/${tail}`, parts })
      }
  for (const messageMetadata of ['😀', 'a😀b', '雪😀', '𝄞'])
    for (const override of [{}, [], { tail: true }])
      losslessInputs.push({
        id: `utf16-metadata/${messageMetadata}/${JSON.stringify(override)}`,
        parts: [
          { type: 'start', messageId: 'm', messageMetadata },
          { type: 'message-metadata', messageMetadata: override },
          { type: 'message-metadata', messageMetadata: { next: true } },
        ],
      })
  const lossless = []
  for (const row of losslessInputs) {
    const assembly = await assembleUIMessageDocument(row.parts as StreamPart[])
    lossless.push({
      ...row,
      documentText: JSON.stringify(assembly.document),
      droppedPartCount: assembly.droppedPartCount,
      artifact: streamArtifactInput(
        'st_fixture',
        { kind: 'build', build: 'b' },
        'label',
        'aborted',
        assembly.document,
        3,
        assembly.droppedPartCount,
      ),
    })
  }
  const assembled = []
  for (const row of cases) {
    const assembly = await assembleUIMessageDocument(row.parts as StreamPart[])
    const artifacts = ['build', 'repo', 'session'].map((kind, index) =>
      streamArtifactInput(
        'st_fixture',
        kind === 'build'
          ? { kind, build: 'b' }
          : kind === 'repo'
            ? { kind, repo: 'r' }
            : { kind: 'session' as const, session: 's' },
        'label',
        index === 1 ? 'aborted' : 'completed',
        assembly.document,
        3,
        assembly.droppedPartCount,
      ),
    )
    assembled.push({ ...row, assembly: JSON.parse(JSON.stringify(assembly)), artifacts })
  }
  return {
    sources: hashes(),
    sdk: JSON.parse(
      readFileSync(resolve(root, 'packages/core/node_modules/ai/package.json'), 'utf8'),
    ).version,
    types: [...literalTypes, 'data-*'],
    classified,
    assembled,
    lossless,
  }
}
export async function checkStreamDocumentFixtures() {
  if (
    !isDeepStrictEqual(
      await streamDocumentFixtures(),
      JSON.parse(readFileSync(streamDocumentFixturePath, 'utf8')),
    )
  )
    throw new Error(
      'Stale stream document fixtures; regenerate protocol-stream-document-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [
        resolve(root, 'node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        streamDocumentFixturePath,
      ],
      {
        stdin: Buffer.from(JSON.stringify(await streamDocumentFixtures())),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    if (formatted.exitCode) throw new Error('Cannot format stream document fixture')
    await Bun.write(streamDocumentFixturePath, formatted.stdout)
  } else await checkStreamDocumentFixtures()
  console.log('Stream document SDK oracle fixtures fresh')
}

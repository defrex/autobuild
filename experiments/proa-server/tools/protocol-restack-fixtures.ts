import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AbEvent } from '../../../packages/core/src/events/catalog'
import { nodeRestackReducer } from '../../../packages/core/src/kernel/node-restack-state'
import { leafRestackReducer } from '../../../packages/core/src/kernel/leaf-restack-state'
import { leafRestackLog } from '../../../packages/core/src/kernel/generators/leaf-restack-log'
import { experiment, root } from './fixture-core'
export const restackFixturePath = resolve(experiment, 'fixtures/protocol-restack.json.gz')
type Write = { type: string; payload: Record<string, unknown> }
const event = (type: string, payload: Record<string, unknown>): Write => ({ type, payload })
function nodeTransaction(
  operation = 'restack',
  changes = [{ sha: 'first', build: 'build-a' }, { sha: 'foreign' }] as {
    sha: string
    build?: string
  }[],
  dropped = false,
  id = 'tx',
  parent = 'parent',
) {
  const reserve = event('node.writer-reserved', {
    id,
    operation,
    requests: ['r1'],
    expected: 'expected',
    parent,
    oldBase: 'old-base',
    archive: 'archive',
    changes,
    upstreamBuilds: [],
    merges: [],
  })
  const log = [reserve]
  let base = parent
  for (const [index] of changes.entries()) {
    log.push(event('node.item-prepared', { id, index, base }))
    log.push(event('node.item-conflicted', { id, index, base, files: ['conflict'] }))
    const head = dropped ? base : `head-${id}-${index}`
    log.push(event('node.item-replayed', { id, index, base, head, dropped }))
    base = head
  }
  log.push(
    event('node.publish-intended', { id, head: base }),
    event('node.rewritten', { id, previous: 'expected', head: base }),
    event('node.inventory', { head: base, commits: [], foreign: [], builds: [] }),
    event('node.writer-settled', { id, outcome: 'completed' }),
  )
  return log
}
export function restackFixtures() {
  const cases: { id: string; name: string; events: unknown[]; oracle: unknown }[] = []
  const add = (id: string, name: 'nodeRestack' | 'leafRestack', writes: Write[]) => {
    const events = writes.map((w, i) => ({
      build: 'fixture',
      seq: i + 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { kind: 'kernel' },
      ...w,
    })) as AbEvent[]
    let oracle: unknown
    try {
      oracle = {
        accepted: JSON.parse(
          JSON.stringify(
            (name === 'nodeRestack' ? nodeRestackReducer : leafRestackReducer).reduce(events),
          ),
        ),
      }
    } catch (error) {
      oracle = { error: error instanceof Error ? error.message : String(error) }
    }
    cases.push({ id, name, events, oracle })
  }
  const prefixes = (id: string, name: 'nodeRestack' | 'leafRestack', log: Write[]) => {
    for (let i = 0; i <= log.length; i++) add(`${id}/${i}`, name, log.slice(0, i))
  }
  const requested = event('node.restack-requested', {
    id: 'r1',
    reason: 'operator',
    branch: 'branch',
    parent: 'parent',
  })
  const opened = event('node.opened', { sha: 'initial' })
  for (const operation of ['restack', 'landing'])
    for (const dropped of [false, true])
      for (const changes of [
        [],
        [{ sha: 'foreign' }],
        [{ sha: 'first', build: 'build-a' }, { sha: 'foreign' }],
        [
          { sha: 'x', build: '😀' },
          { sha: 'y', build: '\uE000' },
          { sha: 'z', build: 'a' },
        ],
      ])
        prefixes(`node/${operation}/${dropped}/${changes.length}`, 'nodeRestack', [
          opened,
          requested,
          ...nodeTransaction(operation, changes, dropped),
        ])
  prefixes('node-parent', 'nodeRestack', [
    event('target.moved', { branch: 'main', sha: 'before' }),
    event('node.inventory', { head: 'pre-open', commits: [] }),
    opened,
    event('node.opened', { sha: 'second' }),
    event('target.moved', { branch: 'main', sha: 'after' }),
    requested,
    event('node.restack-requested', { id: 'r2', reason: 'operator', branch: 'b', parent: 'p' }),
    event('node.restack-satisfied', { id: 'r2', parent: 'p', outcome: 'covered' }),
    event('node.parent-distance', { base: 'initial', parent: 'p', branch: 'main', count: 2 }),
    event('node.parent-requested', { id: 'p1', target: 'main' }),
    event('node.parent-cancelled', { id: 'other', reason: 'ignored' }),
    event('node.parent-cancelled', { id: 'p1', reason: 'cancel' }),
    event('node.parent-requested', { id: 'p2', target: 'main' }),
    event('node.parent-rejected', { revision: 1, target: 'main', reason: 'rejected' }),
    event('node.parent-rejection-cleared', {}),
    event('node.parent-rejected', { revision: 2, target: 'main', reason: 'again' }),
    event('node.parent-accepted', { id: 'p2', target: 'main' }),
    event('node.parent-pr-retargeted', { id: 'p2', base: 'main' }),
    ...nodeTransaction(),
    event('node.parent-completed', { id: 'other' }),
    event('node.parent-completed', { id: 'p2' }),
    event('node.contribution-recorded', { landing: 'a'.repeat(40), head: 'head', base: 'base' }),
    event('node.inventory', { head: 'explicit', base: 'provided', commits: [] }),
  ])
  prefixes('node-alias-chain', 'nodeRestack', [
    opened,
    ...nodeTransaction('restack', [{ sha: 'foreign' }], false, 'first'),
    ...nodeTransaction('restack', [{ sha: 'head-first-0' }], false, 'second'),
    ...nodeTransaction('restack', [{ sha: 'head-second-0' }], true, 'third'),
  ])
  prefixes('node-proto-requests', 'nodeRestack', [
    opened,
    event('node.restack-requested', {
      id: '__proto__',
      reason: 'operator',
      branch: 'b',
      parent: 'p',
    }),
    event('node.restack-satisfied', { id: '__proto__', parent: 'p', outcome: 'covered' }),
    event('node.opened', { sha: '__proto__' }),
  ])
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    for (const dropped of [false, true])
      prefixes(`node-alias-prototype/${key}/${dropped}`, 'nodeRestack', [
        opened,
        ...nodeTransaction('restack', [{ sha: key }], dropped),
      ])
  const reservation = nodeTransaction()[0]!,
    prepared = event('node.item-prepared', { id: 'tx', index: 0, base: 'parent' }),
    receipt = event('node.item-replayed', {
      id: 'tx',
      index: 0,
      base: 'parent',
      head: 'head',
      dropped: false,
    })
  const bads: { id: string; before: Write[]; next: Write }[] = [
    { id: 'double-reservation', before: [reservation], next: reservation },
    { id: 'prepare-missing', before: [], next: prepared },
    {
      id: 'prepare-index',
      before: [reservation],
      next: event('node.item-prepared', { id: 'tx', index: 1, base: 'parent' }),
    },
    { id: 'prepare-outside', before: nodeTransaction('restack', []).slice(0, 1), next: prepared },
    {
      id: 'prepare-base',
      before: [reservation],
      next: event('node.item-prepared', { id: 'tx', index: 0, base: 'wrong' }),
    },
    {
      id: 'conflict-missing',
      before: [reservation],
      next: event('node.item-conflicted', { id: 'tx', index: 0, base: 'parent' }),
    },
    {
      id: 'conflict-id',
      before: [reservation, prepared],
      next: event('node.item-conflicted', { id: 'wrong', index: 0, base: 'parent' }),
    },
    {
      id: 'conflict-index',
      before: [reservation, prepared],
      next: event('node.item-conflicted', { id: 'tx', index: 1, base: 'parent' }),
    },
    {
      id: 'conflict-base',
      before: [reservation, prepared],
      next: event('node.item-conflicted', { id: 'tx', index: 0, base: 'wrong' }),
    },
    { id: 'receipt-missing', before: [reservation], next: receipt },
    {
      id: 'receipt-id-ignored',
      before: [reservation, prepared],
      next: event('node.item-replayed', { ...receipt.payload, id: 'wrong' }),
    },
    {
      id: 'receipt-base',
      before: [reservation, prepared],
      next: event('node.item-replayed', { ...receipt.payload, base: 'wrong' }),
    },
    {
      id: 'dropped-moved',
      before: [reservation, prepared],
      next: event('node.item-replayed', { ...receipt.payload, dropped: true }),
    },
    {
      id: 'publish-incomplete',
      before: [reservation],
      next: event('node.publish-intended', { id: 'tx', head: 'head' }),
    },
    {
      id: 'publish-head',
      before: nodeTransaction('restack', [{ sha: 'one' }]).slice(0, 4),
      next: event('node.publish-intended', { id: 'tx', head: 'wrong' }),
    },
    {
      id: 'rewrite-missing',
      before: [reservation],
      next: event('node.rewritten', { id: 'tx', head: 'head', previous: 'expected' }),
    },
    {
      id: 'rewrite-previous',
      before: nodeTransaction('restack', [{ sha: 'one' }]).slice(0, 5),
      next: event('node.rewritten', { id: 'tx', head: 'head-tx-0', previous: 'wrong' }),
    },
    {
      id: 'settle-unknown',
      before: [],
      next: event('node.writer-settled', { id: 'tx', outcome: 'completed' }),
    },
    {
      id: 'settle-early',
      before: [reservation],
      next: event('node.writer-settled', { id: 'tx', outcome: 'completed' }),
    },
    {
      id: 'settle-contended',
      before: [reservation, prepared],
      next: event('node.writer-settled', { id: 'tx', outcome: 'contended', actual: 'other' }),
    },
    {
      id: 'settle-abandoned',
      before: [reservation, prepared],
      next: event('node.writer-settled', { id: 'tx', outcome: 'abandoned' }),
    },
    {
      id: 'receipt-late',
      before: [
        reservation,
        prepared,
        event('node.writer-settled', { id: 'tx', outcome: 'abandoned' }),
      ],
      next: receipt,
    },
    { id: 'receipt-duplicate', before: [reservation, prepared, receipt], next: receipt },
  ]
  for (const bad of bads) add(`node-error/${bad.id}`, 'nodeRestack', [...bad.before, bad.next])
  const leaf = leafRestackLog().map(({ type, payload }) => ({ type, payload })) as Write[]
  prefixes('leaf-reference', 'leafRestack', leaf)
  const transaction = leaf.find((e) => e.type === 'restack.prepared')!.payload
  prefixes('leaf-overwrite', 'leafRestack', [
    event('target.moved', { branch: 'main', sha: 'before' }),
    event('node.parent-accepted', { id: 'parent' }),
    event('workspace.provisioned', { base: { sha: 'initial' } }),
    event('workspace.provisioned', { base: { sha: 'later' } }),
    event('finalize.step-completed', { ok: false, headSha: 'ignore' }),
    event('finalize.step-completed', { ok: true }),
    event('finalize.step-completed', { ok: true, headSha: 'head' }),
    event('finalize.completed', {}),
    event('restack.prepared', transaction),
    event('restack.replayed', { id: 'wrong', conflicted: false }),
    event('restack.replayed', { id: transaction.id, conflicted: true }),
    event('restack.publish-intended', { ...transaction, id: 'wrong', headSha: 'h' }),
    event('restack.publish-intended', { ...transaction, headSha: 'h' }),
    event('reconcile.started', { attempt: 1, baseSha: 'base', restackId: 'wrong' }),
    event('reconcile.started', { attempt: 2, baseSha: 'base', restackId: transaction.id }),
    event('restack.completed', { ...transaction, id: 'other', headSha: 'h' }),
    event('restack.completed', { ...transaction, headSha: 'h' }),
    event('restack.prepared', { ...transaction, id: 'next', trigger: 'post-finalize', cycle: 42 }),
    event('reconcile.started', { attempt: 3, baseSha: 'base', restackId: 'next' }),
    event('restack.completed', {
      ...transaction,
      id: 'next',
      trigger: 'post-finalize',
      cycle: 42,
      headSha: 'next',
    }),
  ])
  return {
    sources: Object.fromEntries(
      [
        'packages/core/src/kernel/node-restack-state.ts',
        'packages/core/src/kernel/leaf-restack-state.ts',
        'packages/core/src/kernel/incremental.ts',
        'packages/core/src/kernel/generators/leaf-restack-log.ts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(resolve(root, file)))
          .digest('hex'),
      ]),
    ),
    cases,
  }
}
export function checkRestackFixtures() {
  if (
    !isDeepStrictEqual(
      restackFixtures(),
      JSON.parse(gunzipSync(readFileSync(restackFixturePath)).toString('utf8')),
    )
  )
    throw new Error('Stale restack fixtures; regenerate protocol-restack-fixtures.ts --generate')
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    await Bun.write(
      restackFixturePath,
      gzipSync(Buffer.from(JSON.stringify(restackFixtures())), { level: 9 }),
    )
  } else checkRestackFixtures()
  console.log('Restack reducer oracle fixtures fresh')
}

import { validateEventWrite, type AbEvent, type EventWrite } from '../../events/catalog'
import { DISPATCHER, KERNEL } from '../../events/envelope'

/** A complete multi-item transaction, including a stable-identity drop and a
 * foreign conflict, for every persisted reducer's prefix/shape coverage. */
export function nodeRestackLog(): AbEvent[] {
  const parent = 'b'.repeat(40)
  const expected = 'a'.repeat(40)
  const head = 'c'.repeat(40)
  const writes: EventWrite[] = [
    {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: 'repo',
        ticket: { source: 'file', id: 'node' },
        baseBranch: 'main',
        kind: 'node',
      },
    },
    { actor: DISPATCHER, type: 'node.opened', payload: { sha: 'd'.repeat(40) } },
    {
      actor: KERNEL,
      type: 'node.restack-availability-observed',
      payload: {
        version: 1,
        fingerprint: 'assessment',
        branch: 'ab-node/node',
        parentBranch: 'main',
        head: expected,
        parent,
        base: 'd'.repeat(40),
        available: [],
      },
    },
    {
      actor: KERNEL,
      type: 'node.writer-reserved',
      payload: {
        id: 'node-tx',
        operation: 'restack',
        expected,
        parent,
        oldBase: 'd'.repeat(40),
        archive: `refs/autobuild/archive/node/${expected}`,
        changes: [
          { sha: 'e'.repeat(40), build: 'source' },
          { sha: 'f'.repeat(40), mainline: 1 },
        ],
        upstreamBuilds: ['source'],
        merges: [{ sha: 'f'.repeat(40), parent, identities: ['source'], missing: [] }],
      },
    },
    {
      actor: KERNEL,
      type: 'node.item-prepared',
      payload: { id: 'node-tx', index: 0, base: parent },
    },
    {
      actor: KERNEL,
      type: 'node.item-replayed',
      payload: {
        id: 'node-tx',
        index: 0,
        base: parent,
        head: parent,
        dropped: true,
        dropReason: 'upstream-identity',
      },
    },
    {
      actor: KERNEL,
      type: 'node.item-prepared',
      payload: { id: 'node-tx', index: 1, base: parent },
    },
    {
      actor: KERNEL,
      type: 'node.item-conflicted',
      payload: { id: 'node-tx', index: 1, base: parent },
    },
    {
      actor: KERNEL,
      type: 'node.item-replayed',
      payload: { id: 'node-tx', index: 1, base: parent, head, dropped: false },
    },
    { actor: KERNEL, type: 'node.publish-intended', payload: { id: 'node-tx', head } },
    { actor: KERNEL, type: 'node.rewritten', payload: { id: 'node-tx', previous: expected, head } },
    {
      actor: KERNEL,
      type: 'node.inventory',
      payload: { head, base: parent, builds: ['source'], foreign: [head] },
    },
    {
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: 'node-tx', outcome: 'completed' },
    },
  ]
  return writes.map(
    (write, index) =>
      ({
        ...validateEventWrite(write),
        build: 'node',
        seq: index + 1,
        ts: '2026-10-17T00:00:00Z',
      }) as AbEvent,
  )
}

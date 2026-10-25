import { validateEventWrite, type AbEvent } from '../../events/catalog'
import { KERNEL } from '../../events/envelope'
import type { EventPayload } from '../../events/payloads'

export const leafTransaction: EventPayload<'restack.prepared'> = {
  id: 'leaf-1',
  trigger: 'verify-entry',
  cycle: 6,
  observation: 7,
  branch: 'ab/leaf',
  oldHead: 'b'.repeat(40),
  oldBase: 'a'.repeat(40),
  targetBase: 'c'.repeat(40),
  changeSha: 'd'.repeat(40),
  workspaceHead: 'b'.repeat(40),
  localBranchHead: 'b'.repeat(40),
  message: 'Leaf change\n\nAutobuild-Build: leaf\n',
}
export function leafRestackLog(): AbEvent[] {
  const writes = [
    {
      type: 'build.created',
      actor: { kind: 'dispatcher' },
      payload: { ticket: { source: 'file', id: 'leaf' }, repo: 'repo', baseBranch: 'main' },
    },
    {
      type: 'spec.imported',
      actor: { kind: 'dispatcher' },
      payload: { artifact: { kind: 'spec', rev: 0 }, ticket: { source: 'file', id: 'leaf' } },
    },
    {
      type: 'plan.completed',
      actor: { kind: 'agent', role: 'plan', session: 's1' },
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    },
    {
      type: 'plan-review.verdict',
      actor: { kind: 'agent', role: 'plan-review', session: 's2' },
      payload: {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      },
    },
    {
      type: 'implement.completed',
      actor: { kind: 'agent', role: 'implement', session: 's3' },
      payload: {
        round: 1,
        commits: { base: leafTransaction.oldBase, head: leafTransaction.oldHead },
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    },
    {
      type: 'code-review.verdict',
      actor: { kind: 'agent', role: 'code-review', session: 's4' },
      payload: {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'code-review', rev: 0 },
      },
    },
    {
      type: 'target.moved',
      actor: KERNEL,
      payload: { branch: 'main', sha: leafTransaction.targetBase },
    },
    {
      type: 'target.distance',
      actor: { kind: 'dispatcher' },
      payload: {
        branch: 'main',
        sha: leafTransaction.targetBase,
        head: leafTransaction.oldHead,
        count: 2,
      },
    },
    { type: 'restack.prepared', actor: KERNEL, payload: leafTransaction },
    {
      type: 'restack.replayed',
      actor: KERNEL,
      payload: { id: leafTransaction.id, conflicted: false },
    },
    {
      type: 'restack.publish-intended',
      actor: KERNEL,
      payload: { ...leafTransaction, headSha: 'e'.repeat(40) },
    },
    {
      type: 'restack.rewritten',
      actor: KERNEL,
      payload: {
        ...leafTransaction,
        headSha: 'e'.repeat(40),
        archives: [
          {
            ref: `refs/autobuild/archive/leaf/${leafTransaction.oldHead}`,
            sha: leafTransaction.oldHead,
          },
        ],
      },
    },
    {
      type: 'restack.completed',
      actor: KERNEL,
      payload: { ...leafTransaction, headSha: 'e'.repeat(40) },
    },
  ]
  return writes.map(
    (write, i) =>
      ({
        ...validateEventWrite(write),
        build: 'leaf',
        seq: i + 1,
        ts: '2026-10-17T00:00:00.000Z',
      }) as AbEvent,
  )
}

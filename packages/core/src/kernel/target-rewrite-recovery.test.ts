import { describe, expect, test } from 'bun:test'
import { validateEventWrite, type AbEvent, type EventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { steppingClock } from '../testing/fixed'
import { checkIncremental } from './incremental-contract'
import { leafBaseInUse } from './leaf-restack-base'
import { indexLog, logIndexReducer } from './log-index'
import { reduceBuild } from './reducer'
import {
  classifyAcceptedLocal,
  openPublishingOwner,
  reprovisionResume,
  targetRewriteQuestion,
} from './target-rewrite-recovery'
import { verifyDiffBaseReducer } from './verify-diff-base'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

function log(writes: Omit<EventWrite, 'compatibility'>[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map((write, index) => {
    const valid = validateEventWrite(write)
    return {
      build: 'b',
      seq: index + 1,
      ts: clock().toISOString(),
      actor: valid.actor,
      type: valid.type,
      payload: valid.payload,
    } as AbEvent
  })
}

const provisioned = {
  actor: KERNEL,
  type: 'workspace.provisioned',
  payload: { provider: 'fake', ref: '/ws', branch: 'ab/b', base: { source: 'remote', sha: A } },
} as const
const rewritten = (previousSha: string, sha: string) =>
  ({
    actor: DISPATCHER,
    type: 'target.rewritten',
    payload: { branch: 'main', previousSha, sha },
  }) as const
const moved = (sha: string) =>
  ({ actor: DISPATCHER, type: 'target.moved', payload: { branch: 'main', sha } }) as const
const prepared = {
  actor: KERNEL,
  type: 'target.rewrite-reprovision-prepared',
  payload: { branch: 'main', previousSha: A, base: A, from: A, sha: B },
} as const
const reprovisioned = {
  actor: KERNEL,
  type: 'target.rewrite-recovered',
  payload: { branch: 'main', previousSha: A, sha: B, base: A, recovery: 'reprovisioned' },
} as const

describe('rewritten-target recovery decisions', () => {
  test('a resuming runner completes, redoes or refuses an open reset', () => {
    const open = { from: A, sha: B }
    expect(reprovisionResume(open, B, false)).toBe('complete')
    expect(reprovisionResume(open, A, true)).toBe('redo')
    expect(reprovisionResume(open, A, false)).toBe('unknown')
    expect(reprovisionResume(open, C, true)).toBe('unknown')
    expect(reprovisionResume(open, undefined, true)).toBe('unknown')
  })

  test('an accept finds local commits published, pending on an owner, or refused', () => {
    const owner = { kind: 'phase', phase: 'implement' } as const
    const input = { local: C, published: B, base: A, localInPublished: false, localDescends: true }
    expect(classifyAcceptedLocal({ ...input, localInPublished: true, owner })).toEqual({
      kind: 'none',
    })
    expect(classifyAcceptedLocal({ ...input, published: undefined, local: A, owner })).toEqual({
      kind: 'none',
    })
    expect(classifyAcceptedLocal({ ...input, owner })).toEqual({
      kind: 'pending',
      pendingLocal: { head: C, owner },
    })
    expect(classifyAcceptedLocal({ ...input, owner: undefined })).toEqual({
      kind: 'refuse',
      from: B,
    })
  })

  test('the publishing owner comes from the folded facts', () => {
    const owner = (writes: Omit<EventWrite, 'compatibility'>[]) => {
      const events = log(writes)
      // Chunked folds agree with the whole log on the open post-step.
      checkIncremental(logIndexReducer, events)
      return openPublishingOwner(reduceBuild(events), indexLog(events))
    }
    const finalized = [
      provisioned,
      { actor: KERNEL, type: 'finalize.started', payload: {} },
      {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: { number: 1, url: 'https://x.test/1', headSha: 'h' } },
      },
      { actor: KERNEL, type: 'finalize.step-started', payload: { step: 'x' } },
    ] as const
    expect(owner([...finalized])).toEqual({ kind: 'finalize-step', step: 'x', startedSeq: 4 })
    expect(
      owner([
        ...finalized,
        { actor: KERNEL, type: 'finalize.step-completed', payload: { step: 'x', ok: true } },
      ]),
    ).toBeUndefined()
    expect(
      owner([
        ...finalized,
        {
          actor: KERNEL,
          type: 'spec.revised',
          payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1 },
        },
      ]),
    ).toBeUndefined()
    expect(
      owner([provisioned, { actor: KERNEL, type: 'implement.started', payload: { round: 1 } }]),
    ).toEqual({
      kind: 'phase',
      phase: 'implement',
    })
  })

  test('the question lists at most twenty own commits and both choices', () => {
    const commits = Array.from({ length: 22 }, (_, i) => ({
      sha: String(i).padStart(40, '0'),
      subject: `change ${i}`,
    }))
    const text = targetRewriteQuestion({
      slug: 's',
      branch: 'main',
      previousSha: A,
      sha: B,
      commits,
      published: C,
      pr: 9,
    })
    expect(text).toContain('ab answer s --accept-target')
    expect(text).toContain('ab abort s')
    expect(text).toContain('#9')
    expect(text).toContain('change 19')
    expect(text).not.toContain('change 20')
    expect(text).toContain('and 2 more')
  })
})

describe('rewritten-target recovery folds', () => {
  test('a reprovision clears the episode and moves every base to the target', () => {
    const events = log([provisioned, rewritten(A, B), prepared, reprovisioned])
    const index = indexLog(events)
    const state = reduceBuild(events)
    expect(index.restack.targetRewrite).toBeUndefined()
    expect(index.restack.reprovision).toBeUndefined()
    expect(index.restack.target).toMatchObject({ branch: 'main', sha: B })
    expect(leafBaseInUse(index)).toBe(B)
    expect(verifyDiffBaseReducer.reduce(events)).toBe(B)
    expect(state.targetRewrite).toBeUndefined()
    expect(state.implement.contributionBase).toBe(B)
    checkIncremental(logIndexReducer, events)
  })

  test('only the recovered fact clears an open preparation', () => {
    const events = log([provisioned, rewritten(A, B), prepared, moved(A), rewritten(A, C)])
    expect(indexLog(events).restack.reprovision).toMatchObject({ from: A, sha: B, seq: 3 })
    checkIncremental(logIndexReducer, events)
  })

  test('an accept waives the base in use without moving it', () => {
    const events = log([
      provisioned,
      rewritten(A, B),
      {
        actor: KERNEL,
        type: 'target.rewrite-recovered',
        payload: {
          branch: 'main',
          previousSha: A,
          sha: B,
          base: A,
          recovery: 'accepted',
          escalation: 'e1',
        },
      },
    ])
    const index = indexLog(events)
    expect(index.restack.rewriteWaiver).toEqual({ branch: 'main', base: A, seq: 3 })
    expect(leafBaseInUse(index)).toBe(A)
    expect(verifyDiffBaseReducer.reduce(events)).toBe(A)
  })

  test('the episode start survives repeated rewrites of one baseline and resets on another', () => {
    const since = (writes: Omit<EventWrite, 'compatibility'>[]) =>
      reduceBuild(log(writes)).targetRewriteSince
    expect(since([provisioned, rewritten(A, B), rewritten(A, C), rewritten(A, D)])).toBe(2)
    expect(since([provisioned, rewritten(A, B), rewritten(B, C)])).toBe(3)
    expect(since([provisioned, rewritten(A, B), moved(B), rewritten(A, C)])).toBe(4)
    expect(since([provisioned, rewritten(A, B), moved(B)])).toBeUndefined()
    expect(since([provisioned, rewritten(A, B), prepared, reprovisioned])).toBeUndefined()
  })
})

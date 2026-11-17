// Load the reducer registry first: build-runner's import cycle otherwise reaches
// publishedBranchHeadReducer before it is initialized when this file runs alone.
import '../kernel/reducer-registry'
import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  publicationPending,
  publishedBranchHeadReducer,
  verifyDiffBaseReducer,
} from './build-runner'
import { latestUncompletedPublicationRequest, publicationLostRecorded } from './publication-state'

function event(seq: number, type: string, payload: unknown): AbEvent {
  return {
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'kernel' },
    type,
    payload,
  } as AbEvent
}

describe('publicationPending', () => {
  test('parks on an unsettled request and resumes after its matching completion', () => {
    const request = event(4, 'publication.requested', {
      operation: 'implement',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
      round: 1,
      base: 'b'.repeat(40),
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(publicationPending([request])).toBe(true)
    expect(
      publicationPending([
        request,
        event(5, 'implement.completed', {
          round: 1,
          commits: { base: 'b'.repeat(40), head: 'a'.repeat(40) },
          artifact: { kind: 'implement-notes', rev: 0 },
        }),
      ]),
    ).toBe(false)
  })

  test('a later workspace release abandons a request whose SHA died with that workspace', () => {
    const request = event(4, 'publication.requested', {
      operation: 'implement',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
      round: 1,
      base: 'b'.repeat(40),
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(
      publicationPending([
        event(3, 'workspace.provisioned', {
          provider: 'vercel-sandbox',
          ref: 'sandbox-g0',
          remote: true,
          branch: 'ab/build',
          base: { source: 'existing', sha: 'b'.repeat(40) },
        }),
        request,
        event(5, 'workspace.released', {
          provider: 'vercel-sandbox',
          ref: 'sandbox-g0',
          reason: 'replacement',
        }),
        event(6, 'workspace.provisioned', {
          provider: 'vercel-sandbox',
          ref: 'sandbox-g1',
          remote: true,
          branch: 'ab/build',
          base: { source: 'existing', sha: 'b'.repeat(40) },
        }),
      ]),
    ).toBe(false)
  })

  test('does not abandon a request for an unrelated workspace release', () => {
    const provisioned = event(3, 'workspace.provisioned', {
      provider: 'vercel-sandbox',
      ref: 'sandbox-g1',
      remote: true,
      branch: 'ab/build',
      base: { source: 'existing', sha: 'b'.repeat(40) },
    })
    const request = event(4, 'publication.requested', {
      operation: 'implement',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
      round: 1,
      base: 'b'.repeat(40),
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(
      publicationPending([
        provisioned,
        request,
        event(5, 'workspace.released', { ref: 'sandbox-g0', reason: 'replacement' }),
      ]),
    ).toBe(true)
  })

  test('does not accept a later completion for the wrong SHA or implementation round', () => {
    const request = event(4, 'publication.requested', {
      operation: 'implement',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
      round: 2,
      base: 'b'.repeat(40),
      artifact: { kind: 'implement-notes', rev: 1 },
    })
    expect(
      publicationPending([
        request,
        event(5, 'implement.completed', {
          round: 1,
          commits: { base: 'b'.repeat(40), head: 'c'.repeat(40) },
          artifact: { kind: 'implement-notes', rev: 0 },
        }),
      ]),
    ).toBe(true)
  })

  test('a failed finalize-step outcome settles the publication park without a head SHA', () => {
    const request = event(3, 'publication.requested', {
      operation: 'finalize-step',
      step: 'release-notes',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
    })
    const failed = event(4, 'finalize.step-completed', {
      step: 'release-notes',
      ok: false,
      note: 'finalize publication failed: rejected',
    })
    expect(publicationPending([request, failed])).toBe(false)
  })

  test('correlates finalize-step completion by step and sequence', () => {
    const earlier = event(2, 'finalize.step-completed', { step: 'format', ok: true })
    const request = event(3, 'publication.requested', {
      operation: 'finalize-step',
      step: 'format',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
    })
    const other = event(4, 'finalize.step-completed', { step: 'docs', ok: true })
    expect(publicationPending([earlier, request, other])).toBe(true)
    expect(
      publicationPending([
        earlier,
        request,
        other,
        event(5, 'finalize.step-completed', {
          step: 'format',
          ok: true,
          headSha: 'a'.repeat(40),
        }),
      ]),
    ).toBe(false)
  })
})

describe('latestUncompletedPublicationRequest and publicationLostRecorded', () => {
  const request = event(4, 'publication.requested', {
    operation: 'implement',
    branch: 'ab/build',
    sha: 'a'.repeat(40),
    round: 1,
    base: 'b'.repeat(40),
    artifact: { kind: 'implement-notes', rev: 0 },
  })
  const lost = (seq: number, requestSeq: number) =>
    event(seq, 'publication.lost', {
      request: requestSeq,
      operation: 'implement',
      branch: 'ab/build',
      sha: 'a'.repeat(40),
      reason: 'replacement',
    })

  test('selects the latest request without a completion fact', () => {
    const settled = event(5, 'implement.completed', {
      round: 1,
      commits: { base: 'b'.repeat(40), head: 'a'.repeat(40) },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    const later = event(6, 'publication.requested', {
      operation: 'finalize-step',
      step: 'release-notes',
      branch: 'ab/build',
      sha: 'c'.repeat(40),
    })
    expect(latestUncompletedPublicationRequest([request, settled])).toBeUndefined()
    expect(latestUncompletedPublicationRequest([request, settled, later])?.seq).toBe(6)
    expect(latestUncompletedPublicationRequest([request])?.seq).toBe(4)
  })

  test('matches the loss record by the request seq and ignores other requests', () => {
    const asRequest = request as Extract<AbEvent, { type: 'publication.requested' }>
    expect(publicationLostRecorded([request, lost(5, 4)], asRequest)).toBe(true)
    expect(publicationLostRecorded([request, lost(5, 99)], asRequest)).toBe(false)
    expect(publicationLostRecorded([request], asRequest)).toBe(false)
  })
})

describe('wait-resume selectors', () => {
  const BASE = '1'.repeat(40)
  const T1 = '2'.repeat(40)
  const HEAD = '4'.repeat(40)
  const provisioned = event(1, 'workspace.provisioned', {
    provider: 'worktree',
    ref: '/ws/a',
    branch: 'ab/a',
    base: { source: 'remote', sha: BASE },
  })
  const waitRequested = (settlement: 'published' | 'requested') =>
    event(2, 'wait.requested', {
      id: 'wait_1',
      phase: 'implement',
      round: 1,
      tickets: ['B'],
      reason: 'needs B',
      publication: { branch: 'ab/a', base: BASE, sha: HEAD, settlement },
    })

  test('a wait publication is the published head once pushed', () => {
    expect(publishedBranchHeadReducer.reduce([provisioned, waitRequested('published')])).toBe(HEAD)
    expect(
      publishedBranchHeadReducer.reduce([provisioned, waitRequested('requested')]),
    ).toBeUndefined()
    expect(
      publishedBranchHeadReducer.reduce([
        provisioned,
        waitRequested('requested'),
        event(3, 'wait.published', { id: 'wait_1', sha: HEAD }),
      ]),
    ).toBe(HEAD)
  })

  test('a wait request completes on its matching wait.published only', () => {
    const request = event(2, 'publication.requested', {
      operation: 'wait',
      id: 'wait_1',
      branch: 'ab/a',
      sha: HEAD,
      base: BASE,
    })
    expect(publicationPending([provisioned, request])).toBe(true)
    expect(
      publicationPending([
        provisioned,
        request,
        event(3, 'wait.published', { id: 'wait_2', sha: HEAD }),
      ]),
    ).toBe(true)
    expect(
      publicationPending([
        provisioned,
        request,
        event(3, 'wait.published', { id: 'wait_1', sha: HEAD }),
      ]),
    ).toBe(false)
  })

  test('a fast-forward promotes the diff base; a superseded reconcile base never does', () => {
    expect(
      verifyDiffBaseReducer.reduce([
        provisioned,
        event(2, 'restack.advanced', {
          trigger: 'wait-resume',
          cycle: 1,
          observation: 1,
          branch: 'ab/a',
          from: BASE,
          to: T1,
        }),
      ]),
    ).toBe(T1)
    expect(
      verifyDiffBaseReducer.reduce([
        provisioned,
        event(2, 'reconcile.started', { attempt: 1, baseSha: T1 }),
        event(3, 'reconcile.superseded', { attempt: 1, cycle: 1, cause: 'wait-resume' }),
        event(4, 'reconcile.started', { attempt: 2, baseSha: T1 }),
      ]),
    ).toBe(BASE)
  })
})

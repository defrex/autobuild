import { describe, expect, test } from 'bun:test'
import { validateEventWrite, type EventWrite } from './catalog'
import { DISPATCHER, KERNEL, agentActor } from './envelope'
import { normalizeVerifyCompletion } from './payloads'

function plan(payload: unknown): EventWrite<'plan.completed'> {
  return validateEventWrite({
    actor: agentActor('plan', 's_plan'),
    type: 'plan.completed',
    payload,
  }) as EventWrite<'plan.completed'>
}

function verify(payload: unknown): EventWrite<'verify.completed'> {
  return validateEventWrite({
    actor: KERNEL,
    type: 'verify.completed',
    payload,
  }) as EventWrite<'verify.completed'>
}

function finalizeStep(payload: unknown): EventWrite<'finalize.step-completed'> {
  return validateEventWrite({
    actor: agentActor('release-notes', 's_finalize'),
    type: 'finalize.step-completed',
    payload,
  }) as EventWrite<'finalize.step-completed'>
}

describe('PR attachment event protocol', () => {
  const target = {
    provider: 'github-release' as const,
    repository: 'acme/review-assets',
    releaseId: 42,
  }
  const asset = {
    ...target,
    assetId: 7,
    url: 'https://github.com/acme/review-assets/releases/download/review/screenshot.png',
  }

  test('build.created remains backwards-readable and may freeze a strict target', () => {
    const base = {
      ticket: { source: 'linear', id: 'AUT-1' },
      repo: 'acme/app',
      baseBranch: 'main',
    }
    expect(
      validateEventWrite({ actor: DISPATCHER, type: 'build.created', payload: base }).payload,
    ).toEqual(base)
    expect(
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ...base, pr: { imageHost: target } },
      }).payload,
    ).toEqual({ ...base, pr: { imageHost: target } })
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ...base, pr: { imageHost: { ...target, releaseId: 0 } } },
      }),
    ).toThrow(/invalid payload for "build\.created"/)
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ...base, dashboardFrames: target },
      }),
    ).toThrow(/invalid payload for "build\.created"/)
  })

  test('designation, upload, and cleanup facts are strict and actor-owned', () => {
    const designated = validateEventWrite({
      actor: agentActor('verify:visual', 's_visual'),
      type: 'pr-attachment.designated',
      payload: {
        artifact: { kind: 'visual:screenshot', rev: 2 },
        filename: 'screenshot.png',
        mediaType: 'image/png',
      },
    })
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'pr-attachment.designated',
        payload: designated.payload,
      }),
    ).toThrow(/may not emit "pr-attachment\.designated"/)

    const hosted = validateEventWrite({
      actor: KERNEL,
      type: 'pr-attachment.hosted',
      payload: { designationSeq: 8, asset },
    })
    expect(hosted.payload).toEqual({ designationSeq: 8, asset })
    expect(() =>
      validateEventWrite({
        actor: agentActor('finalize', 's_bad'),
        type: 'pr-attachment.hosted',
        payload: hosted.payload,
      }),
    ).toThrow(/may not emit "pr-attachment\.hosted"/)

    expect(
      validateEventWrite({
        actor: DISPATCHER,
        type: 'pr-attachment.reclaimed',
        payload: { hostedSeq: 9 },
      }).payload,
    ).toEqual({ hostedSeq: 9 })
    expect(
      validateEventWrite({
        actor: DISPATCHER,
        type: 'pr-attachment.reclaim-failed',
        payload: { hostedSeq: 9, attempt: 2, error: 'timeout' },
      }).payload,
    ).toEqual({ hostedSeq: 9, attempt: 2, error: 'timeout' })
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'pr-attachment.reclaimed',
        payload: { hostedSeq: 9, extra: true },
      }),
    ).toThrow(/invalid payload for "pr-attachment\.reclaimed"/)
  })
})

describe('finalize outcome attribution', () => {
  test('deterministic checks and agent steps may emit the existing completion and observation facts', () => {
    for (const actor of [KERNEL, agentActor('release-notes', 's_notes')]) {
      expect(
        validateEventWrite({
          actor,
          type: 'finalize.step-completed',
          payload: { step: 'publish', ok: false, note: 'exited 1' },
        }).actor,
      ).toEqual(actor)
      expect(
        validateEventWrite({
          actor,
          type: 'observation.recorded',
          payload: { id: 'o_1', kind: 'followup', summary: 'publish failed' },
        }).actor,
      ).toEqual(actor)
    }

    for (const type of ['finalize.step-completed', 'observation.recorded'] as const) {
      expect(() =>
        validateEventWrite({
          actor: DISPATCHER,
          type,
          payload:
            type === 'finalize.step-completed'
              ? { step: 'publish', ok: true }
              : { id: 'o_1', kind: 'followup', summary: 'publish failed' },
        }),
      ).toThrow(new RegExp(`may not emit "${type.replace('.', '\\.')}`))
    }
  })
})

describe('plan.completed verify selection compatibility', () => {
  const base = { round: 1, artifact: { kind: 'plan', rev: 0 } }

  test('historical payloads without verifySteps remain valid', () => {
    expect(plan(base).payload).toEqual(base)
  })

  test('accepts a canonical list, including an explicit empty selection', () => {
    expect(plan({ ...base, verifySteps: ['types', 'unit'] }).payload).toEqual({
      ...base,
      verifySteps: ['types', 'unit'],
    })
    expect(plan({ ...base, verifySteps: [] }).payload).toEqual({
      ...base,
      verifySteps: [],
    })
  })

  test('rejects malformed and duplicate lists', () => {
    for (const verifySteps of ['types', [1], [''], ['   '], ['types', 'types']]) {
      expect(() => plan({ ...base, verifySteps })).toThrow(/invalid payload for "plan\.completed"/)
    }
  })
})

describe('finalize.step-completed publication checkpoint', () => {
  test('keeps historical/no-op and failed payloads valid', () => {
    expect(finalizeStep({ step: 'release-notes', ok: true }).payload).toEqual({
      step: 'release-notes',
      ok: true,
    })
    expect(finalizeStep({ step: 'release-notes', ok: false, note: 'push failed' }).payload).toEqual(
      { step: 'release-notes', ok: false, note: 'push failed' },
    )
  })

  test('accepts a non-blank pushed head only on success', () => {
    expect(
      finalizeStep({ step: 'release-notes', ok: true, headSha: '  abc123  ' }).payload,
    ).toEqual({ step: 'release-notes', ok: true, headSha: 'abc123' })

    for (const payload of [
      { step: 'release-notes', ok: true, headSha: '' },
      { step: 'release-notes', ok: true, headSha: '   ' },
      { step: 'release-notes', ok: false, headSha: 'abc123' },
    ]) {
      expect(() => finalizeStep(payload)).toThrow(/invalid payload for "finalize\.step-completed"/)
    }
  })
})

describe('verify.completed payload compatibility', () => {
  test('accepts canonical pass and fail outcomes', () => {
    expect(verify({ step: 'types', attempt: 1, outcome: 'pass' }).payload).toEqual({
      step: 'types',
      attempt: 1,
      outcome: 'pass',
    })
    expect(
      verify({
        step: 'unit',
        attempt: 2,
        outcome: 'fail',
        report: { kind: 'verify-report:unit', rev: 0 },
      }).payload,
    ).toEqual({
      step: 'unit',
      attempt: 2,
      outcome: 'fail',
      report: { kind: 'verify-report:unit', rev: 0 },
    })
  })

  test('accepts skipped only with a trimmed, non-blank reason', () => {
    expect(
      verify({ step: 'e2e', attempt: 1, outcome: 'skipped', reason: '  no UI changes  ' }).payload,
    ).toEqual({
      step: 'e2e',
      attempt: 1,
      outcome: 'skipped',
      reason: 'no UI changes',
    })

    for (const reason of [undefined, '', '   ']) {
      expect(() => verify({ step: 'e2e', attempt: 1, outcome: 'skipped', reason })).toThrow(
        /invalid payload for "verify\.completed"/,
      )
    }
  })

  test('strict branches reject mixed or contradictory outcome shapes', () => {
    for (const payload of [
      { step: 'e2e', attempt: 1, outcome: 'skipped', reason: 'not applicable', pass: true },
      { step: 'e2e', attempt: 1, outcome: 'pass', pass: true },
      { step: 'e2e', attempt: 1, outcome: 'fail', reason: 'not applicable' },
      {
        step: 'e2e',
        attempt: 1,
        outcome: 'skipped',
        reason: 'not applicable',
        report: { kind: 'verify-report:e2e', rev: 0 },
      },
    ]) {
      expect(() => verify(payload)).toThrow(/invalid payload for "verify\.completed"/)
    }
  })

  test('historical booleans remain valid and normalize without reinterpretation', () => {
    const pass = verify({ step: 'types', attempt: 1, pass: true }).payload
    const fail = verify({
      step: 'unit',
      attempt: 2,
      pass: false,
      report: { kind: 'verify-report:unit', rev: 3 },
    }).payload

    expect(normalizeVerifyCompletion(pass)).toEqual({
      step: 'types',
      attempt: 1,
      outcome: 'pass',
    })
    expect(normalizeVerifyCompletion(fail)).toEqual({
      step: 'unit',
      attempt: 2,
      outcome: 'fail',
      report: { kind: 'verify-report:unit', rev: 3 },
    })
  })
})

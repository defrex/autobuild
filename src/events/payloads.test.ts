import { describe, expect, test } from 'bun:test'
import { validateEventWrite, type EventWrite } from './catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from './envelope'
import { eventPayloadSchemas, normalizeVerifyCompletion } from './payloads'

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

describe('dispatch recovery event protocol', () => {
  test('dispatch failures are strict, positive-attempt dispatcher facts', () => {
    expect(
      validateEventWrite({
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: { stage: 'workspace', attempt: 2, error: 'forge unavailable' },
      }),
    ).toMatchObject({ type: 'dispatch.failed' })
    expect(() =>
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'dispatch.failed',
        payload: { stage: 'workspace', attempt: 1, error: 'nope' },
      }),
    ).toThrow(/may not emit/)
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: { stage: 'unknown', attempt: 0, error: '', extra: true },
      }),
    ).toThrow(/invalid payload/)
  })

  test('comment completion is a strict dispatcher boundary fact', () => {
    expect(
      validateEventWrite({ actor: DISPATCHER, type: 'dispatch.comment-posted', payload: {} }),
    ).toMatchObject({ type: 'dispatch.comment-posted' })
    expect(() =>
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'dispatch.comment-posted',
        payload: {},
      }),
    ).toThrow(/may not emit/)
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'dispatch.comment-posted',
        payload: { extra: true },
      }),
    ).toThrow(/invalid payload/)
  })

  test('build creation can retain claim-time auto-merge attribution', () => {
    const base = {
      ticket: { source: 'linear', id: 'AUT-1' },
      repo: 'acme/app',
      baseBranch: 'main',
    }
    expect(
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ...base, autoMergeRequestedBy: 'dispatch-op' },
      }).payload,
    ).toEqual({ ...base, autoMergeRequestedBy: 'dispatch-op' })
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ...base, autoMergeRequestedBy: '' },
      }),
    ).toThrow(/invalid payload/)
  })

  test('discard requests are strict human facts', () => {
    expect(
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'build.discard-requested',
        payload: {},
      }),
    ).toMatchObject({ type: 'build.discard-requested' })
    expect(() =>
      validateEventWrite({ actor: DISPATCHER, type: 'build.discard-requested', payload: {} }),
    ).toThrow(/may not emit/)
  })
})

describe('reconcile progress event protocol', () => {
  test('progress checks are strict kernel facts tied to one conflict and completed attempt', () => {
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'reconcile.progress-checked',
        payload: { conflictSeq: 42, attempt: 3, baseSha: 'abc123' },
      }),
    ).toMatchObject({ type: 'reconcile.progress-checked' })
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'reconcile.progress-checked',
        payload: { conflictSeq: 42, attempt: 3, baseSha: 'abc123' },
      }),
    ).toThrow(/may not emit/)
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'reconcile.progress-checked',
        payload: { conflictSeq: 0, attempt: 0, baseSha: '', extra: true },
      }),
    ).toThrow(/invalid payload/)
  })
})

describe('escalation policy-cause protocol', () => {
  const base = {
    id: 'esc_policy',
    phase: 'reconcile',
    source: 'policy',
    question: 'policy exhausted',
  } as const

  test('current policy writes require a recognized cause', () => {
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'escalation.raised',
        payload: { ...base, policyCause: 'reconcile-no-progress' },
      }).payload,
    ).toMatchObject({ policyCause: 'reconcile-no-progress' })
    expect(() =>
      validateEventWrite({ actor: KERNEL, type: 'escalation.raised', payload: base }),
    ).toThrow(/policyCause/)
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'escalation.raised',
        payload: { ...base, policyCause: 'future-unclassified-condition' },
      }),
    ).toThrow(/invalid payload/)
  })

  test('non-policy raises forbid policyCause', () => {
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          ...base,
          source: 'stall',
          policyCause: 'reconcile-no-progress',
        },
      }),
    ).toThrow(/only allowed when source is "policy"/)
  })

  test('persisted payload decoding still accepts a cause-less historical policy raise', () => {
    expect(eventPayloadSchemas['escalation.raised'].parse(base)).toEqual(base)
  })
})

describe('escalation answer protocol', () => {
  test('dispatcher-authored guidance and retry answers are rejected', () => {
    for (const resolution of ['guidance', 'retry'] as const) {
      expect(() =>
        validateEventWrite({
          actor: DISPATCHER,
          type: 'escalation.answered',
          payload: { id: 'esc-policy', answer: resolution, resolution },
        }),
      ).toThrow(/actor kind "dispatcher" may not emit "escalation.answered"/)
    }
  })

  test('review round ceilings are optional positive integers on human answers', () => {
    expect(
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'escalation.answered',
        payload: {
          id: 'esc-rounds',
          answer: 'continue',
          resolution: 'retry',
          reviewRoundCeiling: 12,
        },
      }).payload,
    ).toMatchObject({ reviewRoundCeiling: 12 })
    for (const reviewRoundCeiling of [0, -1, 1.5]) {
      expect(() =>
        validateEventWrite({
          actor: humanActor('operator'),
          type: 'escalation.answered',
          payload: {
            id: 'esc-rounds',
            answer: 'continue',
            resolution: 'retry',
            reviewRoundCeiling,
          },
        }),
      ).toThrow(/invalid payload/)
    }
  })

  test('a human revise-spec answer may authorize an exact artifact revision', () => {
    expect(
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'escalation.answered',
        payload: {
          id: 'esc-spec',
          answer: 'replace the contract',
          resolution: 'revise-spec',
          artifact: { kind: 'spec', rev: 2 },
        },
      }).payload,
    ).toEqual({
      id: 'esc-spec',
      answer: 'replace the contract',
      resolution: 'revise-spec',
      artifact: { kind: 'spec', rev: 2 },
    })
    expect(
      validateEventWrite({
        actor: humanActor('operator'),
        type: 'escalation.answered',
        payload: { id: 'esc-retry', answer: 'retry', resolution: 'retry' },
      }).payload,
    ).not.toHaveProperty('artifact')
  })
})

describe('session ending protocol', () => {
  test('keeps historical transcript endings and accepts strict transcriptless reclamation', () => {
    const completed = {
      session: 's_done',
      transcript: { kind: 'transcript', rev: 2 },
      usage: { inputTokens: 10, outputTokens: 4, turns: 1 },
    }
    expect(
      validateEventWrite({ actor: KERNEL, type: 'session.ended', payload: completed }).payload,
    ).toEqual(completed)

    const reclaimed = {
      session: 's_orphan',
      outcome: 'reclaimed' as const,
      reclaimedBy: { instance: 'runner-2', resumedFromSeq: 41 },
    }
    expect(
      validateEventWrite({ actor: KERNEL, type: 'session.ended', payload: reclaimed }).payload,
    ).toEqual(reclaimed)
  })

  test('reclamation requires takeover evidence and cannot fabricate transcript or usage', () => {
    for (const payload of [
      { session: 's', outcome: 'reclaimed', reclaimedBy: { instance: '', resumedFromSeq: 1 } },
      {
        session: 's',
        outcome: 'reclaimed',
        reclaimedBy: { instance: 'runner-2', resumedFromSeq: -1 },
      },
      {
        session: 's',
        outcome: 'reclaimed',
        reclaimedBy: { instance: 'runner-2', resumedFromSeq: 1 },
        transcript: { kind: 'transcript', rev: 0 },
      },
      {
        session: 's',
        outcome: 'reclaimed',
        reclaimedBy: { instance: 'runner-2', resumedFromSeq: 1 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ]) {
      expect(() => validateEventWrite({ actor: KERNEL, type: 'session.ended', payload })).toThrow(
        /invalid payload/,
      )
    }
  })
})

describe('runner setup failure protocol', () => {
  test('setup failures are strict kernel facts with an explicit unavailable status', () => {
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'runner.setup-failed',
        payload: { command: 'bun install', attempt: 2, exitStatus: 1, output: 'missing package' },
      }).payload,
    ).toEqual({ command: 'bun install', attempt: 2, exitStatus: 1, output: 'missing package' })
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'runner.setup-failed',
        payload: { command: 'bun install', attempt: 1, exitStatus: null, output: 'spawn failed' },
      }).payload,
    ).toMatchObject({ exitStatus: null })
    expect(() =>
      validateEventWrite({
        actor: DISPATCHER,
        type: 'runner.setup-failed',
        payload: { command: 'bun install', attempt: 1, exitStatus: 1, output: '' },
      }),
    ).toThrow(/may not emit/)
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'runner.setup-failed',
        payload: { command: '', attempt: 0, exitStatus: 'unknown', output: '', extra: true },
      }),
    ).toThrow(/invalid payload/)
  })

  test('setup is accepted only as escalation metadata, not as a phase', () => {
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          id: 'esc_setup',
          phase: 'setup',
          source: 'policy',
          policyCause: 'setup-failure-limit',
          question: 'setup is still failing',
        },
      }).payload,
    ).toMatchObject({ phase: 'setup' })
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'phase.failed',
        payload: { phase: 'setup', attempt: 1, error: 'nope', willRetry: false },
      }),
    ).toThrow(/invalid payload/)
  })
})

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

describe('provider alternate evidence', () => {
  const failed = {
    index: 0,
    session: 's_primary',
    runner: 'pi',
    model: 'provider/primary',
    error: 'quota reached',
    cause: 'exhaustion' as const,
  }

  test('accepts substitution starts and exhausted ordered attempts while old payloads stay valid', () => {
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 's_alt',
          role: 'implement',
          runner: 'claude',
          model: 'claude-opus',
          phase: 'implement',
          round: 1,
          substitution: { failed, selectedIndex: 1 },
        },
      }).payload,
    ).toMatchObject({ substitution: { failed, selectedIndex: 1 } })
    expect(
      validateEventWrite({
        actor: KERNEL,
        type: 'phase.failed',
        payload: {
          phase: 'implement',
          round: 1,
          attempt: 1,
          error: 'also unavailable',
          willRetry: true,
          providerAttempts: [
            failed,
            {
              index: 1,
              session: 's_alt',
              runner: 'claude',
              error: 'also unavailable',
              cause: 'availability',
            },
          ],
        },
      }).payload,
    ).toMatchObject({ providerAttempts: [failed, { index: 1 }] })
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'phase.failed',
        payload: {
          phase: 'implement',
          round: 1,
          attempt: 1,
          error: 'bad evidence',
          willRetry: true,
          providerAttempts: [{ ...failed, index: 1 }],
        },
      }),
    ).toThrow(/provider attempt index/)
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 's_alt',
          role: 'implement',
          runner: 'claude',
          phase: 'implement',
          round: 1,
          substitution: { failed, selectedIndex: 2 },
        },
      }),
    ).toThrow(/selectedIndex/)
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

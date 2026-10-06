import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  buildLog,
  checkAgainstReference,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import {
  phaseFailuresReducer,
  publishedBranchHeadReducer,
  selectPublishedBranchHead,
  selectVerifyDiffBase,
  setupStreakReducer,
  verifyDiffBaseReducer,
} from './build-runner'
import { resetsPhaseFailureBudget, type PhaseFailureResetEscalation } from './phase-failure-budget'

const logs = generatedLogs(buildLog, randomBuildItem)

function referenceHead(events: readonly AbEvent[]): string | undefined {
  let head: string | undefined
  for (const event of events) {
    if (event.type === 'implement.completed') head = event.payload.commits.head
    else if (event.type === 'reconcile.completed') head = event.payload.mergeCommit
    else if (
      event.type === 'finalize.step-completed' &&
      event.payload.ok &&
      event.payload.headSha !== undefined
    ) {
      head = event.payload.headSha
    }
  }
  return head
}

function referenceDiffBase(events: readonly AbEvent[]): string | undefined {
  const provisioned = events.find((event) => event.type === 'workspace.provisioned')
  if (provisioned === undefined || provisioned.type !== 'workspace.provisioned') return undefined
  let baseSha = provisioned.payload.base.sha
  let pendingReconcileBase: string | undefined
  for (const event of events) {
    if (event.type === 'reconcile.started') {
      pendingReconcileBase = event.payload.baseSha
    } else if (event.type === 'reconcile.completed') {
      if (pendingReconcileBase !== undefined) baseSha = pendingReconcileBase
      pendingReconcileBase = undefined
    }
  }
  return baseSha
}

function referenceSetupStreak(events: readonly AbEvent[]): number {
  const setupEscalations = new Set<string>()
  let boundary = 0
  for (const event of events) {
    if (event.type === 'runner.attached') boundary = event.seq
    else if (
      event.type === 'escalation.raised' &&
      event.payload.phase === 'setup' &&
      event.payload.source === 'policy'
    ) {
      setupEscalations.add(event.payload.id)
    } else if (event.type === 'escalation.answered' && setupEscalations.has(event.payload.id)) {
      boundary = event.seq
    }
  }
  return events.filter((event) => event.type === 'runner.setup-failed' && event.seq > boundary)
    .length
}

function referencePhaseFailures(events: readonly AbEvent[], phase: string, round: number) {
  const raised = new Map<string, PhaseFailureResetEscalation>()
  let count = 0
  let lastError: string | undefined
  let lastWillRetry: boolean | undefined
  let lastProviderAttempts: unknown
  for (const event of events) {
    switch (event.type) {
      case 'escalation.raised':
        raised.set(event.payload.id, {
          phase: event.payload.phase,
          source: event.payload.source,
          ...(event.payload.policyCause !== undefined
            ? { policyCause: event.payload.policyCause }
            : {}),
          ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
        })
        break
      case 'escalation.answered': {
        const raise = raised.get(event.payload.id)
        if (raise !== undefined && resetsPhaseFailureBudget(raise, phase as never, round)) {
          count = 0
          lastError = undefined
          lastWillRetry = undefined
          lastProviderAttempts = undefined
        }
        break
      }
      case 'phase.failed':
        if (event.payload.phase === phase && event.payload.round === round) {
          count += 1
          lastError = event.payload.error
          lastWillRetry = event.payload.willRetry
          lastProviderAttempts = event.payload.providerAttempts
        }
        break
      default:
        break
    }
  }
  return {
    count,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastWillRetry !== undefined ? { lastWillRetry } : {}),
    ...(lastProviderAttempts !== undefined ? { lastProviderAttempts } : {}),
  }
}

describe('build-runner selector reducers', () => {
  test('selectPublishedBranchHead matches the original', () => {
    checkAgainstReference(publishedBranchHeadReducer, logs, referenceHead)
  })

  test('selectVerifyDiffBase matches the original, including a promotion before the provisioned fact', () => {
    checkAgainstReference(verifyDiffBaseReducer, logs, referenceDiffBase)
    const reordered = buildLog([
      ['reconcile.started', { attempt: 1, baseSha: 'new' }],
      ['reconcile.completed', { mergeCommit: 'm', artifact: {} }],
      [
        'workspace.provisioned',
        { provider: 'p', ref: 'r', branch: 'b', base: { source: 'remote', sha: 'old' } },
      ],
    ])
    expect(selectVerifyDiffBase(reordered)).toBe('new')
    checkAgainstReference(verifyDiffBaseReducer, [reordered], referenceDiffBase)
  })

  test('wrappers throw on a log with no head or base', () => {
    expect(() => selectPublishedBranchHead([])).toThrow('finalize publication requires')
    expect(() => selectVerifyDiffBase([])).toThrow('conditional verify requires')
  })

  test('setupStreak matches the original', () => {
    checkAgainstReference(setupStreakReducer, logs, referenceSetupStreak)
  })

  test('phaseFailures matches the original for every phase and round', () => {
    for (const phase of ['plan', 'implement']) {
      for (const round of [1, 2]) {
        checkAgainstReference(phaseFailuresReducer(phase as never, round), logs, (events) =>
          referencePhaseFailures(events, phase, round),
        )
      }
    }
  })
})

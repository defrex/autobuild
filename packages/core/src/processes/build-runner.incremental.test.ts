// Load the reducer registry first: build-runner's import cycle otherwise reaches
// publishedBranchHeadReducer before it is initialized when this file runs alone.
import '../kernel/reducer-registry'
import { reconcileHead } from '../kernel/reconcile-head'
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
import { buildReadFactsReducer } from '../kernel/read-facts'
import { checkIncremental } from '../kernel/incremental-contract'
import { randomBuildLog } from '../kernel/generators/build-log'
import { resetsPhaseFailureBudget, type PhaseFailureResetEscalation } from './phase-failure-budget'

const logs = generatedLogs(buildLog, randomBuildItem)

function referenceHead(events: readonly AbEvent[]): string | undefined {
  let head: string | undefined
  for (const event of events) {
    if (event.type === 'implement.completed') head = event.payload.commits.head
    else if (event.type === 'reconcile.completed') head = reconcileHead(event.payload)
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

  test('buildReadFacts publishes the verify diff base at every split point', () => {
    const sha = (c: string) => c.repeat(40)
    const provisioned = [
      'workspace.provisioned',
      { provider: 'p', ref: 'r', branch: 'b', base: { source: 'remote', sha: sha('0') } },
    ] as const
    const restack = {
      id: 'r1',
      branch: 'b',
      oldHead: sha('1'),
      oldBase: sha('0'),
      targetBase: sha('2'),
      changeSha: sha('3'),
      workspaceHead: sha('4'),
      localBranchHead: sha('4'),
      trigger: 'verify-entry',
      cycle: 1,
      observation: 1,
      message: 'restack',
      headSha: sha('4'),
    }
    const advanced = {
      trigger: 'wait-resume',
      cycle: 1,
      observation: 1,
      branch: 'b',
      from: sha('0'),
      to: sha('5'),
    }
    const completed = ['reconcile.completed', { mergeCommit: 'm', artifact: { kind: 'n', rev: 0 } }]
    const promotions = [
      [provisioned, ['restack.completed', restack]],
      [provisioned, ['restack.advanced', advanced]],
      [provisioned, ['reconcile.started', { attempt: 1, baseSha: sha('6') }], completed],
      [
        provisioned,
        ['reconcile.started', { attempt: 1, baseSha: sha('7') }],
        ['reconcile.superseded', { attempt: 1, cycle: 1, cause: 'wait-resume' }],
        completed,
      ],
      [provisioned, ['reconcile.started', { attempt: 1, baseSha: sha('8') }]],
    ].map((items) => buildLog(items as [string, Record<string, unknown>][]))
    expect(promotions.map((log) => buildReadFactsReducer.reduce(log).verifyDiffBase)).toEqual([
      sha('2'),
      sha('5'),
      sha('6'),
      sha('0'),
      sha('0'),
    ])
    // A promotion before the provisioned fact still wins.
    const reordered = buildLog([
      ['reconcile.started', { attempt: 1, baseSha: sha('9') }],
      completed as [string, Record<string, unknown>],
      provisioned,
    ])
    expect(buildReadFactsReducer.reduce(reordered).verifyDiffBase).toBe(sha('9'))
    // The schema-valid generated build logs; this file's selector logs are not.
    const built = [1, 2].map((seed) => randomBuildLog(seed, 60))
    for (const log of [...built, ...promotions, reordered]) {
      const expected = verifyDiffBaseReducer.reduce(log)
      expect(buildReadFactsReducer.reduce(log).verifyDiffBase).toBe(expected)
      checkIncremental(buildReadFactsReducer, log, {
        compare: (actual) => expect(actual.verifyDiffBase).toBe(expected),
      })
    }
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

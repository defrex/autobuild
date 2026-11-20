import { expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { leafRestackLog, leafTransaction } from './generators/leaf-restack-log'
import { leafRestackReducer } from './leaf-restack-state'
import { logIndexReducer } from './log-index'
import { buildReadFactsReducer } from './read-facts'
import { checkIncremental } from './incremental-contract'
import { decideNext } from './engine'
import type { AbEvent } from '../events/catalog'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
test = "true"
[verify]
steps = ["unit"]
afterReconcile = false
[verify.unit]
kind = "check"
command = "test"
`)
const event = (log: AbEvent[], type: string, payload: unknown) => [
  ...log,
  { ...log[0]!, seq: log.length + 1, type, payload } as AbEvent,
]

test('one verify-entry gate before every verifier, with immutable review ranges and snapshot parity', () => {
  const log = leafRestackLog()
  expect(decideNext(log.slice(0, 7), config)).toEqual({
    kind: 'restack',
    trigger: 'verify-entry',
    cycle: 6,
  })
  for (let i = 8; i < 12; i++) expect(decideNext(log.slice(0, i), config).kind).toBe('restack')
  expect(decideNext(log, config)).toMatchObject({ kind: 'run-check', attempt: 1 })
  const review = structuredClone(log[4])
  checkIncremental(leafRestackReducer, log)
  checkIncremental(logIndexReducer, log)
  checkIncremental(buildReadFactsReducer, log)
  expect(log[4]).toEqual(review)
})

test('moves coalesce while the active target stays frozen, and never restart a verify cycle', () => {
  let log = leafRestackLog().slice(0, 9)
  log = event(log, 'target.moved', { branch: 'main', sha: 'f'.repeat(40) })
  log = event(log, 'target.moved', { branch: 'main', sha: 'a'.repeat(40) })
  const state = leafRestackReducer.reduce(log)
  expect(state.active?.targetBase).toBe(leafTransaction.targetBase)
  expect(state.target?.sha).toBe('a'.repeat(40))
  expect(decideNext(log, config)).toEqual({ kind: 'restack', trigger: 'verify-entry', cycle: 6 })
  log = event(log, 'restack.completed', { ...leafTransaction, headSha: 'e'.repeat(40) })
  log = event(log, 'verify.started', { step: 'unit', attempt: 1 })
  log = event(log, 'target.moved', { branch: 'main', sha: 'f'.repeat(40) })
  expect(decideNext(log, config)).toMatchObject({ kind: 'run-check', attempt: 1 })
})

test('verify failure appends implementation work and the next approval requires a fresh collapse', () => {
  let log = event(leafRestackLog(), 'verify.completed', {
    step: 'unit',
    attempt: 1,
    outcome: 'fail',
  })
  expect(decideNext(log, config)).toMatchObject({ kind: 'run-phase', phase: 'implement', round: 2 })
  log = event(log, 'implement.completed', {
    round: 2,
    commits: { base: leafTransaction.targetBase, head: 'f'.repeat(40) },
    artifact: { kind: 'implement-notes', rev: 1 },
  })
  log = event(log, 'code-review.verdict', {
    round: 2,
    verdict: 'approve',
    findings: [],
    artifact: { kind: 'code-review', rev: 1 },
  })
  expect(decideNext(log, config)).toEqual({
    kind: 'restack',
    trigger: 'verify-entry',
    cycle: log.length,
  })
})

test('pre-PR conflicts use reconcile and cannot skip initial checks under afterReconcile=false', () => {
  const prepared = leafRestackLog()
  let log = event(
    prepared.slice(0, prepared.findIndex((e) => e.type === 'restack.prepared') + 1),
    'restack.replayed',
    {
      id: leafTransaction.id,
      conflicted: true,
    },
  )
  expect(decideNext(log, config)).toMatchObject({ kind: 'run-phase', phase: 'reconcile', round: 1 })
  log = event(log, 'reconcile.started', {
    attempt: 1,
    baseSha: leafTransaction.targetBase,
    restackId: leafTransaction.id,
  })
  log = event(log, 'reconcile.completed', {
    headSha: 'e'.repeat(40),
    rewriteId: leafTransaction.id,
    artifact: { kind: 'reconcile-notes', rev: 0 },
  })
  log = event(log, 'restack.completed', {
    ...leafTransaction,
    cycle: log.length,
    headSha: 'e'.repeat(40),
  })
  expect(decideNext(log, config)).toMatchObject({ kind: 'run-check', attempt: 1 })
})

test('the entry gate precedes approved-plan exclusions', () => {
  const log = leafRestackLog()
  const plan = log.find((e) => e.type === 'plan.completed')!
  if (plan.type !== 'plan.completed') throw new Error('missing plan')
  plan.payload.verifySteps = []
  expect(decideNext(log.slice(0, 7), config)).toEqual({
    kind: 'restack',
    trigger: 'verify-entry',
    cycle: 6,
  })
  expect(decideNext(log, config)).toMatchObject({ kind: 'skip-verify', step: 'unit' })
})

test('verify entry requires restacking even before any target observation succeeds', () => {
  expect(decideNext(leafRestackLog().slice(0, 6), config)).toEqual({
    kind: 'restack',
    trigger: 'verify-entry',
    cycle: 6,
  })
})

test('declared generated files keep a conflicted replay with the runner until it records regeneration', () => {
  const declared = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
test = "true"
[[generated]]
paths = ["gen.txt"]
command = "true"
[verify]
steps = ["unit"]
afterReconcile = false
[verify.unit]
kind = "check"
command = "test"
`)
  const prepared = leafRestackLog()
  const conflicted = event(
    prepared.slice(0, prepared.findIndex((e) => e.type === 'restack.prepared') + 1),
    'restack.replayed',
    { id: leafTransaction.id, conflicted: true, files: ['gen.txt'] },
  )
  const restack = { kind: 'restack', trigger: 'verify-entry', cycle: 6 } as const
  const reconcile = { kind: 'run-phase', phase: 'reconcile', round: 1 }
  expect(decideNext(conflicted, config)).toMatchObject(reconcile)
  expect(decideNext(conflicted, declared)).toEqual(restack)

  const fact = (outcome: 'resolved' | 'failed' | 'skipped') => ({
    id: leafTransaction.id,
    files: ['gen.txt'],
    commands: [{ command: 'true', files: ['gen.txt'] }],
    outcome,
    ...(outcome === 'resolved' ? { head: 'e'.repeat(40) } : { reason: 'no' }),
  })
  const resolved = event(conflicted, 'restack.regenerated', fact('resolved'))
  expect(decideNext(resolved, declared)).toEqual(restack)
  expect(decideNext(resolved, config)).toEqual(restack)
  for (const outcome of ['failed', 'skipped'] as const)
    expect(
      decideNext(event(conflicted, 'restack.regenerated', fact(outcome)), declared),
    ).toMatchObject(reconcile)
  const started = event(conflicted, 'reconcile.started', {
    attempt: 1,
    baseSha: leafTransaction.targetBase,
    restackId: leafTransaction.id,
  })
  expect(decideNext(started, declared)).toMatchObject(reconcile)

  // A re-pick of the same replay keeps the resolved fact; completion keeps it for status.
  const repicked = event(resolved, 'restack.replayed', {
    id: leafTransaction.id,
    conflicted: true,
    files: ['gen.txt'],
  })
  expect(leafRestackReducer.reduce(repicked).regeneration?.outcome).toBe('resolved')
  const completed = event(repicked, 'restack.completed', {
    ...leafTransaction,
    headSha: 'e'.repeat(40),
  })
  const state = leafRestackReducer.reduce(completed)
  expect(state.regeneration).toBeUndefined()
  expect(state.completedRegeneration?.commands).toEqual([{ command: 'true', files: ['gen.txt'] }])
  checkIncremental(leafRestackReducer, completed)
  const next = event(completed, 'restack.prepared', { ...leafTransaction, id: 'leaf-2' })
  const plain = event(next, 'restack.completed', {
    ...leafTransaction,
    id: 'leaf-2',
    headSha: 'f'.repeat(40),
  })
  expect(leafRestackReducer.reduce(plain).completedRegeneration).toBeUndefined()
})

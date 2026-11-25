import type { BuildTimeline, Segment, StepStats } from '../charts/model'
import { stepStats } from '../charts/model'
import type { SegmentCategory } from '../tokens'

/** Deterministic fixtures shaped like real builds: queue wait, plan and
 * review rounds, implement and code-review rounds, verify, finalize, then
 * the wait for merge. Seeded, so every catalog build renders the same. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const MIN = 60_000
export const NOW = Date.UTC(2026, 10, 23, 16, 0, 0)

const titles = [
  'Throttle repeated failed logins',
  'Page the hosted ticket listing',
  'Resume suspended sessions after a clean stop',
  'Record forge rate limits per credential',
  'Show waits on the build page',
  'Split verify into ordered stages',
  'Keep reopened builds on their branch',
  'Report harvest proposals in watch',
  'Add allowlisted local configuration',
  'Explain escalations in plain words',
]

interface Shape {
  planRounds: number
  codeRounds: number
  escalateAt?: 'plan' | 'implement'
  pausedFor?: number
  reconcile?: boolean
  live?: SegmentCategory
}

function build(i: number, startAt: number, shape: Shape, rand: () => number): BuildTimeline {
  const segs: Segment[] = []
  let t = startAt
  const push = (category: SegmentCategory, minutes: number, round?: number, step?: string) => {
    const end = t + Math.max(0.3, minutes) * MIN
    segs.push({
      category,
      start: t,
      end,
      ...(round !== undefined ? { round } : {}),
      ...(step !== undefined ? { step } : {}),
    })
    t = end
  }
  const live = () => shape.live !== undefined && segs.at(-1)?.category === shape.live
  push('queued', 2 + rand() * 25)
  for (let r = 1; r <= shape.planRounds; r++) {
    push('plan', 4 + rand() * 9, r)
    if (shape.escalateAt === 'plan' && r === 1) push('escalated', 20 + rand() * 90)
    push('plan-review', 3 + rand() * 6, r)
  }
  for (let r = 1; r <= shape.codeRounds; r++) {
    push('implement', 12 + rand() * 40, r)
    if (live()) break
    if (shape.escalateAt === 'implement' && r === 1) push('escalated', 30 + rand() * 120)
    if (shape.pausedFor !== undefined && r === 1) push('paused', shape.pausedFor)
    push('code-review', 4 + rand() * 10, r)
  }
  if (!live()) {
    push('verify', 6 + rand() * 14, undefined, 'verify:unit')
    if (shape.reconcile) {
      push('reconcile', 3 + rand() * 6)
      push('verify', 6 + rand() * 10, undefined, 'verify:unit')
    }
    push('finalize', 1 + rand() * 3)
    push('awaiting-merge', 3 + rand() * 40)
  }
  const last = segs.at(-1)
  const running = shape.live !== undefined
  if (running && last !== undefined) delete last.end
  return {
    slug: `build-${String(i + 1).padStart(3, '0')}`,
    ticket: `#${1040 + i}`,
    title: titles[i % titles.length] ?? 'Untitled',
    outcome: running ? 'running' : 'merged',
    segments: segs,
  }
}

export function fixtureBuilds(count: number, seed = 7): BuildTimeline[] {
  const rand = rng(seed)
  const out: BuildTimeline[] = []
  const span = count <= 10 ? 9 * 60 * MIN : 6 * 24 * 60 * MIN
  for (let i = 0; i < count; i++) {
    const startAt = NOW - span + (i / count) * span * 0.85 + rand() * 30 * MIN
    const shape: Shape = {
      planRounds: rand() < 0.25 ? 2 : 1,
      codeRounds: rand() < 0.35 ? (rand() < 0.3 ? 3 : 2) : 1,
      ...(i % 9 === 4 ? { escalateAt: 'implement' as const } : {}),
      ...(i % 11 === 2 ? { escalateAt: 'plan' as const } : {}),
      ...(i % 13 === 6 ? { pausedFor: 25 } : {}),
      ...(i % 5 === 3 ? { reconcile: true } : {}),
      ...(i >= count - 2 ? { live: 'implement' as const } : {}),
    }
    out.push(build(i, startAt, shape, rand))
  }
  return out.reverse()
}

const verifySteps = ['verify:unit', 'verify:integration', 'verify:build', 'verify:docs'] as const

export function fixtureStepStats(builds: readonly BuildTimeline[]): StepStats[] {
  const by = new Map<string, { category: SegmentCategory; durations: number[] }>()
  const add = (step: string, category: SegmentCategory, ms: number) => {
    const entry = by.get(step) ?? { category, durations: [] }
    entry.durations.push(ms)
    by.set(step, entry)
  }
  let k = 0
  for (const b of builds) {
    for (const s of b.segments) {
      if (s.end === undefined) continue
      const ms = s.end - s.start
      if (s.category === 'verify') {
        for (const v of verifySteps) add(v, 'verify', ms * (0.35 + ((k++ * 37) % 60) / 100))
      } else add(s.category, s.category, ms)
    }
  }
  return [...by.entries()].map(([step, { category, durations }]) =>
    stepStats(step, category, durations),
  )
}

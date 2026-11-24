import { expect, test } from 'bun:test'
import { z } from 'zod'
import type { EventEnvelope } from '../events/catalog'
import { humanActor } from '../events/envelope'
import { autoMergeDeferralObservation, pendingAutoMerge } from '../kernel/auto-merge'
import { FakeForge } from '../ports/forge/fake'
import { readBuildFacts } from '../store/reduced-reads'
import { completeFinalizePr, renderFindingsIssues } from './terminals'
import { BUILD, BRANCH, makeDeps, makeEnv, seedStore } from './testkit'

test('findings issue rendering expands a synthetic untagged union with complete paths', () => {
  // Renderer-contract seam only: `findingDraftSchema` cannot currently
  // produce this union issue, and this fixture does not widen that schema.
  const fixture = z.strictObject({
    reviews: z.array(
      z.strictObject({
        detail: z.union([
          z.object({ left: z.custom(() => false, 'left alternative rejected') }),
          z.object({ right: z.custom(() => false, 'right alternative rejected') }),
        ]),
      }),
    ),
  })
  const result = fixture.safeParse({ reviews: [{ detail: { left: 1, right: 2 } }] })
  if (result.success) throw new Error('renderer fixture must fail')

  const rendered = renderFindingsIssues(result.error.issues)

  expect(rendered).toBe(
    '  reviews.0.detail.left: option 1 of 2: left alternative rejected\n' +
      '  reviews.0.detail.right: option 2 of 2: right alternative rejected',
  )
  expect(rendered).not.toContain('Invalid input')
})

test.each([
  'ungated clean',
  'ungated transient',
  'disabled',
  'existing deferral',
  'conflicted',
  'withdrawal',
] as const)('finalize delegates native consent: %s', async (variant) => {
  const store = await seedStore()
  const command = await store.append(BUILD, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  let existing: EventEnvelope<'observation.recorded'> | undefined
  if (variant === 'existing deferral') {
    existing = await store.append(
      BUILD,
      autoMergeDeferralObservation(
        { code: 'repository-auto-merge-disabled', detail: 'already recorded' },
        1,
        command.seq,
        'obs_existing',
      ),
    )
  }
  class HandoffForge extends FakeForge {
    override async openPr(opts: Parameters<FakeForge['openPr']>[0]) {
      const pr = await super.openPr(opts)
      if (variant === 'ungated clean')
        this.setPrState(pr.number, { state: 'open', mergeable: true })
      if (variant === 'disabled' || variant === 'existing deferral') {
        this.setRepositoryAutoMergeDisabled(pr.number, 'allow_auto_merge is false')
      }
      if (variant === 'conflicted') {
        this.setPrState(pr.number, { state: 'open', mergeable: false })
        this.setAutoMergeDeferral(pr.number, {
          code: 'merge-conflicts',
          detail: 'head conflicts with main',
        })
      }
      if (variant === 'withdrawal')
        await store.append(BUILD, {
          actor: humanActor('operator'),
          type: 'build.auto-merge-cancelled',
          payload: {},
        })
      return pr
    }
  }
  const forge = new HandoffForge({
    gatePresence: variant.startsWith('ungated') ? 'absent' : 'present',
  })
  const deps = makeDeps({
    store,
    env: makeEnv({ phase: 'finalize' }),
    forge,
    exec: async () => {
      throw new Error('finalize handoff must not execute Git')
    },
  })
  const event = await completeFinalizePr(deps, (await readBuildFacts(store, BUILD)).value, {
    branch: BRANCH,
    baseBranch: 'main',
    title: 'Add auth rate limiting',
    body: 'Body.',
    mergeMessage: 'Body.',
  })
  expect(event.type).toBe('finalize.completed')
  expect(forge.autoMergeCalls).toEqual([])
  expect(forge.squashMergeCalls).toEqual([])
  const events = await store.getEvents(BUILD)
  const types = events.map((e) => e.type)
  expect(types).not.toContain('pr.auto-merge-enabled')
  expect(types).not.toContain('pr.auto-merge-disabled')
  expect(types).not.toContain('escalation.raised')
  expect(events.filter((e) => e.type === 'observation.recorded')).toEqual(
    existing ? [existing] : [],
  )
  if (variant === 'withdrawal') {
    expect(events.find((e) => e.type === 'build.auto-merge-cancelled')!.seq).toBeGreaterThan(
      command.seq,
    )
  }
  expect(pendingAutoMerge((await readBuildFacts(store, BUILD)).value.state)).toEqual({
    enabled: variant !== 'withdrawal',
    commandSeq:
      variant === 'withdrawal'
        ? events.find((e) => e.type === 'build.auto-merge-cancelled')!.seq
        : command.seq,
  })
  await store.close()
})

import { describe, expect, test } from 'bun:test'
import type { Forge, PrRef } from '../types'

export interface ForgeContractFactoryOptions {
  /** Install/represent a real merge-blocking gate on the temporary base. */
  gated?: boolean
}

/** Fixture controls arrange provider lifecycle that the Forge port does not
 * expose. Probes are independent of the port call under assertion. */
export interface ForgeContractControls {
  remoteHead(branch: string): Promise<string>
  prepareMergeable(number: number): Promise<void>
  closePr(number: number): Promise<void>
  makeConflict(number: number): Promise<void>
  advanceHead(number: number): Promise<string>
  nativeAutoMergeEnabled(number: number): Promise<boolean>
  commentExists(number: number, body: string): Promise<boolean>
  mergeSha(number: number): Promise<string>
  trackPr(number: number): Promise<void> | void
}

export interface ForgeContractHarness {
  forge: Forge
  /** Whether this provider exposes a native gated auto-merge setting. Local
   * forges may support only the universal ungated guarded-squash path. */
  nativeAutoMerge?: boolean
  workspacePath: string
  head: string
  base: string
  title: string
  body: string
  controls: ForgeContractControls
  cleanup?: () => Promise<void>
}

export type ForgeContractFactory = (
  opts?: ForgeContractFactoryOptions,
) => Promise<ForgeContractHarness>

async function withForge(
  factory: ForgeContractFactory,
  opts: ForgeContractFactoryOptions | undefined,
  run: (harness: ForgeContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(opts)
  let failure: unknown
  try {
    await run(harness)
  } catch (error) {
    failure = error
  }

  try {
    await harness.cleanup?.()
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, cleanupError],
        'Forge contract assertion and cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (failure !== undefined) throw failure
}

async function pushAndOpen(harness: ForgeContractHarness): Promise<{
  pr: PrRef
  remoteHead: string
}> {
  await harness.forge.pushBranch(harness.workspacePath, harness.head)
  const remoteHead = await harness.controls.remoteHead(harness.head)
  const pr = await harness.forge.openPr({
    workspacePath: harness.workspacePath,
    head: harness.head,
    base: harness.base,
    title: harness.title,
    body: harness.body,
    mergeMessage: `${harness.title}\n\n${harness.body}`,
  })
  await harness.controls.trackPr(pr.number)
  return { pr, remoteHead }
}

/**
 * Reusable Forge semantics. Live fixtures manipulate only UUID-namespaced
 * scratch branches/PRs; fake controls arrange the same states without changing
 * the expected answers declared here.
 */
export function describeForgeContract(name: string, factory: ForgeContractFactory): void {
  describe(`Forge contract: ${name}`, () => {
    test('optional observation scope preserves concurrent reads and fresh mutation readback', async () => {
      await withForge(
        factory,
        undefined,
        async ({ forge, workspacePath, head, base, title, body }) => {
          if (!forge.withReadScope || !forge.closePr) return
          const pr = await forge.openPr({ workspacePath, head, base, title, body })
          await forge.withReadScope(async () => {
            const states = await Promise.all([
              forge.getPrState(workspacePath, pr.number),
              forge.getPrState(workspacePath, pr.number),
            ])
            expect(states[0]).toEqual(states[1])
            await forge.closePr!(workspacePath, pr.number)
            expect((await forge.getPrState(workspacePath, pr.number)).state).toBe('closed')
          })
          await forge.withReadScope(async () => {
            expect((await forge.getPrState(workspacePath, pr.number)).state).toBe('closed')
          })
          await expect(
            forge.withReadScope(async () => {
              throw new Error('scope teardown')
            }),
          ).rejects.toThrow('scope teardown')
          expect((await forge.getPrState(workspacePath, pr.number)).state).toBe('closed')
        },
      )
    })

    test('optional request observation registers and disposes without requiring legacy adapters', async () => {
      await withForge(factory, undefined, async ({ forge }) => {
        if (!forge.observeRequests) return
        const stop = forge.observeRequests((context) => {
          expect(context.build === undefined || typeof context.build === 'string').toBe(true)
        })
        expect(typeof stop).toBe('function')
        stop()
      })
    })

    test('optional node refs open empty without a PR and retries preserve their head', async () => {
      await withForge(factory, undefined, async (h) => {
        const forge = h.forge
        if (!forge.createNodeBranch || !forge.compareBranches || !forge.remoteBranchSha) return
        await forge.pushBranch(h.workspacePath, h.head)
        const opening = await forge.remoteBranchSha(h.head)
        const branch = `ab-node/contract-${crypto.randomUUID()}`
        try {
          expect(await forge.createNodeBranch(branch, opening)).toBe(opening)
          expect(await forge.createNodeBranch(branch, opening)).toBe(opening)
          expect(await forge.compareBranches(h.head, branch)).toEqual({
            parentSha: opening,
            headSha: opening,
            ahead: 0,
          })
        } finally {
          if (forge.deleteBranch) await forge.deleteBranch(h.workspacePath, branch)
        }
      })
    })
    test('optional retarget preserves review identity and acknowledges the new base idempotently', async () => {
      await withForge(factory, undefined, async (h) => {
        const forge = h.forge
        if (
          !forge.retargetPr ||
          !forge.createNodeBranch ||
          !forge.inspectLandingPr ||
          !forge.remoteBranchSha
        )
          return
        const { pr } = await pushAndOpen(h)
        const branch = `ab-node/retarget-${crypto.randomUUID()}`
        await forge.createNodeBranch(branch, await forge.remoteBranchSha(h.base))
        try {
          await forge.setAutoMerge(h.workspacePath, pr.number, false)
          await forge.retargetPr(h.workspacePath, pr.number, branch)
          await forge.retargetPr(h.workspacePath, pr.number, branch)
          expect(await forge.inspectLandingPr(h.workspacePath, pr.number)).toMatchObject({
            base: branch,
            head: h.head,
            open: true,
          })
        } finally {
          await h.controls.closePr(pr.number)
          await forge.deleteBranch?.(h.workspacePath, branch)
        }
      })
    })
    test('optional rewrite snapshots the authoritative head and refuses a stale lease', async () => {
      await withForge(factory, undefined, async (harness) => {
        const capability = harness.forge.rewrite
        if (capability === undefined) return
        const { remoteHead } = await pushAndOpen(harness)
        expect(
          await capability.snapshot({
            workspacePath: harness.workspacePath,
            branch: harness.head,
            destinationRef: 'refs/autobuild/reconcile/contract-probe/head',
          }),
        ).toBe(remoteHead)
        expect(
          await capability.replace({
            workspacePath: harness.workspacePath,
            branch: harness.head,
            expected: '0'.repeat(40),
            sha: 'e'.repeat(40),
          }),
        ).toEqual({ kind: 'lease-mismatch', actual: remoteHead })
        expect(await harness.controls.remoteHead(harness.head)).toBe(remoteHead)
      })
    })

    test('pushBranch publishes the head and openPr returns/adopts the actual PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr, remoteHead } = await pushAndOpen(harness)
        expect(pr.number).toBeGreaterThan(0)
        expect(pr.url.trim()).not.toBe('')
        expect(pr.headSha).toBe(remoteHead)
        expect(harness.forge.confirmPublication).toBeDefined()
        expect(
          await harness.forge.confirmPublication!(harness.workspacePath, harness.head, remoteHead),
        ).toBe(true)
        expect(
          await harness.forge.confirmPublication!(
            harness.workspacePath,
            harness.head,
            '0'.repeat(40),
          ),
        ).toBe(false)
        expect(await harness.controls.remoteHead(harness.head)).toBe(remoteHead)

        const retry = await harness.forge.openPr({
          workspacePath: harness.workspacePath,
          head: harness.head,
          base: harness.base,
          title: `${harness.title} retry must adopt`,
          body: 'retry body must not create another PR',
          mergeMessage: 'retry merge message must not replace the original',
        })
        expect(retry).toEqual(pr)
      })
    })

    test('getPrState discriminates an open mergeable PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toMatchObject({
          state: 'open',
          mergeable: true,
        })
      })
    })

    test('getPrState discriminates an open conflict', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.makeConflict(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toMatchObject({
          state: 'open',
          mergeable: false,
        })
      })
    })

    test('getPrState discriminates a closed PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.closePr(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual({
          state: 'closed',
        })
      })
    })

    test('getPrState discriminates a merged PR with its independently observed merge SHA', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        const candidate = await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true)
        expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
        await harness.forge.squashMerge(harness.workspacePath, pr.number, pr.headSha)
        const landingSha = await harness.controls.mergeSha(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual({
          state: 'merged',
          sha: landingSha,
        })
      })
    })

    test('identity-aware squash exposes the actual merged trailer when inspection is supported', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        await harness.forge.squashMerge(harness.workspacePath, pr.number, pr.headSha, {
          buildSlug: 'contract-build',
        })
        const sha = await harness.controls.mergeSha(pr.number)
        if (harness.forge.readCommitMessage !== undefined) {
          expect(await harness.forge.readCommitMessage(harness.workspacePath, sha)).toContain(
            'Autobuild-Build: contract-build',
          )
        }
      })
    })

    test('setAutoMerge acknowledges native state and is idempotent', async () => {
      await withForge(factory, { gated: true }, async (harness) => {
        if (harness.nativeAutoMerge === false) return
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(false)

        expect(await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true)).toEqual({
          kind: 'applied',
        })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(true)

        expect(await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true)).toEqual({
          kind: 'applied',
        })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(true)

        expect(await harness.forge.setAutoMerge(harness.workspacePath, pr.number, false)).toEqual({
          kind: 'applied',
        })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(false)
      })
    })

    test('squashMerge rejects a moved head and merges only the matching head', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        const inspected = await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true)
        expect(inspected).toEqual({ kind: 'ungated', headSha: pr.headSha })

        const advancedHead = await harness.controls.advanceHead(pr.number)
        expect(advancedHead).not.toBe(pr.headSha)
        await expect(
          harness.forge.squashMerge(harness.workspacePath, pr.number, pr.headSha),
        ).rejects.toThrow()
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toMatchObject({
          state: 'open',
          mergeable: true,
        })

        const refreshed = await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true)
        expect(refreshed).toEqual({ kind: 'ungated', headSha: advancedHead })
        await harness.forge.squashMerge(harness.workspacePath, pr.number, advancedHead)
        const landingSha = await harness.controls.mergeSha(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual({
          state: 'merged',
          sha: landingSha,
        })
      })
    })

    test('closePr is idempotent and preserves merged PRs', async () => {
      await withForge(factory, undefined, async (harness) => {
        expect(harness.forge.closePr).toBeDefined()
        const { pr } = await pushAndOpen(harness)
        expect(await harness.forge.closePr!(harness.workspacePath, pr.number)).toEqual({
          state: 'closed',
        })
        expect(await harness.forge.closePr!(harness.workspacePath, pr.number)).toEqual({
          state: 'closed',
        })

        const merged = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(merged.pr.number)
        const candidate = await harness.forge.setAutoMerge(
          harness.workspacePath,
          merged.pr.number,
          true,
        )
        expect(candidate).toEqual({ kind: 'ungated', headSha: merged.pr.headSha })
        await harness.forge.squashMerge(harness.workspacePath, merged.pr.number, merged.pr.headSha)
        const sha = await harness.controls.mergeSha(merged.pr.number)
        expect(await harness.forge.closePr!(harness.workspacePath, merged.pr.number)).toEqual({
          state: 'merged',
          sha,
        })
      })
    })

    test('deleteBranch removes the exact published branch and is idempotent', async () => {
      await withForge(factory, undefined, async (harness) => {
        expect(harness.forge.deleteBranch).toBeDefined()
        await harness.forge.pushBranch(harness.workspacePath, harness.head)
        await harness.forge.deleteBranch!(harness.workspacePath, harness.head)
        await expect(harness.controls.remoteHead(harness.head)).rejects.toThrow()
        await harness.forge.deleteBranch!(harness.workspacePath, harness.head)
      })
    })

    test('commentOnPr delivers the exact unique body', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        const body = `Autobuild forge contract comment ${crypto.randomUUID()}`
        await harness.forge.commentOnPr(harness.workspacePath, pr.number, body)
        expect(await harness.controls.commentExists(pr.number, body)).toBe(true)
      })
    })
  })
}

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
  })
  await harness.controls.trackPr(pr.number)
  return { pr, remoteHead }
}

/**
 * Reusable Forge semantics. Live fixtures manipulate only UUID-namespaced
 * scratch branches/PRs; fake controls arrange the same states without changing
 * the expected answers declared here.
 */
export function describeForgeContract(
  name: string,
  factory: ForgeContractFactory,
): void {
  describe(`Forge contract: ${name}`, () => {
    test('pushBranch publishes the head and openPr returns/adopts the actual PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr, remoteHead } = await pushAndOpen(harness)
        expect(pr.number).toBeGreaterThan(0)
        expect(pr.url).toMatch(/^https?:\/\//)
        expect(pr.headSha).toBe(remoteHead)

        const retry = await harness.forge.openPr({
          workspacePath: harness.workspacePath,
          head: harness.head,
          base: harness.base,
          title: `${harness.title} retry must adopt`,
          body: 'retry body must not create another PR',
        })
        expect(retry).toEqual(pr)
      })
    })

    test('getPrState discriminates an open mergeable PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'open', mergeable: true },
        )
      })
    })

    test('getPrState discriminates an open conflict', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.makeConflict(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'open', mergeable: false },
        )
      })
    })

    test('getPrState discriminates a closed PR', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.closePr(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'closed' },
        )
      })
    })

    test('getPrState discriminates a merged PR with its independently observed landing SHA', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        const candidate = await harness.forge.setAutoMerge(
          harness.workspacePath,
          pr.number,
          true,
        )
        expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
        await harness.forge.squashMerge(
          harness.workspacePath,
          pr.number,
          pr.headSha,
        )
        const landingSha = await harness.controls.mergeSha(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'merged', sha: landingSha },
        )
      })
    })

    test('setAutoMerge acknowledges native state and is idempotent', async () => {
      await withForge(factory, { gated: true }, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(false)

        expect(
          await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true),
        ).toEqual({ kind: 'applied' })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(true)

        expect(
          await harness.forge.setAutoMerge(harness.workspacePath, pr.number, true),
        ).toEqual({ kind: 'applied' })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(true)

        expect(
          await harness.forge.setAutoMerge(harness.workspacePath, pr.number, false),
        ).toEqual({ kind: 'applied' })
        expect(await harness.controls.nativeAutoMergeEnabled(pr.number)).toBe(false)
      })
    })

    test('squashMerge rejects a moved head and merges only the matching head', async () => {
      await withForge(factory, undefined, async (harness) => {
        const { pr } = await pushAndOpen(harness)
        await harness.controls.prepareMergeable(pr.number)
        const inspected = await harness.forge.setAutoMerge(
          harness.workspacePath,
          pr.number,
          true,
        )
        expect(inspected).toEqual({ kind: 'ungated', headSha: pr.headSha })

        const advancedHead = await harness.controls.advanceHead(pr.number)
        expect(advancedHead).not.toBe(pr.headSha)
        await expect(
          harness.forge.squashMerge(
            harness.workspacePath,
            pr.number,
            pr.headSha,
          ),
        ).rejects.toThrow()
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'open', mergeable: true },
        )

        const refreshed = await harness.forge.setAutoMerge(
          harness.workspacePath,
          pr.number,
          true,
        )
        expect(refreshed).toEqual({ kind: 'ungated', headSha: advancedHead })
        await harness.forge.squashMerge(
          harness.workspacePath,
          pr.number,
          advancedHead,
        )
        const landingSha = await harness.controls.mergeSha(pr.number)
        expect(await harness.forge.getPrState(harness.workspacePath, pr.number)).toEqual(
          { state: 'merged', sha: landingSha },
        )
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

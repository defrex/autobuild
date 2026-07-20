import { describe, expect, test } from 'bun:test'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WorkspaceBase } from '../../ontology'
import type { WorkspaceProvider } from '../types'

export interface WorkspaceProviderContractHarness {
  provider: WorkspaceProvider
  provision: Parameters<WorkspaceProvider['provision']>[0]
  /** The exact commit-selection evidence the first provision must return. */
  expectedBase: WorkspaceBase
  fixture: { relativePath: string; content: string }
  cleanup?: () => Promise<void>
}

export type WorkspaceProviderContractFactory =
  () => Promise<WorkspaceProviderContractHarness>

async function withWorkspace(
  factory: WorkspaceProviderContractFactory,
  run: (harness: WorkspaceProviderContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory()
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
        'WorkspaceProvider contract assertion and cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (failure !== undefined) throw failure
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Common working-copy semantics for both the fake and git-worktree adapter. */
export function describeWorkspaceProviderContract(
  name: string,
  factory: WorkspaceProviderContractFactory,
): void {
  describe(`WorkspaceProvider contract: ${name}`, () => {
    test('provision returns a usable requested-branch working copy and selected base', async () => {
      await withWorkspace(factory, async (harness) => {
        const result = await harness.provider.provision(harness.provision)
        expect(result.provider).toBe(harness.provider.name)
        expect(result.branch).toBe(harness.provision.branch)
        expect(result.ref).not.toBe('')
        expect(isAbsolute(result.path)).toBe(true)
        expect((await stat(result.path)).isDirectory()).toBe(true)
        expect(
          await readFile(join(result.path, harness.fixture.relativePath), 'utf8'),
        ).toBe(harness.fixture.content)
        expect(result.base).toEqual(harness.expectedBase)

        const writeProbe = join(result.path, 'contract-write-probe.txt')
        await writeFile(writeProbe, 'workspace is writable\n')
        expect(await readFile(writeProbe, 'utf8')).toBe('workspace is writable\n')
        await harness.provider.release(result)
      })
    })

    test('intact reprovision is non-destructive and reports the existing branch base', async () => {
      await withWorkspace(factory, async (harness) => {
        const first = await harness.provider.provision(harness.provision)
        const writeProbe = join(first.path, 'contract-reprovision-probe.txt')
        await writeFile(writeProbe, 'preserve in-progress work\n')

        const reprovisioned = await harness.provider.provision(harness.provision)
        expect(reprovisioned.path).toBe(first.path)
        expect(reprovisioned.branch).toBe(harness.provision.branch)
        expect(reprovisioned.base).toEqual({
          source: 'existing',
          sha: first.base.sha,
        })
        expect(await readFile(writeProbe, 'utf8')).toBe(
          'preserve in-progress work\n',
        )

        await harness.provider.release(reprovisioned)
      })
    })

    test('reprovision rematerializes a working copy deleted out of band', async () => {
      await withWorkspace(factory, async (harness) => {
        const first = await harness.provider.provision(harness.provision)
        await rm(first.path, { recursive: true, force: true })
        expect(await exists(first.path)).toBe(false)

        const reprovisioned = await harness.provider.provision(harness.provision)
        expect(reprovisioned.path).toBe(first.path)
        expect(reprovisioned.branch).toBe(harness.provision.branch)
        expect((await stat(reprovisioned.path)).isDirectory()).toBe(true)
        expect(
          await readFile(
            join(reprovisioned.path, harness.fixture.relativePath),
            'utf8',
          ),
        ).toBe(harness.fixture.content)
        expect(reprovisioned.base).toEqual({
          source: 'existing',
          sha: first.base.sha,
        })

        const writeProbe = join(reprovisioned.path, 'contract-recovery-probe.txt')
        await writeFile(writeProbe, 'recovered workspace is writable\n')
        expect(await readFile(writeProbe, 'utf8')).toBe(
          'recovered workspace is writable\n',
        )
        await harness.provider.release(reprovisioned)
      })
    })

    test('release removes/releases the handle and is safe to call twice', async () => {
      await withWorkspace(factory, async (harness) => {
        const result = await harness.provider.provision(harness.provision)
        expect(await exists(result.path)).toBe(true)

        await harness.provider.release(result)
        expect(await exists(result.path)).toBe(false)
        await harness.provider.release(result)
        expect(await exists(result.path)).toBe(false)
      })
    })
  })
}

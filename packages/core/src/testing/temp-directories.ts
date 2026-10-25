import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeGitRemoteUrl } from '../kernel/origin'
import { mkdtemp, rm, rmdir } from 'node:fs/promises'

/** Register ownership before fixture setup can throw. Create one allocator per
 * test file/suite, passing its afterEach hook. Existing earlier cleanup is safe. */
export function temporaryDirectories(afterEach: (cleanup: () => Promise<void>) => unknown) {
  const paths = new Set<string>()
  afterEach(async () => {
    const owned = [...paths]
    paths.clear()
    const results = await Promise.allSettled(
      owned.map((path) => rm(path, { recursive: true, force: true })),
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (errors.length) throw new AggregateError(errors, 'Test temporary directory cleanup failed')
  })
  return async (prefix: string): Promise<string> => {
    const path = await mkdtemp(prefix)
    paths.add(path)
    return path
  }
}

/** Origin-mode dispatch creates a deterministic scratch path without mkdtemp.
 * Tests own only the repository identities they exercise, never the shared parent. */
export function temporaryOriginScratch(afterEach: (cleanup: () => Promise<void>) => unknown) {
  const paths = new Set<string>()
  let ownsParent = false
  afterEach(async () => {
    await Promise.all([...paths].map((path) => rm(path, { recursive: true, force: true })))
    paths.clear()
    if (ownsParent) {
      try {
        await rmdir(join(tmpdir(), 'autobuild'))
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
      }
      ownsParent = false
    }
  })
  return (repository: string) => {
    const parent = join(tmpdir(), 'autobuild')
    ownsParent ||= !existsSync(parent)
    paths.add(
      join(
        parent,
        createHash('sha256').update(normalizeGitRemoteUrl(repository)).digest('hex').slice(0, 16),
      ),
    )
  }
}

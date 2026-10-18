import { readRepositoryFacts } from '../store/reduced-reads'
import { resolveRepoState, isRemoteStoreRef } from './repo-state'
import { readFile, rename, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseConfig } from '../config/load'
import type { Exec } from '../ports/workspace/git-worktree'
import { openSessionlessStore, type StoreOpener } from './store-opening'

/** Upgrade samples the destination repository's journal, never ambient AB_STORE. */
export async function migrateLandingPolicy(opts: {
  targetRepo: string
  exec: Exec
  env?: Record<string, string | undefined>
  openStore?: StoreOpener
}): Promise<{ changed: boolean; legacyDefault?: boolean }> {
  const path = join(opts.targetRepo, 'autobuild.toml')
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `Landing policy migration requires readable ${path}; restore its configuration and retry ab upgrade`,
    )
  }
  // Parsing proves that the explicit array is valid; retain its exact bytes.
  parseConfig(source, path)
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>
  if (Object.hasOwn(parsed, 'landing')) return { changed: false }
  let enabled = false
  try {
    const paths = await resolveRepoState({ targetRepo: opts.targetRepo, exec: opts.exec })
    let journalAbsent = false
    if (!opts.openStore && !isRemoteStoreRef(paths.storeRef)) {
      try {
        await access(join(paths.storeRef, 'autobuild.sqlite'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        journalAbsent = true
      }
    }
    if (!journalAbsent) {
      const context = await openSessionlessStore({
        ...opts,
        env: { ...(opts.env ?? process.env), AB_STORE: undefined },
      })
      try {
        const facts = await readRepositoryFacts(context.store, context.repo)
        enabled = facts.value.autoMerge.latest?.enabled ?? false
      } finally {
        await context.store.close()
      }
    }
  } catch (error) {
    throw new Error(
      `Cannot read the target repository's legacy auto-merge journal; restore store access and retry ab upgrade, or configure explicit [[landing]] rules (landing = [] selects the new defaults): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const result = `${source.replace(/\n?$/, '\n')}\n# Migrated from the durable auto-merge default. First matching rule wins.\n[[landing]]\nfrom = "leaf"\nmode = "${enabled ? 'auto' : 'consent'}"\n\n[[landing]]\nfrom = "node"\nmode = "consent"\n`
  parseConfig(result, path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, result)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return { changed: true, legacyDefault: enabled }
}

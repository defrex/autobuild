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
      `Merge policy migration requires readable ${path}; restore its configuration and retry ab upgrade`,
    )
  }
  // Parsing proves that the explicit array is valid; retain its exact bytes.
  parseConfig(source, path, () => {})
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>
  if (Object.hasOwn(parsed, 'merge')) return { changed: false }
  const explicit = Object.hasOwn(parsed, 'landing')
  let result: string
  let enabled: boolean | undefined
  if (explicit) {
    let root = true
    result = source
      .split('\n')
      .map((line) => {
        const header = /^\s*\[/.test(line)
        const renamed = line.replace(
          /^(\s*\[\[\s*)(?:landing|"landing"|'landing')(\s*\]\])/,
          '$1merge$2',
        )
        if (header) root = false
        return root
          ? renamed.replace(/^(\s*)(?:landing|"landing"|'landing')(\s*=)/, '$1merge$2')
          : renamed
      })
      .join('\n')
    const expected: Record<string, unknown> = { ...parsed, merge: parsed.landing }
    delete expected.landing
    const manualEdit = () =>
      new Error(
        `Cannot safely rename the deprecated config key in ${path}; manually rename the root landing key and [[landing]] headers to merge, preserving their values, then retry ab upgrade`,
      )
    let actual: unknown
    try {
      actual = Bun.TOML.parse(result)
    } catch {
      throw manualEdit()
    }
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      )
    if (canonical(actual) !== canonical(expected)) throw manualEdit()
  } else {
    enabled = false
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
        `Cannot read the target repository's legacy auto-merge journal; restore store access and retry ab upgrade, or configure explicit [[merge]] rules (merge = [] selects the new defaults): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    result = `${source.replace(/\n?$/, '\n')}\n# Migrated from the durable auto-merge default. First matching rule wins.\n[[merge]]\nfrom = "leaf"\nmode = "${enabled ? 'auto' : 'consent'}"\n\n[[merge]]\nfrom = "node"\nmode = "consent"\n`
  }
  parseConfig(result, path, () => {})
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, result)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return { changed: true, legacyDefault: enabled }
}

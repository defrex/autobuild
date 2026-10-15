import type { ProjectEntry, ProjectRegistry } from '@defrex/autobuild-postgres-store/projects'

/** Explicitly seeded in-memory deployment registry for protocol fixtures. */
export function testProjects(repositories: readonly string[]): ProjectRegistry {
  const entries = new Map<string, ProjectEntry>()
  for (const repo of repositories)
    entries.set(repo, { repo, addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'fixture' })
  return {
    list: async () => [...entries.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
    has: async (repo) => entries.has(repo),
    add: async (repo, user) => {
      const entry = entries.get(repo) ?? { repo, addedAt: new Date().toISOString(), addedBy: user }
      entries.set(repo, entry)
      return entry
    },
    remove: async (repo) => {
      entries.delete(repo)
    },
    close: async () => {},
  }
}

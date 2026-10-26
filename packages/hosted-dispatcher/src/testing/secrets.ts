import type { ProjectSecretsResolver } from '@defrex/autobuild-postgres-store/project-secrets'
/** Existing kernel scenarios carry no saved project secrets. */
export const emptySecrets = async (): Promise<ProjectSecretsResolver> => ({
  resolveForTick: async (repo) => ({ repo, env: {}, versions: [] }),
  markSupplied: async () => {},
})

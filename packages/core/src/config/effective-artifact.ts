/** Read compatibility for immutable pre-removal effective-config artifacts only.
 * New TOML must pass the current strict schema without this conversion. */
export function normalizeEffectiveConfigArtifact(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const config = value as Record<string, unknown>
  const previous = config.orchestrator
  if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) return value
  const orchestrator = { ...previous } as Record<string, unknown>
  for (const key of ['model', 'invocationBudgetSeconds', 'approvals', 'wake']) {
    delete orchestrator[key]
  }
  return { ...config, orchestrator }
}

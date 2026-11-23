import type { TicketsConfig } from '../../config/schema'

/**
 * The labels a create sends: the explicit labels first, then each configured
 * `[tickets].createLabels` entry not already among them. Unlike
 * `creationAssignees`, where explicit assignees replace the default, creation
 * labels are a union — a create never sheds them by naming its own labels.
 * Undefined when neither is present, so a create with no labels and no
 * configured creation labels keeps omitting `labels`; an explicit `[]` with
 * nothing configured stays `[]`.
 */
export function creationLabels(
  tickets: Pick<TicketsConfig, 'createLabels'>,
  explicit?: readonly string[],
): string[] | undefined {
  const configured = tickets.createLabels ?? []
  if (explicit === undefined && configured.length === 0) return undefined
  const labels = [...(explicit ?? [])]
  for (const label of configured) if (!labels.includes(label)) labels.push(label)
  return labels
}

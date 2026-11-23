/**
 * `[tickets].createLabels` refusals. Every builtin source stores labels, so
 * the only refusals are names a source reserves: on github the managed
 * `autobuild:<state>` and `autobuild-link:` labels and the `node` kind label,
 * on linear the `node` kind label. file and hosted reserve none; a plugin
 * source refuses its own reserved names at create, like any other label.
 */
import { isLinkLabel, isStateLabel, NODE_LABEL } from '../ports/tickets/github-issues'

/** Why `label` cannot be a creation label for `source`, or undefined. Malformed
 * entries (blank or padded) are reported by the schema itself. */
export function createLabelRefusal(source: string, label: string): string | undefined {
  if (label.trim().length === 0 || label !== label.trim()) return undefined
  if (source === 'github') {
    if (isStateLabel(label))
      return `[tickets].createLabels entry "${label}" uses the reserved autobuild: prefix — states are set with readyState and \`ab ticket move\` (selected source: "github")`
    if (isLinkLabel(label))
      return `[tickets].createLabels entry "${label}" uses the reserved autobuild-link: prefix — forge issue links are set with --issues (selected source: "github")`
  }
  if ((source === 'github' || source === 'linear') && label === NODE_LABEL)
    return `[tickets].createLabels entry "${label}" is the node kind label — it would make every created ticket a node; create nodes with --kind node (selected source: "${source}")`
  return undefined
}

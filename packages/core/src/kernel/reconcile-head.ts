import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'

/** Historical merge completions keep their original identity. */
export function reconcileHead(payload: EventPayload<'reconcile.completed'>): string {
  return 'headSha' in payload ? payload.headSha : payload.mergeCommit
}

/** Keep a proven write distinct from the branch head observed after that write. */
export function reconcileRewriteHead(payload: EventPayload<'reconcile.rewritten'>): string {
  return payload.observedHead ?? payload.headSha
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** Only Git-related event fields are object tips. Content digests and attachment
 * hashes are not Git objects. Publication requests/losses describe attempts,
 * not retained Git history: their objects can die with a released workspace.
 * Successful phase facts and rewrite intents independently retain their tips. */
export function referencedGitTips(events: readonly AbEvent[]): string[] {
  const result = new Set<string>()
  const keys = new Set([
    'sha',
    'base',
    'head',
    'baseSha',
    'headSha',
    'mergeCommit',
    'oldHead',
    'oldBase',
    'targetBase',
    'changeSha',
    'workspaceHead',
    'localBranchHead',
    'observedHead',
  ])
  function visit(value: unknown, key = ''): void {
    if (typeof value === 'string' && keys.has(key) && oid.test(value)) result.add(value)
    else if (Array.isArray(value)) for (const item of value) visit(item)
    else if (value !== null && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) visit(item, name)
  }
  for (const event of events) {
    if (
      /^(workspace\.provisioned|implement\.completed|code-review\.|reconcile\.|finalize\.|pr\.)/.test(
        event.type,
      )
    )
      visit(event.payload)
  }
  return [...result].sort()
}

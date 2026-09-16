import type { RepositoryEvent } from '../events/repository'
import { reduceDispatchSettings, type DispatchSettings } from '../kernel/dispatch-settings'
import { sandboxStates } from '../processes/sandbox-state'
import type { Exec } from '../ports/workspace/git-worktree'
import { withSessionlessStore, type StoreOpener } from './store-opening'

/** Script-facing projection returned by `ab repository status`. */
export interface RepositoryStatus extends DispatchSettings {
  repo: string
  /** Live operator sandboxes (AUT-340); released environments are omitted. */
  sandboxes: Array<{
    operator: string
    environmentId: string
    provider: string
    state: 'live' | 'stopped'
    lastEvidenceAt: string
  }>
}

export interface RepositoryStatusOpts {
  /** The cwd, resolved to the canonical main repository before store access. */
  targetRepo: string
  /** Raw process environment for AB_STORE / AB_TOKEN selection. */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  json?: boolean
  /** Explicit --store reference; precedence is owned by repo-state.ts. */
  storeRef?: string
  openStore?: StoreOpener
}

export function projectRepositoryStatus(repo: string, events: RepositoryEvent[]): RepositoryStatus {
  return {
    repo,
    ...reduceDispatchSettings(events),
    sandboxes: sandboxStates(events)
      .filter((state) => state.state !== 'released')
      .map((state) => ({
        operator: state.operator,
        environmentId: state.environmentId,
        provider: state.provider,
        state: state.state === 'stopped' ? ('stopped' as const) : ('live' as const),
        lastEvidenceAt: state.lastEvidenceTs,
      })),
  }
}

export function renderRepositoryStatus(status: RepositoryStatus): string[] {
  const setting = (enabled: boolean): string => (enabled ? 'ON' : 'OFF')
  return [
    `repository: ${status.repo}`,
    `intake: ${setting(status.intake)}`,
    `repository pause: ${setting(status.paused)}`,
    `default auto-merge: ${setting(status.defaultAutoMerge)}`,
    ...status.sandboxes.map(
      (sandbox) =>
        `operator sandbox ${sandbox.environmentId} (${sandbox.provider}) — ${sandbox.state}, idle since ${sandbox.lastEvidenceAt}`,
    ),
  ]
}

/**
 * `ab repository status` — read the durable dispatcher controls without
 * creating a repository stream or starting any dispatcher work.
 */
export async function abRepositoryStatus(opts: RepositoryStatusOpts): Promise<void> {
  await withSessionlessStore(opts, async ({ store, repo }) => {
    // A fresh store has no repository row. Do not call ensureRepo: this query's
    // empty-stream defaults must remain a genuinely read-only operation.
    const record = await store.getRepo(repo)
    const events = record === null ? [] : await store.getRepoEvents(repo)
    const status = projectRepositoryStatus(repo, events)
    if (opts.json === true) {
      opts.stdout(JSON.stringify(status, null, 2))
      return
    }
    for (const line of renderRepositoryStatus(status)) opts.stdout(line)
  })
}

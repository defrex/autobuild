import { listOperatorLandings } from '../operator/landings'
import type { StatusOpts } from './status'
import { withAmbientReadStore } from './store-opening'

export async function abLandings(opts: StatusOpts): Promise<void> {
  await withAmbientReadStore(opts, async ({ store, repo }) => {
    const entries = await listOperatorLandings({ store, repo })
    if (opts.json) opts.stdout(JSON.stringify(entries, null, 2))
    else if (!entries.length) opts.stdout('No landings awaiting consent.')
    else
      for (const entry of entries)
        opts.stdout(
          `${entry.slug} → ${entry.target.ticket?.id ?? entry.target.branch ?? 'root'} · ${entry.branch ?? 'unknown branch'} · ${entry.reason} · verify ${entry.verification.results.map((r) => `${r.step}:${r.outcome}`).join(', ') || 'no steps'}${entry.kind === 'node' ? ` · children ${entry.children?.length ?? 'unknown'} (${entry.completeness})` : ''}`,
        )
  })
}

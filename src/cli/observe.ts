/**
 * `ab observe` (SPEC §8.2, §12): structured observations at the point of
 * capture — followup | refactor | latent-bug, with file/ticket refs — so
 * `harvest` clusters records, not prose mined from a markdown file.
 *
 * NOT a terminal: usable in any phase, at any time, any number of times.
 * The id is kernel-assigned at deposit, like all ids (§15.4).
 */
import type { EventEnvelope } from '../events/catalog'
import { agentActor } from '../events/envelope'
import type { IdSource } from '../ids'
import { observationKindSchema } from '../ontology'
import type { BuildStore } from '../store/types'
import type { CliEnv } from './env'

export interface ObserveDeps {
  store: BuildStore
  env: CliEnv
  ids: IdSource
}

export interface ObserveOpts {
  kind: string
  summary: string
  files?: string[]
  refs?: string[]
}

export async function observe(
  deps: ObserveDeps,
  opts: ObserveOpts,
): Promise<EventEnvelope<'observation.recorded'>> {
  const kind = observationKindSchema.safeParse(opts.kind)
  if (!kind.success) {
    throw new Error(
      `--kind "${opts.kind}" is not an observation kind — expected ` +
        'followup | refactor | latent-bug (§8.2)',
    )
  }
  if (opts.summary.trim() === '') {
    throw new Error("'ab observe' requires a non-empty <summary> (§8.2)")
  }
  const { env } = deps
  return deps.store.append(env.build, {
    actor: agentActor(env.phase, env.session),
    type: 'observation.recorded',
    payload: {
      id: deps.ids('obs'),
      kind: kind.data,
      summary: opts.summary,
      ...(opts.files !== undefined && opts.files.length > 0 ? { files: opts.files } : {}),
      ...(opts.refs !== undefined && opts.refs.length > 0 ? { refs: opts.refs } : {}),
    },
  })
}

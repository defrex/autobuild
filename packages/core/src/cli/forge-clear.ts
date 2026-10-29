import { clearForgeDegradation } from '../operator/control'
import { buildControlUser } from './build-control'
import { withSessionlessStore, type SessionlessStoreOpts } from './store-opening'

export async function abForgeClear(
  opts: SessionlessStoreOpts & {
    forge: string
    reason: string
    json?: boolean
    stdout: (line: string) => void
  },
): Promise<void> {
  if (['AB_BUILD', 'AB_SESSION', 'AB_HARVEST'].some((name) => opts.env[name]?.trim()))
    throw new Error(
      'repository forge-clear requires an operator outside a build or harvest session',
    )
  if (!opts.forge.trim() || !opts.reason.trim()) throw new Error('forge and reason are required')
  await withSessionlessStore(opts, async ({ store, repo }) => {
    const result = await clearForgeDegradation({
      store,
      repo,
      user: buildControlUser(opts.env),
      forge: opts.forge,
      reason: opts.reason,
    })
    opts.stdout(
      opts.json ? JSON.stringify(result) : `Cleared forge ${opts.forge} degradation for ${repo}`,
    )
  })
}

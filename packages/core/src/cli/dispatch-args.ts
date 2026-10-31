import { parseArgs, stringFlag } from './args'
export function parseDispatchArgs(
  rest: readonly string[],
  env: Record<string, string | undefined>,
) {
  const usage =
    'usage: ab dispatch [--viewer [--dispatched-by <label>] | --takeover] [--once] [--interval <seconds>] [--store <ref>] [--repository <origin>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge] (§3.3)'
  const parsed = parseArgs(
    rest,
    {
      viewer: 'boolean',
      takeover: 'boolean',
      'dispatched-by': 'value',
      once: 'boolean',
      interval: 'value',
      store: 'value',
      repository: 'value',
      plain: 'boolean',
      intake: 'boolean',
      'no-intake': 'boolean',
      'auto-merge': 'boolean',
      'no-auto-merge': 'boolean',
    },
    usage,
  )
  if (parsed.positionals.length > 0) throw new Error(usage)

  const takeover = parsed.flags.has('takeover')
  const viewer = parsed.flags.has('viewer')
  if (viewer && takeover) throw new Error('--viewer and --takeover cannot be combined')
  const dispatchedBy = stringFlag(parsed, 'dispatched-by')?.trim()
  if (dispatchedBy !== undefined && (!viewer || dispatchedBy === ''))
    throw new Error('--dispatched-by requires --viewer and a nonblank label')
  if (viewer && parsed.flags.has('repository'))
    throw new Error('--viewer requires a local checkout; omit --repository')
  if (viewer && (parsed.flags.has('intake') || parsed.flags.has('no-intake')))
    throw new Error('--viewer cannot set startup intake; use the interactive intake control')
  const once = parsed.flags.has('once')
  const plain = parsed.flags.has('plain')
  const sawIntake = parsed.flags.has('intake')
  const sawNoIntake = parsed.flags.has('no-intake')
  const sawAutoMerge = parsed.flags.has('auto-merge')
  const sawNoAutoMerge = parsed.flags.has('no-auto-merge')
  if (sawIntake && sawNoIntake) {
    throw new Error(`--intake and --no-intake cannot be combined — ${usage}`)
  }
  if (sawAutoMerge || sawNoAutoMerge) {
    throw new Error(`Auto-merge flags are retired; configure [[merge]] policy — ${usage}`)
  }

  const interval = stringFlag(parsed, 'interval')
  let intervalMs: number | undefined
  if (interval !== undefined) {
    const seconds = Number(interval)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`--interval requires a positive number of seconds — ${usage}`)
    }
    intervalMs = Math.round(seconds * 1000)
  }
  const storeRef = stringFlag(parsed, 'store')
  const repository = stringFlag(parsed, 'repository') ?? (viewer ? undefined : env.AB_REPOSITORY)
  const intake = sawIntake ? true : sawNoIntake ? false : undefined
  const defaultAutoMerge = sawAutoMerge ? true : sawNoAutoMerge ? false : undefined

  return {
    viewer,
    takeover,
    dispatchedBy,
    once,
    plain,
    intake,
    defaultAutoMerge,
    intervalMs,
    storeRef,
    repository,
  }
}

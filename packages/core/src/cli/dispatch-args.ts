import { parseArgs, stringFlag } from './args'
export function parseDispatchArgs(
  rest: readonly string[],
  env: Record<string, string | undefined>,
) {
  const usage =
    'usage: ab dispatch [--once] [--interval <seconds>] [--store <ref>] [--repository <origin>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge] (§3.3)'
  const parsed = parseArgs(
    rest,
    {
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
  const repository = stringFlag(parsed, 'repository') ?? env.AB_REPOSITORY
  const intake = sawIntake ? true : sawNoIntake ? false : undefined
  const defaultAutoMerge = sawAutoMerge ? true : sawNoAutoMerge ? false : undefined

  return { once, plain, intake, defaultAutoMerge, intervalMs, storeRef, repository }
}

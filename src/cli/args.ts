/**
 * Dependency-free argv parsing for one exact `ab` command form.
 *
 * Callers supply the complete flag vocabulary for the receiving command. The
 * parser deliberately owns only syntax: command-specific positional arity,
 * numeric conversion, and mutually exclusive flags remain with the route.
 */
export type FlagKind = 'value' | 'boolean'

export type FlagSpec = Readonly<Record<string, FlagKind>>

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

export function parseArgs(
  args: readonly string[],
  allowedFlags: FlagSpec,
  usage: string,
): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const name = arg.slice(2)
    const kind = Object.hasOwn(allowedFlags, name) ? allowedFlags[name] : undefined
    if (kind === undefined) {
      throw new Error(`unknown flag --${name} — ${usage}`)
    }
    if (flags.has(name)) {
      throw new Error(`--${name} may be supplied only once — ${usage}`)
    }
    if (kind === 'boolean') {
      flags.set(name, true)
      continue
    }

    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `--${name} requires a value${value !== undefined ? `, got "${value}"` : ''} — ${usage}`,
      )
    }
    flags.set(name, value)
    index += 1
  }

  return { positionals, flags }
}

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

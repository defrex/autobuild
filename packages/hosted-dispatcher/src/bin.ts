#!/usr/bin/env bun
import { writePrebuiltDistributionArchive } from '@defrex/autobuild/distribution'

const USAGE = `Usage:
  ab-hosted-dispatcher pack-distribution [--root DIR]`

function option(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may only be supplied once`)
  const index = indexes[0]
  if (index === undefined) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

/** `pack-distribution`: pack the running distribution into
 * `<root>/.autobuild-dist/autobuild-<version>.tgz` for a deployment whose
 * runtime has neither `bun` nor a source tree (the hosted service on Vercel).
 * Run it in the deployment's build step; the archive is what guests install. */
export async function runPackDistribution(
  args: string[],
  write: (text: string) => void = (text) => console.log(text),
  writeError: (text: string) => void = (text) => console.error(text),
): Promise<number> {
  try {
    const root = option(args, '--root')
    const allowed = new Set(['pack-distribution', '--root', root])
    for (const arg of args) if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
    const path = await writePrebuiltDistributionArchive(root)
    write(path)
    return 0
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === 'pack-distribution') {
    process.exitCode = await runPackDistribution(args)
  } else {
    console.error(`unknown command: ${args[0] ?? '(none)'}\n${USAGE}`)
    process.exitCode = 2
  }
}

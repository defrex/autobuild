/**
 * The judge's self-contained `ab` launcher (SPEC §13.1.1): the judge-only
 * entry bundled into one file with every dependency inlined, so it runs from
 * the judge's scratch launcher directory with no path back into the
 * distribution or the repository. Minified without source maps, the bundle
 * carries no source path comments. Bundled once per process.
 */
import { distributionPath } from '../distribution'

/** The bundled entry, relative to the distribution root. */
export const JUDGE_ENTRY = 'packages/core/src/cli/judge-entry.ts'

let bundled: Promise<string> | undefined

export function bundleJudgeLauncher(): Promise<string> {
  bundled ??= build().catch((error: unknown) => {
    bundled = undefined
    throw error
  })
  return bundled
}

async function build(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [distributionPath(JUDGE_ENTRY)],
    target: 'bun',
    minify: true,
    sourcemap: 'none',
  })
  if (!result.success)
    throw new Error(
      `bundling the judge launcher failed: ${result.logs.map((log) => String(log)).join('; ')}`,
    )
  const [output] = result.outputs
  if (output === undefined) throw new Error('bundling the judge launcher produced no output')
  const text = await output.text()
  return `#!/usr/bin/env bun\n${text.replace(/^#!.*\n/, '')}`
}

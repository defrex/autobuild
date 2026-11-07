import { addFragment } from './changelog-fragments'

const USAGE = 'Usage: bun tools/changelog-add.ts <number> <url> <title>\n'

/** Add one PR's changelog fragment unless its marker is already represented. */
export async function main(
  argv: string[],
  root: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (argv.length !== 3) return { exitCode: 2, stdout: '', stderr: USAGE }
  const [number, url, title] = argv as [string, string, string]
  try {
    const result = await addFragment(root, Number(number), url, title)
    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stdout: '', stderr: `changelog-add: ${message}\n` }
  }
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2), process.cwd())
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}

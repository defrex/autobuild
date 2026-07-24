import { fileURLToPath } from 'node:url'

export interface BiomeProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type BiomeProcess = (args: readonly string[]) => Promise<BiomeProcessResult>

export interface BiomeCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const checkArguments = ['check', '.', '--diagnostic-level=info', '--max-diagnostics=none'] as const
const sarifArguments = [...checkArguments, '--reporter=sarif'] as const

function hasSarifResults(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('runs' in value)) {
    throw new Error('SARIF output is missing its runs array')
  }

  const { runs } = value
  if (!Array.isArray(runs)) {
    throw new Error('SARIF output has a non-array runs field')
  }

  let foundResults = false
  for (const run of runs) {
    if (typeof run !== 'object' || run === null || !('results' in run)) {
      throw new Error('SARIF output contains a run without a results array')
    }
    if (!Array.isArray(run.results)) {
      throw new Error('SARIF output contains a run with a non-array results field')
    }
    foundResults ||= run.results.length > 0
  }
  return foundResults
}

export async function runBiomeCheck(
  runBiome: BiomeProcess,
  output: BiomeCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  const sarif = await runBiome(sarifArguments)
  const failures: string[] = []

  if (sarif.exitCode !== 0) {
    failures.push(`Biome exited with status ${sarif.exitCode}`)
  }

  try {
    const report: unknown = JSON.parse(sarif.stdout)
    if (hasSarifResults(report)) {
      failures.push('Biome reported diagnostics')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`Could not validate Biome SARIF output: ${message}`)
  }

  if (failures.length === 0) {
    return 0
  }

  output.stderr(`${failures.join('\n')}\n`)
  if (sarif.stderr.length > 0) {
    output.stderr(sarif.stderr)
  }

  const readable = await runBiome(checkArguments)
  if (readable.stdout.length > 0) {
    output.stdout(readable.stdout)
  }
  if (readable.stderr.length > 0) {
    output.stderr(readable.stderr)
  }
  return 1
}

export const spawnBiome: BiomeProcess = async (args) => {
  const biomeScript = fileURLToPath(
    new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url),
  )
  const processHandle = Bun.spawn([process.execPath, biomeScript, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  return { exitCode, stdout, stderr }
}

if (import.meta.main) {
  process.exitCode = await runBiomeCheck(spawnBiome)
}

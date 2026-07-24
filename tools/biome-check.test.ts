import { describe, expect, test } from 'bun:test'
import {
  type BiomeCheckOutput,
  type BiomeProcess,
  type BiomeProcessResult,
  runBiomeCheck,
} from './biome-check'

const cleanSarif = JSON.stringify({ runs: [{ results: [] }] })
const infoSarif = JSON.stringify({
  runs: [{ results: [{ level: 'note', message: { text: 'informational diagnostic' } }] }],
})

function harness(results: BiomeProcessResult[]) {
  const calls: string[][] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const run: BiomeProcess = async (args) => {
    calls.push([...args])
    const result = results.shift()
    if (!result) {
      throw new Error('unexpected Biome invocation')
    }
    return result
  }
  const output: BiomeCheckOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }
  return { calls, output, run, stderr, stdout }
}

describe('runBiomeCheck', () => {
  test('passes clean SARIF without running the readable reporter', async () => {
    const testRun = harness([{ exitCode: 0, stdout: cleanSarif, stderr: '' }])

    expect(await runBiomeCheck(testRun.run, testRun.output)).toBe(0)
    expect(testRun.calls).toHaveLength(1)
    expect(testRun.stdout).toEqual([])
    expect(testRun.stderr).toEqual([])
  })

  test('fails on an info-only result even when Biome exits successfully', async () => {
    const testRun = harness([
      { exitCode: 0, stdout: infoSarif, stderr: '' },
      { exitCode: 0, stdout: 'readable info\n', stderr: '' },
    ])

    expect(await runBiomeCheck(testRun.run, testRun.output)).toBe(1)
    expect(testRun.calls[0]).toContain('--reporter=sarif')
    expect(testRun.calls[1]).not.toContain('--reporter=sarif')
    expect(testRun.stdout).toEqual(['readable info\n'])
    expect(testRun.stderr.join('')).toContain('Biome reported diagnostics')
  })

  test('fails on a warning or error exit and prints the readable diagnostics', async () => {
    const testRun = harness([
      { exitCode: 1, stdout: infoSarif, stderr: 'sarif stderr\n' },
      { exitCode: 1, stdout: '', stderr: 'src/example.ts lint warning\n' },
    ])

    expect(await runBiomeCheck(testRun.run, testRun.output)).toBe(1)
    expect(testRun.stderr.join('')).toContain('Biome exited with status 1')
    expect(testRun.stderr.join('')).toContain('src/example.ts lint warning')
  })

  test('fails closed on malformed or infrastructure output', async () => {
    const testRun = harness([
      { exitCode: 0, stdout: '{not json', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ])

    expect(await runBiomeCheck(testRun.run, testRun.output)).toBe(1)
    expect(testRun.calls).toHaveLength(2)
    expect(testRun.stderr.join('')).toContain('Could not validate Biome SARIF output')
  })
})

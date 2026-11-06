import { describe, expect, test } from 'bun:test'
import { spawnCliStream } from './cli-stream'

/**
 * Regression coverage for the production streaming boundary (SPEC §9). The
 * adapter tests inject scripted boundaries, so only these tests execute the
 * real spawn path — including the single-consumer rule for proc.stdout: the
 * line decoder and the result reader must each get their own tee() branch,
 * because a second direct reader locks the stream and throws mid-turn.
 */
describe('spawnCliStream', () => {
  const invocation = {
    args: [
      '-e',
      [
        "console.log('event-1')",
        'await Bun.sleep(25)',
        "console.log('event-2')",
        "console.error('diagnostic-line')",
      ].join('; '),
    ],
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '' },
  }

  test('feeds lines live and still resolves the completed result', async () => {
    const handle = spawnCliStream('bun', invocation)
    const lines: string[] = []
    for await (const line of handle.lines) lines.push(line)

    expect(lines).toEqual(['event-1', 'event-2'])
    const result = await handle.result
    expect(result.stdout).toContain('event-1')
    expect(result.stdout).toContain('event-2')
    expect(result.stderr).toContain('diagnostic-line')
    expect(result.exitCode).toBe(0)
  })

  test('a line consumer that stops early leaves the result complete', async () => {
    const handle = spawnCliStream('bun', invocation)
    const lines: string[] = []
    for await (const line of handle.lines) {
      lines.push(line)
      if (lines.length === 1) break
    }
    expect(lines).toEqual(['event-1'])

    // The surviving tee branch drains the process output regardless, so
    // outcome classification (which reads only the result) is unaffected.
    const result = await handle.result
    expect(result.stdout).toContain('event-2')
    expect(result.stderr).toContain('diagnostic-line')
    expect(result.exitCode).toBe(0)
  })

  test('propagates a nonzero exit code', async () => {
    const handle = spawnCliStream('bun', {
      args: ['-e', "console.log('partial'); process.exit(3)"],
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? '' },
    })
    const lines: string[] = []
    for await (const line of handle.lines) lines.push(line)
    expect(lines).toEqual(['partial'])

    const result = await handle.result
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('partial')
  })
})

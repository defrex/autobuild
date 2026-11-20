#!/usr/bin/env bun
/**
 * Cold-start wall time of the `ab` CLI, the measurement command of this
 * repository's CLI-startup optimization node. It is that node's pinned
 * harness: attempts may read and run it, but cannot change what it counts.
 *
 * Each command in a fixed mix of offline invocations runs once to warm the
 * transpiler cache, then RUNS more times in a fresh `bun` process. The value
 * is the sum of each command's median wall time, in milliseconds. Stdout
 * carries exactly one JSON object, `{"value": <ms>}`; the per-command
 * breakdown goes to stderr. Any failed run exits nonzero so the measurement
 * fails rather than recording a number for broken output.
 */

const COMMANDS: readonly (readonly string[])[] = [
  ['--help'],
  ['--version'],
  ['help', 'ticket'],
  ['ticket', '--help'],
  ['watch', '--help'],
  ['done', '--help'],
]
const WARMUP = 1
const RUNS = 5

const root = new URL('../../../', import.meta.url).pathname
const entry = `${root}bin/ab.ts`

// A build runner exports AB_* session variables; the CLI must start as an
// operator would, so none of them reach the measured process.
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith('AB_')) env[key] = value
}
env.NO_COLOR = '1'

function runOnce(args: readonly string[]): number {
  const started = Bun.nanoseconds()
  const result = Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    process.stderr.write(
      `ab ${args.join(' ')} failed (exit ${result.exitCode}, ${result.stdout.length} stdout bytes)\n` +
        result.stderr.toString().slice(-2000),
    )
    process.exit(1)
  }
  return elapsedMs
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}

let total = 0
for (const args of COMMANDS) {
  for (let i = 0; i < WARMUP; i++) runOnce(args)
  const samples = Array.from({ length: RUNS }, () => runOnce(args))
  const value = median(samples)
  total += value
  process.stderr.write(`ab ${args.join(' ').padEnd(16)} median ${value.toFixed(1)} ms\n`)
}

process.stdout.write(`${JSON.stringify({ value: Math.round(total * 10) / 10 })}\n`)

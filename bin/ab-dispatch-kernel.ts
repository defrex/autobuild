#!/usr/bin/env bun
/** Private, shipped child for the interactive `ab dispatch` kernel. It owns no
 * terminal handles; the public command launches it with immutable options. */
import { abDispatch } from '../src/cli/dispatch'
import { DISPATCH_CHILD_OPTIONS_ENV, type DispatchChildOptions } from '../src/cli/dispatch-process'
import { spawnExec } from '../src/ports/workspace/git-worktree'

const raw = process.env[DISPATCH_CHILD_OPTIONS_ENV]
if (raw === undefined) process.exit(2)
let options: DispatchChildOptions
try {
  options = JSON.parse(raw) as DispatchChildOptions
} catch {
  process.exit(2)
}

const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())

try {
  await abDispatch({
    targetRepo: options.targetRepo,
    storeRef: options.storeRef,
    env: process.env,
    exec: spawnExec,
    stdout: () => {},
    stderr: () => {},
    once: options.once,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    signal: stop.signal,
    plain: true,
    silent: true,
    kernelRunId: options.run,
  })
  process.exit(0)
} catch {
  process.exit(1)
}

#!/usr/bin/env bun
/** Private, shipped child for the interactive `ab dispatch` kernel. It owns no
 * terminal handles; the public command launches it with immutable options. */
import { abDispatch } from '../packages/core/src/cli/dispatch'
import {
  DISPATCH_CHILD_OPTIONS_ENV,
  type DispatchChildOptions,
  installDispatchKernelSignalHandlers,
  watchDispatchParent,
} from '../packages/core/src/cli/dispatch-process'
import { DISPATCHER } from '../packages/core/src/events/envelope'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import { resolveRepoState } from '../packages/core/src/cli/repo-state'
import { openStoreForRepoState } from '../packages/core/src/cli/store-opening'

const raw = process.env[DISPATCH_CHILD_OPTIONS_ENV]
if (raw === undefined) process.exit(2)
let options: DispatchChildOptions
try {
  options = JSON.parse(raw) as DispatchChildOptions
} catch {
  process.exit(2)
}

const stop = new AbortController()
const requestStop = (): void => stop.abort()
// Keep both handlers installed through the complete graceful drain. The first
// targeted SIGINT comes from the supervisor; later foreground-group signals
// must not regain their default disposition inside an open claim tick.
const signalHandlers = installDispatchKernelSignalHandlers(requestStop)
const parentWatch = watchDispatchParent(process.ppid, requestStop)
let exitCode = 0

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
} catch (error) {
  exitCode = 1
  // Config/plugin/adapter startup can fail before abDispatch owns a Store and
  // writes run-started. Reopen only the already-resolved Store identity so the
  // terminal frontend receives the actionable failure rather than a generic
  // child exit status.
  try {
    const state = await resolveRepoState({
      targetRepo: options.targetRepo,
      storeRef: options.storeRef,
      exec: spawnExec,
    })
    const opened = openStoreForRepoState(state, { env: process.env })
    try {
      await opened.store.ensureRepo(state.repo)
      const events = await opened.store.getRepoEvents(state.repo)
      if (
        !events.some(
          (event) => event.type === 'dispatcher.run-stopped' && event.payload.run === options.run,
        )
      ) {
        await opened.store.appendRepo(state.repo, {
          actor: DISPATCHER,
          type: 'dispatcher.run-stopped',
          payload: {
            run: options.run,
            outcome: 'abnormal',
            exitCode: 1,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    } finally {
      await opened.store.close()
    }
  } catch {
    // The supervisor still records the process exit if even the Store cannot
    // be opened. Preserve the original startup failure as the exit cause.
  }
} finally {
  parentWatch.close()
  signalHandlers.close()
}
process.exit(exitCode)

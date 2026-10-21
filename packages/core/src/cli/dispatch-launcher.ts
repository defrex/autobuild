import {
  FOCUS_REPORTING_MODE,
  KITTY_KEYBOARD_MODE,
  BRACKETED_PASTE_MODE,
  ALTERNATE_SCREEN_MODE,
  HIDDEN_CURSOR_MODE,
} from './terminal-restore'
import { watchPresentationJob } from './dispatch-presentation-job'
import { dirname } from 'node:path'
import { distributionRoot } from '../distribution'
import { resolveMainRepo } from './main-checkout'
import { prepareRuntime } from './dispatch-runtime-cache'
import {
  activateRuntime,
  pruneRuntimes,
  spawnUsingRuntime,
  releasePreparedRuntime,
} from './dispatch-runtime-use'
import {
  DISPATCH_GENERATION_ENV,
  DISPATCH_LAUNCH_VERSION,
  GENERATION_SIGNALS,
  generationArguments,
  generationResult,
} from './dispatch-launch-contract'

// Filesystem/process-only dependencies above are evaluated before installation.
async function gitExec(cmd: string[], options: { cwd?: string }) {
  const child = Bun.spawn(cmd, { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
export async function launchDispatcher(argv: string[]): Promise<number> {
  const checkout = await resolveMainRepo(process.cwd(), gitExec)
  const runtime = await prepareRuntime(distributionRoot(), checkout)
  activateRuntime(runtime.root)
  const { child, release } = spawnUsingRuntime(runtime.root, () =>
    Bun.spawn([process.execPath, ...generationArguments(runtime.root, argv)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [DISPATCH_GENERATION_ENV]: JSON.stringify({
          version: DISPATCH_LAUNCH_VERSION,
          runtimeRoot: runtime.root,
          checkout,
        }),
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  )
  releasePreparedRuntime(runtime.root)
  let signal: NodeJS.Signals | undefined
  const listeners = GENERATION_SIGNALS.map((name) => ({
    name,
    listener: () => {
      signal ??= name
      try {
        child.kill(name)
      } catch {}
    },
  }))
  for (const { name, listener } of listeners) process.on(name, listener)
  const job = watchPresentationJob(child.pid)
  let clean = false
  let publicCode = 1
  try {
    pruneRuntimes(dirname(dirname(runtime.root)))
    const code = await child.exited
    const result = generationResult(code, child.signalCode)
    clean = result.reason === 'stopped'
    publicCode = result.publicCode
  } finally {
    job.close()
    release()
    for (const { name, listener } of listeners) process.removeListener(name, listener)
    if (!clean && process.stdin.isTTY) process.stdin.setRawMode(false)
    if (!clean && process.stdout.isTTY)
      for (const mode of [
        FOCUS_REPORTING_MODE,
        KITTY_KEYBOARD_MODE,
        BRACKETED_PASTE_MODE,
        ALTERNATE_SCREEN_MODE,
        HIDDEN_CURSOR_MODE,
      ])
        process.stdout.write(mode.restore)
    pruneRuntimes(dirname(dirname(runtime.root)))
  }
  if (signal && signal !== 'SIGINT') process.kill(process.pid, signal)
  return publicCode
}

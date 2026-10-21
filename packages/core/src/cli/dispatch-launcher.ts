import {
  FOCUS_REPORTING_MODE,
  KITTY_KEYBOARD_MODE,
  BRACKETED_PASTE_MODE,
  ALTERNATE_SCREEN_MODE,
  HIDDEN_CURSOR_MODE,
} from './terminal-restore'
import { watchPresentationJob } from './dispatch-presentation-job'
import { dirname, basename, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { distributionRoot } from '../distribution'
import { resolveMainRepo } from './main-checkout'
import { prepareRuntime } from './dispatch-runtime-cache'
import {
  activateRuntime,
  pruneRuntimes,
  spawnUsingRuntime,
  releasePreparedRuntime,
  retainRuntime,
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
  // Keep the public installation pathname rather than its realpath into Bun's version store.
  const entry = resolve(process.argv[1] ?? '')
  const originalInstall =
    basename(dirname(entry)) === '.bin'
      ? join(dirname(dirname(entry)), '@defrex/autobuild')
      : entry.endsWith('/bin/ab.ts')
        ? dirname(dirname(entry))
        : distributionRoot()
  let runtime = await prepareRuntime(distributionRoot(), checkout)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let signal: NodeJS.Signals | undefined
  const listeners = GENERATION_SIGNALS.map((name) => ({
    name,
    listener: () => {
      signal ??= name
      try {
        child?.kill(name)
      } catch {}
    },
  }))
  for (const { name, listener } of listeners) process.on(name, listener)
  let clean = false
  let publicCode = 1
  const lineage = randomUUID()
  let predecessor: string | undefined
  try {
    for (;;) {
      if (signal) break
      activateRuntime(runtime.root)
      const launch = {
        version: DISPATCH_LAUNCH_VERSION,
        runtimeRoot: runtime.root,
        checkout,
        originalInstall,
        run: randomUUID(),
        lineage,
        ...(predecessor ? { predecessor } : {}),
      }
      const env = { ...process.env, [DISPATCH_GENERATION_ENV]: JSON.stringify(launch) }
      const spawned = spawnUsingRuntime(runtime.root, () =>
        Bun.spawn([process.execPath, ...generationArguments(runtime.root, argv)], {
          cwd: process.cwd(),
          env,
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        }),
      )
      child = spawned.child
      releasePreparedRuntime(runtime.root)
      retainRuntime(runtime.root, false)
      const job = watchPresentationJob(child.pid)
      let result: ReturnType<typeof generationResult>
      try {
        pruneRuntimes(dirname(dirname(runtime.root)))
        result = generationResult(await child.exited, child.signalCode)
      } finally {
        job.close()
        spawned.release()
        child = undefined
      }
      clean = result.reason === 'stopped' || result.reason === 'handoff'
      publicCode = result.publicCode
      if (signal || result.reason !== 'handoff') break
      // Only the exited immutable generation interprets durable state. No config/Store imports here.
      const reader = Bun.spawn(
        [process.execPath, ...generationArguments(runtime.root, ['--read-handoff', ...argv])],
        {
          cwd: process.cwd(),
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [readerCode, output, error] = await Promise.all([
        reader.exited,
        new Response(reader.stdout).text(),
        new Response(reader.stderr).text(),
      ])
      if (readerCode !== 0) throw new Error(`handoff reader failed: ${error}`)
      const response = JSON.parse(output) as {
        version: number
        handoff: { root: string; cacheId: string; run: string; lineage: string } | null
      }
      if (
        response.version !== 1 ||
        !response.handoff ||
        response.handoff.run !== launch.run ||
        response.handoff.lineage !== lineage
      )
        throw new Error('generation exited without a valid durable handoff')
      if (signal) break
      predecessor = launch.run
      runtime = { ...runtime, root: response.handoff.root, id: response.handoff.cacheId }
    }
  } finally {
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
  return signal === 'SIGINT' ? 0 : publicCode
}

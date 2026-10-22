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
} from './dispatch-runtime-use'
import {
  DISPATCH_GENERATION_ENV,
  DISPATCH_LAUNCH_VERSION,
  DISPATCH_OVERLAP_VERSION,
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
  type Child = {
    runtime: typeof runtime
    launch: import('./dispatch-launch-contract').GenerationLaunch
    env: Record<string, string | undefined>
    child: ReturnType<typeof Bun.spawn>
    release(): void
    job?: ReturnType<typeof watchPresentationJob>
    result?: ReturnType<typeof generationResult>
    exited: Promise<void>
  }
  const lineage = randomUUID()
  const children = new Set<Child>()
  let signal: NodeJS.Signals | undefined
  const stopping = new AbortController()
  const listeners = GENERATION_SIGNALS.map((name) => ({
    name,
    listener: () => {
      signal ??= name
      stopping.abort()
      for (const record of children)
        try {
          record.child.kill(name)
        } catch {}
    },
  }))
  for (const { name, listener } of listeners) process.on(name, listener)
  const start = (
    selected: typeof runtime,
    predecessor?: string,
    predecessorRoot?: string,
    predecessorCorrelation?: string,
    journal?: import('./dispatch-launch-contract').GenerationLaunch['journal'],
    successorRun?: string,
  ): Child => {
    const launch: import('./dispatch-launch-contract').GenerationLaunch = {
      version: DISPATCH_LAUNCH_VERSION,
      overlapVersion: DISPATCH_OVERLAP_VERSION,
      ...(journal ? { journal } : {}),
      runtimeRoot: selected.root,
      checkout,
      originalInstall,
      launcherPid: process.pid,
      run: successorRun ?? randomUUID(),
      lineage,
      ...(predecessor ? { predecessor, predecessorRoot, predecessorCorrelation } : {}),
    }
    const env = {
      ...process.env,
      ...(journal ? { AB_STORE: journal.storeRef } : {}),
      [DISPATCH_GENERATION_ENV]: JSON.stringify(launch),
    }
    const spawned = spawnUsingRuntime(selected.root, () =>
      Bun.spawn(
        [
          process.execPath,
          ...generationArguments(selected.root, [...(predecessor ? ['--preflight'] : []), ...argv]),
        ],
        { cwd: process.cwd(), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
      ),
    )
    const record: Child = {
      runtime: selected,
      launch,
      env,
      child: spawned.child,
      release: spawned.release,
      exited: Promise.resolve(),
    }
    children.add(record)
    if (!predecessor) releasePreparedRuntime(selected.root)
    if (!predecessor) record.job = watchPresentationJob(record.child.pid)
    record.exited = record.child.exited
      .then((code) => {
        record.result = generationResult(code, record.child.signalCode)
      })
      .finally(() => {
        record.job?.close()
        record.release()
      })
    return record
  }
  const reader = async (
    record: Pick<Child, 'runtime' | 'env'>,
    mode: string,
    extra: string[] = [],
  ) => {
    const helper = Bun.spawn(
      [process.execPath, ...generationArguments(record.runtime.root, [mode, ...extra, ...argv])],
      {
        cwd: process.cwd(),
        env: record.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(30_000)]),
      },
    )
    const [code, output, error] = await Promise.all([
      helper.exited,
      new Response(helper.stdout).text(),
      new Response(helper.stderr).text(),
    ])
    if (code !== 0) throw new Error(`generation journal reader failed: ${error}`)
    return output ? JSON.parse(output) : null
  }
  let active: Child | undefined
  let pending: { record: Child; correlation: string } | undefined
  let clean = false
  let publicCode = 1
  try {
    activateRuntime(runtime.root)
    const bootstrap = (await reader(
      {
        runtime,
        env: {
          ...process.env,
          [DISPATCH_GENERATION_ENV]: JSON.stringify({
            version: DISPATCH_LAUNCH_VERSION,
            overlapVersion: DISPATCH_OVERLAP_VERSION,
            runtimeRoot: runtime.root,
            checkout,
            originalInstall,
            launcherPid: process.pid,
            lineage,
          }),
        },
      },
      '--read-journal',
    )) as { version: number; journal?: { storeRef: string; repo: string } }
    if (
      bootstrap.version !== 1 ||
      typeof bootstrap.journal?.storeRef !== 'string' ||
      typeof bootstrap.journal.repo !== 'string'
    )
      throw new Error('invalid generation journal identity')
    if (signal) throw new Error('dispatcher launch interrupted')
    active = start(runtime, undefined, undefined, undefined, bootstrap.journal)
    for (;;) {
      if (signal) break
      // Projection is produced by the running immutable runtime. This module
      // has no store, config, compatibility or target-resolution dependencies.
      let projection: {
        version: number
        handoff: {
          root: string
          cacheId: string
          run: string
          lineage: string
          correlation: string
        } | null
        takeover: boolean
        journal?: { storeRef: string; repo: string }
        successor?: string
        accepted?: boolean
        released?: boolean
      }
      try {
        projection = (await reader(active, '--read-upgrade')) as {
          version: number
          handoff: {
            root: string
            cacheId: string
            run: string
            lineage: string
            correlation: string
          } | null
          takeover: boolean
          journal?: { storeRef: string; repo: string }
          successor?: string
          accepted?: boolean
          released?: boolean
        }
      } catch {
        if (active.result && !pending) {
          clean = active.result.reason === 'stopped'
          publicCode = active.result.publicCode
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        continue
      }
      if (projection.version !== 1) throw new Error('incompatible generation upgrade reader')
      if (projection.journal && !active.launch.journal) {
        active.launch = { ...active.launch, journal: projection.journal }
        active.env = { ...active.env, [DISPATCH_GENERATION_ENV]: JSON.stringify(active.launch) }
      }

      if (pending && active.result && projection.accepted && !projection.released) {
        active.job?.close()
        active.job = undefined
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        if (process.stdout.isTTY)
          for (const mode of [
            FOCUS_REPORTING_MODE,
            KITTY_KEYBOARD_MODE,
            BRACKETED_PASTE_MODE,
            ALTERNATE_SCREEN_MODE,
            HIDDEN_CURSOR_MODE,
          ])
            process.stdout.write(mode.restore)
        await reader(active, '--recover-terminal-release')
      }

      if (pending && projection.takeover) {
        active.job?.close()
        active.job = undefined
        active = pending.record
        releasePreparedRuntime(active.runtime.root)
        active.job = watchPresentationJob(active.child.pid)
        runtime = active.runtime
        activateRuntime(runtime.root)
        pending = undefined
      } else if (pending?.record.result) {
        children.delete(pending.record)
        if (projection.accepted && projection.handoff && projection.successor) {
          pending = {
            record: start(
              pending.record.runtime,
              active.launch.run,
              active.runtime.root,
              pending.correlation,
              active.launch.journal,
              projection.successor,
            ),
            correlation: pending.correlation,
          }
        } else {
          try {
            await reader(active, '--record-preflight-failure', [
              pending.correlation,
              'target preflight exited without takeover; repository authority was retained',
            ])
          } catch {
            // Failure publication is retryable durable work, not permission to
            // stop a healthy predecessor or retry target preparation.
            await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
            continue
          }
          releasePreparedRuntime(pending.record.runtime.root)
          pending = undefined
        }
      } else if (!pending && projection.handoff) {
        const handoff = projection.handoff
        if (handoff.run !== active.launch.run || handoff.lineage !== lineage)
          throw new Error('invalid durable generation target')
        pending = {
          record: start(
            { ...runtime, root: handoff.root, id: handoff.cacheId },
            active.launch.run,
            active.runtime.root,
            handoff.correlation,
            active.launch.journal,
            projection.successor,
          ),
          correlation: handoff.correlation,
        }
      }
      if (active.result && !pending) {
        clean = active.result.reason === 'stopped' || active.result.reason === 'handoff'
        publicCode = active.result.publicCode
        break
      }
      for (const record of children)
        if (record !== active && record !== pending?.record && record.result)
          children.delete(record)
      pruneRuntimes(dirname(dirname(runtime.root)))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, pending ? 250 : 1_000)
          }),
          ...(!active.result ? [active.exited] : []),
          ...(pending && !pending.record.result ? [pending.record.exited] : []),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (error) {
    if (!signal) throw error
  } finally {
    for (const record of children)
      if (!record.result)
        try {
          record.child.kill(signal ?? 'SIGTERM')
        } catch {}
    await Promise.all([...children].map((record) => record.exited))
    if (active?.result?.reason === 'stopped' || active?.result?.reason === 'handoff') clean = true
    for (const { name, listener } of listeners) process.removeListener(name, listener)
    // A preflight process never owns restoration. Only failure of the active
    // presentation owner requires the launcher's last-resort cleanup.
    if (!clean && active && process.stdin.isTTY) process.stdin.setRawMode(false)
    if (!clean && active && process.stdout.isTTY)
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

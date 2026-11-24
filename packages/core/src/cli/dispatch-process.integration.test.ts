import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abDispatch } from './dispatch'
import { resolveRepoState } from './repo-state'
import { openStoreForRepoState } from './store-opening'
import { createTerminalModeController } from './terminal-restore'
import {
  superviseDispatchChild,
  type DispatchSubprocess,
  watchDispatchParent,
} from './dispatch-process'
import { spawnExec } from '../ports/workspace/git-worktree'
import { GIT_ID, git } from '../scenarios/harness'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'

function fakeSubprocess(onKill?: (signal: 'SIGINT' | 'SIGKILL') => void): DispatchSubprocess & {
  finish(code: number, signal?: string): void
  kills: Array<'SIGINT' | 'SIGKILL'>
} {
  let finish!: (code: number) => void
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | number | null,
    kills: [] as Array<'SIGINT' | 'SIGKILL'>,
    exited: new Promise<number>((resolve) => {
      finish = resolve
    }),
    kill(signal: 'SIGINT' | 'SIGKILL'): void {
      child.kills.push(signal)
      onKill?.(signal)
    },
    finish(code: number, signal?: string): void {
      child.exitCode = code
      child.signalCode = signal ?? null
      finish(code)
    },
  }
  return child
}

function supervisorFixture(store: BuildStore, child: DispatchSubprocess, timeout = 5) {
  return superviseDispatchChild({
    store,
    repo: '/repo',
    run: 'run-1',
    env: {},
    options: { targetRepo: '/repo', storeRef: 'memory', run: 'run-1', once: false },
    stopTimeoutMs: timeout,
    spawn: () => child,
  })
}

describe('dispatch child supervision', () => {
  test('an orphaned kernel notices parent death and requests shutdown once', async () => {
    let currentParent = 42
    let alive = true
    let stops = 0
    const watch = watchDispatchParent(
      42,
      () => {
        stops += 1
      },
      {
        intervalMs: 1,
        currentParentPid: () => currentParent,
        isAlive: () => alive,
      },
    )

    await Bun.sleep(3)
    expect(stops).toBe(0)
    currentParent = 1
    alive = false
    await Bun.sleep(5)
    expect(stops).toBe(1)
    await Bun.sleep(3)
    expect(stops).toBe(1)
    watch.close()
  })
})

test('stop never force-kills a draining kernel, whatever the store says about its tick', async () => {
  const { emptyTickReport } = await import('../processes/dispatcher')
  const {
    queued,
    janitorDiagnostics,
    blockedDiagnostics,
    ticketDiagnostics,
    creationDiagnostics,
    dependencyDiagnostics,
    agentContextDiagnostics,
    ...counters
  } = emptyTickReport()
  const tickStarted = async (store: BuildStore) => {
    await store.appendRepo('/repo', {
      actor: DISPATCHER,
      type: 'dispatcher.tick-started',
      payload: { run: 'run-1' },
    })
  }
  // Each row guards a different reintroduced kill rule; `afterSigint` runs
  // once the stop deadline has passed and before the child exits.
  const rows: Array<{
    name: string
    setup(store: MemoryBuildStore): Promise<void>
    killsOn137?: boolean
    afterSigint?(store: MemoryBuildStore): Promise<void>
  }> = [
    { name: 'closed tick, kernel persisting suspension', setup: async () => {} },
    {
      name: 'open ticket-claim tick',
      setup: tickStarted,
      afterSigint: (store) =>
        store
          .appendRepo('/repo', {
            actor: DISPATCHER,
            type: 'dispatcher.tick-completed',
            payload: {
              run: 'run-1',
              queued: 0,
              counters,
              janitorDiagnostics: [],
              ticketDiagnostics: [],
              dependencyDiagnostics: [],
            },
          })
          .then(() => undefined),
    },
    {
      name: 'metadata open boundary without any journal start',
      setup: async (store) => {
        await store.claimRepoLease('/repo', 'run-1', 60000)
        await store.beginRepoTick('/repo', 'run-1')
      },
    },
    {
      name: 'finished idle telemetry',
      killsOn137: true,
      setup: async (store) => {
        await store.claimRepoLease('/repo', 'run-1', 60000)
        await tickStarted(store)
        await store.beginRepoTick('/repo', 'run-1')
        await store.finishRepoTick('/repo', 'run-1', { outcome: 'completed', counters }, [])
      },
    },
    {
      name: 'failed telemetry read',
      setup: async (store) => {
        store.getRepo = async () => {
          throw new Error('unavailable')
        }
      },
    },
    {
      name: 'another run telemetry over a historical unsafe tick',
      setup: async (store) => {
        await store.claimRepoLease('/repo', 'foreign', 60_000)
        await store.beginRepoTick('/repo', 'foreign')
        await tickStarted(store)
      },
    },
  ]
  const started = await Promise.all(
    rows.map(async (row) => {
      const store = new MemoryBuildStore()
      await store.ensureRepo('/repo')
      await row.setup(store)
      const child = fakeSubprocess((signal) => {
        if (row.killsOn137 && signal === 'SIGKILL') child.finish(137, signal)
      })
      const supervisor = supervisorFixture(store, child)
      return { row, store, child, supervisor, stopping: supervisor.stop() }
    }),
  )
  // Past `stopTimeoutMs` (5): a deadline- or telemetry-based kill would fire here.
  await Bun.sleep(15)
  for (const { row, store, child, supervisor, stopping } of started) {
    expect(child.kills, row.name).toEqual(['SIGINT'])
    await row.afterSigint?.(store)
    child.finish(0)
    await stopping
    expect(await supervisor.completed, row.name).toEqual({ outcome: 'normal', exitCode: 0 })
    expect(child.kills, row.name).toEqual(['SIGINT'])
  }
})

test('interactive production dispatch runs the kernel in a distinct supervised process', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-dispatch-process-'))
  try {
    await git(['init', '-q', '-b', 'main'], repo)
    await mkdir(join(repo, 'tickets', 'ready'), { recursive: true })
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
capacity = 2

[roles.default]
runtime = "claude"

[tickets]
source = "file"
dir = "tickets"
readyState = "ready"
`,
    )
    await writeFile(join(repo, 'README.md'), 'fixture\n')
    await git(['add', '-A'], repo)
    await git([...GIT_ID, 'commit', '-q', '-m', 'fixture'], repo)

    let output = ''
    const write = (chunk: string): void => {
      output += chunk
    }
    await abDispatch({
      targetRepo: repo,
      env: {},
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      terminal: {
        write,
        modes: createTerminalModeController(write, write),
        columns: 80,
        rows: 24,
        interactive: true,
      },
      input: { start: () => () => {} },
    })

    const state = await resolveRepoState({ targetRepo: repo, exec: spawnExec })
    const opened = openStoreForRepoState(state, { env: {} })
    try {
      const events = await opened.store.getRepoEvents(state.repo)
      const started = events.find((event) => event.type === 'dispatcher.run-started')
      expect(started?.type).toBe('dispatcher.run-started')
      if (started?.type !== 'dispatcher.run-started') throw new Error('missing run start')
      expect(started.payload.pid).not.toBe(process.pid)
      const completed = events.find((event) => event.type === 'dispatcher.tick-completed')
      expect(completed?.type).toBe('dispatcher.tick-completed')
      if (completed?.type !== 'dispatcher.tick-completed')
        throw new Error('missing tick completion')
      expect(completed.payload).not.toHaveProperty('observations')
      expect(
        events.some(
          (event) => event.type === 'dispatcher.run-stopped' && event.payload.outcome === 'normal',
        ),
      ).toBe(true)
      const artifact = await opened.store.getRepoArtifact(
        state.repo,
        started.payload.effectiveConfig.kind,
        started.payload.effectiveConfig.rev,
      )
      expect(artifact).not.toBeNull()
      expect(output).toContain('active 0/2')
    } finally {
      await opened.store.close()
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}, 20_000)

test('interactive startup failures retain actionable detail and restore the terminal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-dispatch-startup-failure-'))
  try {
    await git(['init', '-q', '-b', 'main'], repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `capacity = 0

[roles.default]
runtime = "claude"

[tickets]
source = "file"
readyState = "ready"
`,
    )
    await writeFile(join(repo, 'README.md'), 'fixture\n')
    await git(['add', '-A'], repo)
    await git([...GIT_ID, 'commit', '-q', '-m', 'fixture'], repo)

    let output = ''
    const write = (chunk: string): void => {
      output += chunk
    }
    await expect(
      abDispatch({
        targetRepo: repo,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: () => {},
        once: true,
        terminal: {
          write,
          modes: createTerminalModeController(write, write),
          columns: 80,
          rows: 24,
          interactive: true,
        },
        input: { start: () => () => {} },
      }),
    ).rejects.toThrow(/dispatcher kernel failed: .*capacity.*\(exit code 1\)/s)

    const state = await resolveRepoState({ targetRepo: repo, exec: spawnExec })
    const opened = openStoreForRepoState(state, { env: {} })
    try {
      const stopped = (await opened.store.getRepoEvents(state.repo)).filter(
        (event) => event.type === 'dispatcher.run-stopped',
      )
      expect(stopped).toHaveLength(1)
      expect(stopped[0]?.payload).toMatchObject({ outcome: 'abnormal' })
      expect('error' in stopped[0]!.payload ? stopped[0]!.payload.error : '').toContain('capacity')
      expect(output).toContain('capacity')
      expect(output).toContain('\x1b[?1049l')
    } finally {
      await opened.store.close()
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}, 20_000)

for (const [signal, interactive] of [
  ['SIGHUP', false],
  ['SIGTERM', true],
] as const) {
  test(`real ${interactive ? 'supervised' : 'plain'} dispatcher drains ${signal} and releases ownership`, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-dispatch-signal-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await git(['init', '-q', '-b', 'main'], repo)
      await mkdir(join(repo, 'tickets', 'ready'), { recursive: true })
      await writeFile(
        join(repo, 'autobuild.toml'),
        'baseBranch = "main"\ncapacity = 2\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
      )
      await writeFile(join(repo, 'README.md'), 'fixture\n')
      await git(['add', '-A'], repo)
      await git([...GIT_ID, 'commit', '-q', '-m', 'fixture'], repo)
      const entry = join(repo, 'signal-entry.ts')
      const cli = import.meta.dir
      await writeFile(
        entry,
        `
import { abDispatch } from ${JSON.stringify(join(cli, 'dispatch.ts'))}
import { spawnExec } from ${JSON.stringify(join(cli, '../ports/workspace/git-worktree.ts'))}
import { createTerminalModeController } from ${JSON.stringify(join(cli, 'terminal-restore.ts'))}
import { withDispatchTerminalRestore } from ${JSON.stringify(join(cli, 'binary.ts'))}
const controller = new AbortController()
process.on('SIGINT', () => controller.abort('SIGINT'))
const write = (s) => process.stdout.write(s)
const terminal = { write, modes: createTerminalModeController(write, write), columns: 80, rows: 24, interactive: ${interactive} }
await withDispatchTerminalRestore('dispatch', terminal, () => abDispatch({ targetRepo: ${JSON.stringify(repo)}, env: {}, exec: spawnExec, stdout: () => {}, stderr: () => {}, signal: controller.signal, intervalMs: 10, plain: ${!interactive}, terminal, input: { start: () => () => {} } }), process, (signal) => controller.abort(signal))
`,
      )
      child = Bun.spawn([process.execPath, entry], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
      let terminalOutput = ''
      const outputDone = (async () => {
        for await (const chunk of child!.stdout as ReadableStream<Uint8Array>)
          terminalOutput += new TextDecoder().decode(chunk)
      })()
      const state = await resolveRepoState({ targetRepo: repo, exec: spawnExec })
      const opened = openStoreForRepoState(state, { env: {} })
      try {
        const deadline = Date.now() + 10000
        let acquired = false
        while (Date.now() < deadline && child.exitCode === null) {
          if (
            (await opened.store.getRepo(state.repo))?.lease &&
            (!interactive || terminalOutput.includes('\x1b[?1049h'))
          ) {
            acquired = true
            break
          }
          await Bun.sleep(10)
        }
        expect(acquired).toBe(true)
        child.kill(signal)
        await Promise.race([
          child.exited,
          Bun.sleep(10000).then(() => {
            throw new Error('dispatcher did not drain')
          }),
        ])
        const stops = (await opened.store.getRepoEvents(state.repo)).filter(
          (e) => e.type === 'dispatcher.run-stopped',
        )
        expect(stops).toHaveLength(1)
        expect(stops[0]?.payload).toMatchObject({ outcome: 'normal', signal })
        expect((await opened.store.getRepo(state.repo))?.lease).toBeUndefined()
        await outputDone
        if (interactive) {
          expect(terminalOutput).toContain('\x1b[?25h')
          expect(terminalOutput).toContain('\x1b[?1004l')
        } else expect(terminalOutput).not.toContain('\x1b[?1004')
        await abDispatch({
          targetRepo: repo,
          env: {},
          exec: spawnExec,
          stdout: () => {},
          stderr: () => {},
          once: true,
          plain: true,
        })
        const events = await opened.store.getRepoEvents(state.repo)
        const lastStart = events.findLast((e) => e.type === 'dispatcher.run-started')!
        expect(
          events.some((e) => e.seq > lastStart.seq && e.type === 'dispatcher.tick-yielded'),
        ).toBe(false)
        expect(
          events.some((e) => e.seq > lastStart.seq && e.type === 'dispatcher.tick-completed'),
        ).toBe(true)
      } finally {
        await opened.store.close()
      }
    } finally {
      if (child?.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
      await rm(repo, { recursive: true, force: true })
    }
  }, 25000)
}

test('real process stops after restoring focus, resumes twice, and restores on an uncaught crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-focus-job-'))
  let driver: ReturnType<typeof Bun.spawn> | undefined
  try {
    const entry = join(dir, 'job.ts')
    await writeFile(
      entry,
      `
import { createTerminalModeController, FOCUS_REPORTING_MODE, installPresentationSuspension, installTerminalRestoreHook } from ${JSON.stringify(join(import.meta.dir, 'terminal-restore.ts'))}
import { writeSync } from 'node:fs'
const write = (chunk: string) => { writeSync(1, chunk) }
const modes = createTerminalModeController(write, write)
installTerminalRestoreHook(modes)
installPresentationSuspension(modes, () => write('PAUSE'), () => write('RESUME'))
modes.enter(FOCUS_REPORTING_MODE)
write('READY')
process.stdin.on('data', () => { throw new Error('intentional crash') })
setInterval(() => {}, 1000)
`,
    )
    const script = `
import os, signal, subprocess, sys, time, select, json
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=os.setpgrp)
output = b''
def until(marker):
 global output
 deadline = time.monotonic() + 3
 while marker not in output:
  if time.monotonic() > deadline: raise Exception('missing marker: ' + repr(marker))
  if select.select([p.stdout], [], [], .05)[0]: output += os.read(p.stdout.fileno(), 4096)
try:
 until(b'READY')
 for n in range(2):
  output = b''
  os.kill(p.pid, signal.SIGTSTP)
  deadline = time.monotonic() + 3
  while True:
   pid, status = os.waitpid(p.pid, os.WUNTRACED | os.WNOHANG)
   if pid:
    assert os.WIFSTOPPED(status), status
    break
   if time.monotonic() > deadline: raise Exception('SIGTSTP was swallowed')
   time.sleep(.01)
  until(b'\\x1b[?1004l')
  assert b'PAUSE' in output
  output = b''
  os.kill(p.pid, signal.SIGCONT)
  until(b'RESUME')
  until(b'\\x1b[?1004h')
  assert b'\\x1b[?1004h' in output
 output = b''
 p.stdin.write(b'crash'); p.stdin.flush()
 rest, errors = p.communicate(timeout=3)
 output += rest
 assert p.returncode != 0
 assert b'\\x1b[?1004l' in output
 print('stopped twice; resumed twice; crash restored focus')
finally:
 if p.poll() is None:
  os.kill(p.pid, signal.SIGCONT)
  p.kill()
  p.wait()
`
    driver = Bun.spawn(['python3', '-c', script, process.execPath, entry], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      driver.exited,
      new Response(driver.stdout as ReadableStream<Uint8Array>).text(),
      new Response(driver.stderr as ReadableStream<Uint8Array>).text(),
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toContain('crash restored focus')
  } finally {
    driver?.kill()
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abDispatch } from './dispatch'
import { resolveRepoState } from './repo-state'
import { openStoreForRepoState } from './store-opening'
import { createTerminalModeController } from './terminal-restore'
import {
  installDispatchKernelSignalHandlers,
  superviseDispatchChild,
  type DispatchSubprocess,
  watchDispatchParent,
} from './dispatch-process'
import { DISPATCHER } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { GIT_ID, git } from '../integration/harness'
import { MemoryBuildStore } from '../store/memory'

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

function supervisorFixture(store: MemoryBuildStore, child: DispatchSubprocess, timeout = 5) {
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
  test('kernel signal handlers remain armed through repeated stop signals', () => {
    const boundary = new EventEmitter()
    let stops = 0
    const handlers = installDispatchKernelSignalHandlers(() => {
      stops += 1
    }, boundary)

    boundary.emit('SIGINT')
    boundary.emit('SIGINT')
    boundary.emit('SIGTERM')
    expect(stops).toBe(3)
    expect(boundary.listenerCount('SIGINT')).toBe(1)
    handlers.close()
    handlers.close()
    expect(boundary.listenerCount('SIGINT')).toBe(0)
  })

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

  test('graceful SIGINT records one normal stop', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    const child = fakeSubprocess((signal) => {
      if (signal === 'SIGINT') child.finish(0)
    })
    const supervisor = supervisorFixture(store, child)

    await supervisor.stop()
    await supervisor.completed

    const stopped = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(child.kills).toEqual(['SIGINT'])
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toMatchObject({ run: 'run-1', outcome: 'normal' })
  })

  test('a stuck child outside a tick is killed once and records one forced stop', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    const child = fakeSubprocess((signal) => {
      if (signal === 'SIGKILL') child.finish(137, 'SIGKILL')
    })
    const supervisor = supervisorFixture(store, child)

    await supervisor.stop()
    await supervisor.completed

    const stopped = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(child.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toMatchObject({ run: 'run-1', outcome: 'forced' })
  })

  test('timeout never kills an open ticket-claim tick', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: DISPATCHER,
      type: 'dispatcher.tick-started',
      payload: { run: 'run-1' },
    })
    const child = fakeSubprocess()
    const supervisor = supervisorFixture(store, child)
    const stopping = supervisor.stop()

    await Bun.sleep(15)
    expect(child.kills).toEqual(['SIGINT'])
    await store.appendRepo('/repo', {
      actor: DISPATCHER,
      type: 'dispatcher.tick-completed',
      payload: {
        run: 'run-1',
        queued: 0,
        observations: 0,
        counters: {
          merged: 0,
          closed: 0,
          conflicted: 0,
          abandoned: 0,
          discarded: 0,
          janitorFailed: 0,
          recovered: 0,
          dispatchFailed: 0,
          resumed: 0,
          swept: 0,
          dispatched: 0,
          authored: 0,
          bounced: 0,
          claimRaces: 0,
          invalidTickets: 0,
          dependencyBlocked: 0,
          harvestStarted: 0,
          harvestResumed: 0,
          harvestCompleted: 0,
          harvestEscalated: 0,
          harvestFailed: 0,
        },
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        dependencyDiagnostics: [],
      },
    })
    child.finish(0)
    await stopping
    await supervisor.completed
    expect(child.kills).toEqual(['SIGINT'])
  })
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
      expect(events.some((event) => event.type === 'dispatcher.tick-completed')).toBe(true)
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
    ).rejects.toThrow('dispatcher kernel exited with status 1')

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

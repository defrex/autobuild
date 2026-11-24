import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  DISPATCH_KERNEL_SIGNALS,
  installDispatchKernelSignalHandlers,
  superviseDispatchChild,
  type DispatchSubprocess,
} from './dispatch-process'
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
  test('kernel signal handlers remain armed through repeated stop signals', () => {
    const boundary = new EventEmitter()
    let stops = 0
    const received: string[] = []
    const handlers = installDispatchKernelSignalHandlers((signal) => {
      received.push(signal)
      stops += 1
    }, boundary)

    for (const signal of DISPATCH_KERNEL_SIGNALS) boundary.emit(signal)
    boundary.emit('SIGINT')
    expect(stops).toBe(DISPATCH_KERNEL_SIGNALS.length + 1)
    expect(received).toEqual([...DISPATCH_KERNEL_SIGNALS, 'SIGINT'])
    for (const signal of DISPATCH_KERNEL_SIGNALS) expect(boundary.listenerCount(signal)).toBe(1)
    handlers.close()
    handlers.close()
    for (const signal of DISPATCH_KERNEL_SIGNALS) expect(boundary.listenerCount(signal)).toBe(0)
  })

  test('graceful SIGINT records one normal stop', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    const child = fakeSubprocess((signal) => {
      if (signal === 'SIGINT') child.finish(0)
    })
    const supervisor = supervisorFixture(store, child)

    await supervisor.stop()
    const result = await supervisor.completed

    const stopped = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(child.kills).toEqual(['SIGINT'])
    expect(result).toEqual({ outcome: 'normal', exitCode: 0 })
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toMatchObject({ run: 'run-1', outcome: 'normal' })
  })

  test('a failed stop-request deposit still signals and drains the child once', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    const append = store.appendRepo.bind(store)
    let requests = 0
    store.appendRepo = async (repo, event) => {
      if (event.type === 'dispatcher.stop-requested') {
        requests += 1
        throw new Error('store temporarily unavailable')
      }
      return append(repo, event)
    }
    const child = fakeSubprocess((signal) => {
      if (signal === 'SIGINT') child.finish(0)
    })
    const supervisor = supervisorFixture(store, child)
    const stopping = supervisor.stop('SIGTERM')
    expect(supervisor.stop('SIGHUP')).toBe(stopping)
    await stopping
    expect(await supervisor.completed).toEqual({
      outcome: 'normal',
      exitCode: 0,
      signal: 'SIGTERM',
    })
    expect(requests).toBe(1)
    expect(child.kills).toEqual(['SIGINT'])
    const stops = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(stops).toHaveLength(1)
    expect(stops[0]?.payload).toMatchObject({ signal: 'SIGTERM', outcome: 'normal' })
  })

  test('a normal stop fact preserves a later nonzero cleanup exit without duplication', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run: 'run-1', outcome: 'normal', exitCode: 0 },
    })
    const child = fakeSubprocess()
    const supervisor = supervisorFixture(store, child)

    child.finish(17)
    const result = await supervisor.completed

    expect(result).toEqual({ outcome: 'normal', exitCode: 17 })
    const stopped = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toEqual({ run: 'run-1', outcome: 'normal', exitCode: 0 })
  })

  test('an unsolicited signalled exit records and returns actionable evidence', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    const child = fakeSubprocess()
    const supervisor = supervisorFixture(store, child)

    child.finish(143, 'SIGTERM')
    const result = await supervisor.completed

    expect(result).toEqual({
      outcome: 'abnormal',
      exitCode: 143,
      signal: 'SIGTERM',
      error: 'kernel process exited with status 143 (signal SIGTERM)',
    })
    const stopped = (await store.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toEqual({
      run: 'run-1',
      outcome: 'abnormal',
      exitCode: 143,
      signal: 'SIGTERM',
      error: 'kernel process exited with status 143 (signal SIGTERM)',
    })
  })

  test('a child exiting during the final journal read remains graceful', async () => {
    const backing = new MemoryBuildStore()
    await backing.ensureRepo('/repo')
    let releaseRead!: () => void
    let readEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      readEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let delayed = false
    const store = new Proxy(backing, {
      get(target, property) {
        if (property === 'getReducerValue') {
          return async (...args: Parameters<BuildStore['getReducerValue']>) => {
            if (!delayed) {
              delayed = true
              readEntered()
              await release
            }
            return target.getReducerValue(...args)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as BuildStore
    const child = fakeSubprocess()
    const supervisor = supervisorFixture(store, child)

    const stopping = supervisor.stop()
    child.finish(0)
    await entered
    releaseRead()
    await stopping
    const result = await supervisor.completed

    const stopped = (await backing.getRepoEvents('/repo')).filter(
      (event) => event.type === 'dispatcher.run-stopped',
    )
    expect(child.kills).toEqual(['SIGINT'])
    expect(result).toEqual({ outcome: 'normal', exitCode: 0 })
    expect(stopped).toHaveLength(1)
    expect(stopped[0]?.payload).toMatchObject({ run: 'run-1', outcome: 'normal' })
  })
})

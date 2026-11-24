import { describe, expect, jest, test } from 'bun:test'
import { BuildChildExitCoordinator, BuildChildShutdown } from './build-child-exit'

describe('BuildChildExitCoordinator', () => {
  test('preserves the first exit intent and launches exactly one helper across races', () => {
    const launches: unknown[] = []
    const exits: number[] = []
    let closes = 0
    const terminal = new BuildChildExitCoordinator({
      groupId: 123,
      stopTimeoutMs: 456,
      launchReaper: (options) => {
        launches.push(options)
        return 789
      },
      exit: (code) => exits.push(code),
    })
    terminal.setParentWatch({ close: () => closes++ })

    terminal.terminate(0)
    terminal.terminate(143)
    terminal.terminate(130)

    expect(launches).toEqual([{ groupId: 123, stopTimeoutMs: 456 }])
    expect(exits).toEqual([0])
    expect(closes).toBe(1)
  })
})

test('shutdown waits for persistence without a deadline and retains the first signal', () => {
  // A minute of fake time passes any deadline shutdown ever had (4 s).
  jest.useFakeTimers()
  try {
    const exits: number[] = []
    const terminal = new BuildChildExitCoordinator({
      groupId: 123,
      stopTimeoutMs: 456,
      launchReaper: () => 1,
      exit: (code) => exits.push(code),
    })
    const shutdown = new BuildChildShutdown(terminal)
    shutdown.request(130)
    shutdown.request(143)
    expect(shutdown.signal.aborted).toBe(true)
    jest.advanceTimersByTime(60_000)
    expect(exits).toEqual([])
    shutdown.finish(0)
    shutdown.finish(1)
    expect(exits).toEqual([130])
  } finally {
    jest.useRealTimers()
  }
})

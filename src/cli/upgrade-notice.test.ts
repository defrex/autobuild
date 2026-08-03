import { describe, expect, test } from 'bun:test'
import {
  UPGRADE_NOTICE_DEADLINE_MS,
  UPGRADE_NOTICE_INTERVAL_MS,
  startUpgradeNotice,
  type UpgradeNoticeScheduler,
  type UpgradeNoticeTimer,
} from './upgrade-notice'

class FakeScheduler implements UpgradeNoticeScheduler {
  intervals: Array<{ callback: () => void; ms: number; active: boolean }> = []
  timeouts: Array<{ callback: () => void; ms: number; active: boolean }> = []

  interval(callback: () => void, ms: number): UpgradeNoticeTimer {
    const entry = { callback, ms, active: true }
    this.intervals.push(entry)
    return { clear: () => (entry.active = false), unref: () => {} }
  }

  timeout(callback: () => void, ms: number): UpgradeNoticeTimer {
    const entry = { callback, ms, active: true }
    this.timeouts.push(entry)
    return { clear: () => (entry.active = false), unref: () => {} }
  }

  cadence(): void {
    for (const timer of this.intervals) if (timer.active) timer.callback()
  }

  expire(): void {
    for (const timer of this.timeouts) {
      if (!timer.active) continue
      timer.active = false
      timer.callback()
    }
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('upgrade notice lifecycle', () => {
  test('checks immediately and at each fixed four-hour boundary', async () => {
    const scheduler = new FakeScheduler()
    const versions = [undefined, '2.1.0', '2.2.0']
    const seen: string[] = []
    let calls = 0
    const stop = startUpgradeNotice({
      scheduler,
      probe: async () => versions[calls++],
      onAvailable: (version) => seen.push(version),
    })

    expect(scheduler.intervals[0]?.ms).toBe(UPGRADE_NOTICE_INTERVAL_MS)
    expect(scheduler.timeouts[0]?.ms).toBe(UPGRADE_NOTICE_DEADLINE_MS)
    await flush()
    expect(calls).toBe(1)
    expect(seen).toEqual([])

    scheduler.cadence()
    await flush()
    expect(calls).toBe(2)
    expect(seen).toEqual(['2.1.0'])

    scheduler.cadence()
    await flush()
    expect(calls).toBe(3)
    expect(seen).toEqual(['2.1.0', '2.2.0'])
    stop()
  })

  test('does not overlap checks and silently catches rejection', async () => {
    const scheduler = new FakeScheduler()
    let calls = 0
    let resolve!: (version: string | undefined) => void
    const pending = new Promise<string | undefined>((done) => (resolve = done))
    const seen: string[] = []
    const stop = startUpgradeNotice({
      scheduler,
      probe: async () => {
        calls += 1
        if (calls === 1) return pending
        throw new Error('offline')
      },
      onAvailable: (version) => seen.push(version),
    })

    scheduler.cadence()
    expect(calls).toBe(1)
    resolve('2.1.0')
    await flush()
    expect(seen).toEqual(['2.1.0'])

    scheduler.cadence()
    await flush()
    expect(calls).toBe(2)
    expect(seen).toEqual(['2.1.0'])
    stop()
  })

  test('stop and deadline abort hanging probes without awaiting them', async () => {
    const scheduler = new FakeScheduler()
    const signals: AbortSignal[] = []
    const never = () => new Promise<string | undefined>(() => {})
    const stop = startUpgradeNotice({
      scheduler,
      probe: (signal) => {
        signals.push(signal)
        return never()
      },
      onAvailable: () => {
        throw new Error('must not update')
      },
    })
    expect(signals[0]?.aborted).toBe(false)
    scheduler.expire()
    expect(signals[0]?.aborted).toBe(true)
    scheduler.cadence()
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    stop()
    stop()
    expect(signals[1]?.aborted).toBe(true)
    expect(scheduler.intervals[0]?.active).toBe(false)

    const second = new FakeScheduler()
    const secondSignals: AbortSignal[] = []
    const stopSecond = startUpgradeNotice({
      scheduler: second,
      probe: (signal) => {
        secondSignals.push(signal)
        return never()
      },
      onAvailable: () => {},
    })
    stopSecond()
    expect(secondSignals[0]?.aborted).toBe(true)
  })
})

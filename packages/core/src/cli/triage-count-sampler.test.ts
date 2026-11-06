import { describe, expect, test } from 'bun:test'
import { TRIAGE_COUNT_REFRESH_MS, TriageCountSampler, triageReader } from './triage-count-sampler'

function manual(start = Date.parse('2026-07-15T12:00:00.000Z')) {
  let now = start
  return {
    clock: () => new Date(now),
    at: (ms: number) => {
      now = start + ms
    },
  }
}

describe('TriageCountSampler', () => {
  test('reads at most once per 60 s, measured from read start', async () => {
    const time = manual()
    let reads = 0
    const sampler = new TriageCountSampler(async () => {
      reads += 1
      return reads
    }, time.clock)
    expect(TRIAGE_COUNT_REFRESH_MS).toBe(60_000)
    for (const ms of [0, 1_000, 30_000, 59_900]) {
      time.at(ms)
      sampler.poke()
      await sampler.settled()
    }
    expect(reads).toBe(1)
    expect(sampler.value).toBe(1)
    time.at(60_000)
    sampler.poke()
    await sampler.settled()
    expect(reads).toBe(2)
    expect(sampler.value).toBe(2)
  })

  test('a poke while a read is in flight starts none', async () => {
    const time = manual()
    let reads = 0
    let release: (value: number) => void = () => {}
    const sampler = new TriageCountSampler(() => {
      reads += 1
      return new Promise<number>((resolve) => {
        release = resolve
      })
    }, time.clock)
    sampler.poke()
    time.at(120_000)
    sampler.poke()
    expect(reads).toBe(1)
    expect(sampler.value).toBeUndefined()
    release(7)
    await sampler.settled()
    expect(sampler.value).toBe(7)
    sampler.poke()
    expect(reads).toBe(2)
  })

  test('failures and undefined keep the last good value', async () => {
    const time = manual()
    const answers: Array<() => Promise<number | undefined>> = [
      async () => {
        throw new Error('unavailable')
      },
      async () => 4,
      async () => undefined,
      () => Promise.reject(new Error('rejected')),
    ]
    let call = 0
    const sampler = new TriageCountSampler(() => answers[call++]!(), time.clock)
    const values: Array<number | undefined> = []
    for (let i = 0; i < answers.length; i++) {
      time.at(i * TRIAGE_COUNT_REFRESH_MS)
      sampler.poke()
      await sampler.settled()
      values.push(sampler.value)
    }
    expect(values).toEqual([undefined, 4, 4, 4])
  })

  test('a count change converges on the next 60 s read with no further update', async () => {
    const time = manual()
    let triage = 2
    const sampler = new TriageCountSampler(async () => triage, time.clock)
    sampler.poke()
    await sampler.settled()
    expect(sampler.value).toBe(2)
    time.at(10_000)
    triage = 5
    sampler.poke()
    await sampler.settled()
    expect(sampler.value).toBe(2)
    time.at(60_000)
    sampler.poke()
    await sampler.settled()
    expect(sampler.value).toBe(5)
  })
})

describe('triageReader', () => {
  test('prefers countStates for the triage state alone', async () => {
    const asked: string[][] = []
    let lists = 0
    const read = triageReader(
      {
        countStates: async (names) => {
          asked.push([...names])
          return [{ name: 'triage', tickets: 3 }]
        },
        listStates: async () => {
          lists += 1
          return []
        },
      },
      () => 'Triage',
    )
    expect(await read()).toBe(3)
    expect(asked).toEqual([['Triage']])
    expect(lists).toBe(0)
  })

  test('never lists states without countStates', async () => {
    const read = triageReader(
      {
        listStates: async () => {
          throw new Error('must never list states')
        },
      },
      () => 'Triage',
    )
    expect(await read()).toBeUndefined()
  })

  test('a source with neither has no count', async () => {
    expect(await triageReader({}, () => 'Triage')()).toBeUndefined()
  })
})

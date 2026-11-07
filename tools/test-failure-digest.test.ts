import { describe, expect, test } from 'bun:test'
import {
  FAILURE_DIGEST_LIMIT,
  MIN_SECTION,
  allocateSections,
  createFailureCollector,
  formatFailureDigest,
} from './test-failure-digest'

// Verbatim bun 1.4.4 non-TTY stderr from two scratch test files: console
// noise before a toEqual diff, a multi-line thrown error, a timeout, an
// unhandled async error reported against the next test, and a toBe failure
// in a second file. Only the absolute path prefix was rewritten.
const BUN_STDERR = String.raw`
a.test.ts:
console noise before the failure
1 | import { expect, test } from 'bun:test'
2 | test('passes quietly', () => { console.log('noise from a passing test'); expect(1).toBe(1) })
3 | test('deep equal fails', () => {
4 |   console.error('console noise before the failure')
5 |   expect({ a: 1, b: [1, 2] }).toEqual({ a: 2, b: [1, 3] })
                                  ^
error: expect(received).toEqual(expected)

@@ -1,6 +1,6 @@
  {
-   "a": 2,
+   "a": 1,
    "b": [
      1,
-     3,
+     2,
    ],

- Expected  - 2
+ Received  + 2

      at <anonymous> (/repo/tools/a.test.ts:5:31)
(fail) deep equal fails [0.37ms]
3 | test('deep equal fails', () => {
4 |   console.error('console noise before the failure')
5 |   expect({ a: 1, b: [1, 2] }).toEqual({ a: 2, b: [1, 3] })
6 | })
7 | test('throws multi-line', () => {
8 |   throw new Error('first line\nsecond line')
                                               ^
error: first line
second line
      at <anonymous> (/repo/tools/a.test.ts:8:44)
(fail) throws multi-line [0.10ms]
(fail) times out [50.09ms]
  ^ this test timed out after 50ms.
 6 | })
 7 | test('throws multi-line', () => {
 8 |   throw new Error('first line\nsecond line')
 9 | })
10 | test('times out', async () => { await new Promise((r) => setTimeout(r, 200)) }, 50)
11 | test('async leak', () => { setTimeout(() => { throw new Error('unhandled later') }, 0) })
                                                                                    ^
error: unhandled later
      at <anonymous> (/repo/tools/a.test.ts:11:80)
(fail) next after leak [1.28ms]

b.test.ts:
1 | import { expect, test } from 'bun:test'
2 | test('tobe fails', () => { expect('left').toBe('right') })
                                              ^
error: expect(received).toBe(expected)

Expected: "right"
Received: "left"

      at <anonymous> (/repo/tools/b.test.ts:2:43)
(fail) tobe fails [0.12ms]

 2 pass
 5 fail
 3 expect() calls
Ran 7 tests across 2 files. [55.00ms]
`

function collect(chunks: readonly string[]) {
  const collector = createFailureCollector()
  for (const chunk of chunks) collector.push(chunk)
  return collector.failures()
}

function shortFailure(index: number): string {
  return [
    `${index} | expect(value${index}).toBe(expected${index})`,
    `error: expect(received).toBe(expected) #${index}`,
    '',
    `Expected: "right-${index}"`,
    `Received: "left-${index}"`,
    '',
    `      at <anonymous> (/repo/tools/short.test.ts:${index}:7)`,
    `(fail) short failure ${index} [0.10ms]`,
  ].join('\n')
}

function longFailure(name: string, size: number): string {
  return [
    `error: ${name} head message`,
    'x'.repeat(size),
    `      at <anonymous> (/repo/tools/${name}.test.ts:1:1)`,
    `(fail) ${name} [1.00ms]`,
  ].join('\n')
}

describe('createFailureCollector', () => {
  test("extracts names, files, and each failure's detail", () => {
    const failures = collect([BUN_STDERR])

    expect(failures.map(({ file, name }) => ({ file, name }))).toEqual([
      { file: 'a.test.ts', name: 'deep equal fails' },
      { file: 'a.test.ts', name: 'throws multi-line' },
      { file: 'a.test.ts', name: 'times out' },
      { file: 'a.test.ts', name: 'next after leak' },
      { file: 'b.test.ts', name: 'tobe fails' },
    ])
    const [deepEqual, multiLine, timedOut, afterLeak, toBe] = failures
    expect(deepEqual?.detail).toContain('error: expect(received).toEqual(expected)')
    expect(deepEqual?.detail).toContain('-   "a": 2,')
    expect(deepEqual?.detail).toContain('+   "a": 1,')
    expect(deepEqual?.detail).toContain('at <anonymous> (/repo/tools/a.test.ts:5:31)')
    expect(multiLine?.detail).toContain('error: first line\nsecond line')
    expect(timedOut?.detail).toBe('^ this test timed out after 50ms.')
    expect(afterLeak?.detail).toContain('error: unhandled later')
    expect(afterLeak?.detail).not.toContain('timed out')
    expect(toBe?.detail).toContain('Expected: "right"\nReceived: "left"')
  })

  test('chunk boundaries splitting lines give the same result', () => {
    const whole = collect([BUN_STDERR])
    for (const size of [1, 7, 64]) {
      const chunks: string[] = []
      for (let start = 0; start < BUN_STDERR.length; start += size)
        chunks.push(BUN_STDERR.slice(start, start + size))
      expect(collect(chunks)).toEqual(whole)
    }
  })

  test('strips ANSI codes and resets the block on pass lines', () => {
    const failures = collect([
      'noise from a passing test\n\x1b[32m(pass)\x1b[0m quiet [0.01ms]\n',
      'error: boom\r\n\x1b[31m(fail)\x1b[0m loud [0.02ms]\r\n',
    ])
    expect(failures).toEqual([{ name: 'loud', detail: 'error: boom' }])
  })

  test('bounds an oversized block to its tail', () => {
    const failures = collect([`${'y'.repeat(100_000)}\nerror: tail\n(fail) huge\n`])
    expect(failures[0]?.detail.length).toBeLessThanOrEqual(64_000)
    expect(failures[0]?.detail.endsWith('\nerror: tail')).toBe(true)
  })

  test('bounds the failures it keeps and counts the rest', () => {
    const collector = createFailureCollector()
    for (let index = 0; index < 205; index += 1) collector.push(`(fail) test ${index}\n`)
    expect(collector.failures()).toHaveLength(200)
    expect(collector.omitted()).toBe(5)
  })
})

describe('allocateSections', () => {
  test('keeps every length when everything fits', () => {
    expect(allocateSections([100, 200, 300], 600)).toEqual({ caps: [100, 200, 300] })
  })

  test('water-fills: short sections stay whole, long ones share the rest', () => {
    expect(allocateSections([100, 5_000, 200, 9_000], 2_300)).toEqual({
      caps: [100, 1_000, 200, 1_000],
    })
    // A section exactly at the cap stays complete.
    expect(allocateSections([500, 500, 9_000], 1_500)).toEqual({ caps: [500, 500, 500] })
  })

  test('switches to names-only only when the cap would fall below the minimum', () => {
    const atMinimum = allocateSections([1_000, 1_000, 1_000], 3 * MIN_SECTION)
    expect(atMinimum.caps).toEqual([MIN_SECTION, MIN_SECTION, MIN_SECTION])

    const below = allocateSections([1_000, 1_000, 1_000], 3 * MIN_SECTION - 1, [20, 20, 20])
    expect(below.caps.slice(0, 2).every((cap) => cap !== null && cap >= MIN_SECTION)).toBe(true)
    expect(below.caps[2]).toBeNull()
  })
})

describe('formatFailureDigest', () => {
  test('no failures gives an empty digest', () => {
    expect(formatFailureDigest([])).toBe('')
  })

  test('keeps the fixture failures in full', () => {
    const digest = formatFailureDigest(collect([BUN_STDERR]))
    expect(digest.startsWith('=== failure digest: 5 failing test(s)')).toBe(true)
    expect(digest).toContain('--- (fail) a.test.ts > deep equal fails ---')
    expect(digest).toContain('--- (fail) b.test.ts > tobe fails ---')
    expect(digest).toContain('+     2,')
    expect(digest).toContain('at <anonymous> (/repo/tools/b.test.ts:2:43)')
    // Console noise that preceded the excerpt is trimmed from the section.
    expect(digest).not.toMatch(/^console noise before the failure$/m)
    expect(digest).not.toContain('elided')
  })

  test('fourteen short failures all appear in full', () => {
    const stderr = `tools/short.test.ts:\n${Array.from({ length: 14 }, (_, index) => shortFailure(index)).join('\n')}\n`
    const failures = collect([stderr])
    expect(failures).toHaveLength(14)

    const digest = formatFailureDigest(failures)

    expect(digest.length).toBeLessThanOrEqual(FAILURE_DIGEST_LIMIT)
    for (let index = 0; index < 14; index += 1) {
      expect(digest).toContain(`--- (fail) tools/short.test.ts > short failure ${index} ---`)
      expect(digest).toContain(`error: expect(received).toBe(expected) #${index}`)
      expect(digest).toContain(`Expected: "right-${index}"\nReceived: "left-${index}"`)
      expect(digest).toContain(`at <anonymous> (/repo/tools/short.test.ts:${index}:7)`)
    }
    expect(digest).not.toContain('elided')
    expect(digest).not.toMatch(/^\(fail\) /m)
  })

  test('over budget: short sections stay whole and long ones share the remainder', () => {
    const stderr = [
      'tools/mixed.test.ts:',
      shortFailure(1),
      longFailure('huge-a', 20_000),
      shortFailure(2),
      longFailure('huge-b', 20_000),
      shortFailure(3),
      '',
    ].join('\n')

    const digest = formatFailureDigest(collect([stderr]))

    expect(digest.length).toBeLessThanOrEqual(FAILURE_DIGEST_LIMIT)
    expect(digest.length).toBeGreaterThan(FAILURE_DIGEST_LIMIT - 10)
    for (const index of [1, 2, 3])
      expect(digest).toContain(`Expected: "right-${index}"\nReceived: "left-${index}"\n\n      at`)
    const sections = digest.split('\n--- (fail) ').slice(1)
    const huge = sections.filter((section) => section.includes('huge-'))
    expect(huge).toHaveLength(2)
    expect(Math.abs((huge[0]?.length ?? 0) - (huge[1]?.length ?? 0))).toBeLessThanOrEqual(1)
    for (const name of ['huge-a', 'huge-b']) {
      const section = huge.find((each) => each.startsWith(`tools/mixed.test.ts > ${name}`)) ?? ''
      expect(section).toContain(`error: ${name} head message`)
      expect(section).toMatch(/… \(\d+ chars elided\) …/)
      expect(section).toContain(`at <anonymous> (/repo/tools/${name}.test.ts:1:1)`)
    }
  })

  test('genuine overflow details the leading failures and lists or counts the rest', () => {
    const stderr = [
      'tools/many.test.ts:',
      ...Array.from({ length: 300 }, (_, index) => longFailure(`many-${index}`, 2_000)),
      '',
    ].join('\n')
    const collector = createFailureCollector()
    collector.push(stderr)

    const digest = formatFailureDigest(collector.failures(), { omitted: collector.omitted() })

    expect(digest.length).toBeLessThanOrEqual(FAILURE_DIGEST_LIMIT)
    expect(digest.startsWith('=== failure digest: 300 failing test(s)')).toBe(true)
    const detailed = digest.split('\n--- (fail) ').slice(1)
    expect(detailed.length).toBeGreaterThan(0)
    const lastDetailed = detailed.at(-1)?.split('\n(fail) ')[0] ?? ''
    for (const section of [...detailed.slice(0, -1), lastDetailed])
      expect(section.length + '\n--- (fail) '.length).toBeGreaterThanOrEqual(MIN_SECTION - 1)
    const named = digest.split('\n').filter((line) => line.startsWith('(fail) ')).length
    const more = Number(/… and (\d+) more failing tests$/.exec(digest)?.[1] ?? 0)
    expect(detailed.length + named + more).toBe(300)
  })
})

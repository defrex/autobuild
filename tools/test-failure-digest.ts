/**
 * Collects bun's per-test failure detail from a suite's stderr and formats a
 * bounded digest of it. The kernel stores only the last 10,000 characters of a
 * verify step's output, so a failing suite's report otherwise keeps the run's
 * tail and loses every earlier failure's message, diff and stack. The suite
 * runner prints this digest as its final write, inside that tail.
 *
 * The parser follows bun 1.4.4's non-TTY reporter: a `path.test.ts:` file
 * header, then each failure's detail (source excerpt, `error:` line, diff,
 * `at …` stack) immediately before its `(fail) <name> [<ms>]` line. A timeout
 * prints `  ^ this test timed out after Nms.` immediately after the `(fail)`
 * line, and an unhandled async error lands in the next test's block.
 */

/** Total digest characters, header included; below the kernel's 10,000. */
export const FAILURE_DIGEST_LIMIT = 8_000

/** A section is never detailed below this many characters. */
export const MIN_SECTION = 300

// Per-block memory bound. Large enough that a 20,000-char failure keeps its
// head `error:` line; the error detail sits at the block's end regardless.
const PENDING_LIMIT = 64_000
const MAX_FAILURES = 200
const NAME_LIMIT = 200
const MORE_LINE_RESERVE = 64

const ANSI_SGR = /\x1b\[[0-9;]*m/g
const FILE_HEADER = /^\S.*\.test\.tsx?:$/
const FAIL_LINE = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/
const RESET_LINE = /^\((?:pass|skip|todo)\) /
const TIMEOUT_LINE = /^\s+\^ this test timed out/
const EXCERPT_LINE = /^\s*\d+ \| /
const ERROR_LINE = /^(?:error|\w*Error):/

export type CollectedFailure = { file?: string; name: string; detail: string }

export type FailureCollector = {
  push(chunk: string): void
  failures(): readonly CollectedFailure[]
  omitted(): number
}

export function createFailureCollector(): FailureCollector {
  const collected: CollectedFailure[] = []
  let omitted = 0
  let partial = ''
  let file: string | undefined
  let pending: string[] = []
  let pendingLength = 0
  let lastLineWasFail = false

  const clear = () => {
    pending = []
    pendingLength = 0
  }

  const line = (raw: string) => {
    const text = raw.replace(/\r$/, '').replace(ANSI_SGR, '')
    const previousWasFail = lastLineWasFail
    lastLineWasFail = false
    const fail = FAIL_LINE.exec(text)
    if (fail) {
      const detail = pending.join('\n')
      if (collected.length < MAX_FAILURES)
        collected.push({ ...(file === undefined ? {} : { file }), name: fail[1] ?? '', detail })
      else omitted += 1
      clear()
      lastLineWasFail = true
      return
    }
    if (previousWasFail && TIMEOUT_LINE.test(text)) {
      const last = collected.at(-1)
      if (last && omitted === 0)
        last.detail = last.detail ? `${last.detail}\n${text.trim()}` : text.trim()
      return
    }
    if (FILE_HEADER.test(text)) {
      file = text.slice(0, -1)
      clear()
      return
    }
    if (RESET_LINE.test(text)) {
      clear()
      return
    }
    pending.push(text)
    pendingLength += text.length + 1
    while (pendingLength > PENDING_LIMIT) {
      const first = pending[0] ?? ''
      const excess = pendingLength - PENDING_LIMIT
      if (pending.length > 1 && first.length + 1 <= excess) {
        pending.shift()
        pendingLength -= first.length + 1
      } else {
        // One oversized line: keep its tail rather than dropping the block.
        pending[0] = first.slice(excess)
        pendingLength -= excess
      }
    }
  }

  return {
    push(chunk) {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const each of lines) line(each)
    },
    failures() {
      // A trailing unterminated line cannot be a `(fail)` line yet; bun always
      // ends result lines with a newline, so it stays buffered.
      return collected
    },
    omitted() {
      return omitted
    },
  }
}

/**
 * Drop console noise that precedes a failure's error: start at the block's
 * first source-excerpt or error line (`error:`, `TypeError:`,
 * `PackedInstallError:` …). bun prints a failure's excerpt and error line
 * first, so everything after that point belongs to the failure, including
 * `error:` lines embedded in a multi-line message. Only budget elision cuts it.
 */
function errorSection(detail: string): string {
  const lines = detail.split('\n')
  const start = lines.findIndex((text) => EXCERPT_LINE.test(text) || ERROR_LINE.test(text))
  return (start < 0 ? lines : lines.slice(start)).join('\n').trim()
}

/** The largest cap `C` with `Σ min(length, C) ≤ budget` (water-filling). */
function waterLevel(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((left, right) => left - right)
  let remaining = budget
  for (const [index, length] of sorted.entries()) {
    const share = Math.floor(remaining / (sorted.length - index))
    if (length > share) return share
    remaining -= length
  }
  return Number.POSITIVE_INFINITY
}

/**
 * Allocate the digest budget across sections from their actual lengths. When
 * every section fits, each keeps its full length. Otherwise sections longer
 * than the water-filled cap are cut to it. Only when that cap would fall below
 * {@link MIN_SECTION} does the tail of the list become names-only (`null`),
 * reserving `nameLengths` (each names-only line's cost) plus a closing count.
 */
export function allocateSections(
  lengths: readonly number[],
  budget: number,
  nameLengths: readonly number[] = [],
): { caps: (number | null)[] } {
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total <= budget) return { caps: [...lengths] }
  const cap = (k: number, available: number) => waterLevel(lengths.slice(0, k), available)
  const allocate = (k: number, available: number) => ({
    caps: lengths.map((length, index) => (index < k ? Math.min(length, cap(k, available)) : null)),
  })
  const level = cap(lengths.length, budget)
  if (level >= MIN_SECTION) return allocate(lengths.length, budget)
  // Reserve the full names-only list when it fits; otherwise only the count.
  for (const reserveAllNames of [true, false])
    for (let k = lengths.length - 1; k >= 1; k -= 1) {
      const names = reserveAllNames
        ? nameLengths.slice(k).reduce((sum, length) => sum + length, 0)
        : 0
      const available = budget - names - MORE_LINE_RESERVE
      if (available > 0 && cap(k, available) >= MIN_SECTION) return allocate(k, available)
    }
  return { caps: lengths.map(() => null) }
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function failureLabel(failure: CollectedFailure): string {
  const name = clip(failure.name, NAME_LIMIT)
  return failure.file === undefined ? name : `${clip(failure.file, NAME_LIMIT)} > ${name}`
}

/** Cut `section` to `cap` characters, keeping its heading, head ⅔ and tail ⅓. */
function elide(heading: string, detail: string, cap: number): string {
  const available = cap - heading.length - 1
  if (detail.length <= available) return `${heading}\n${detail}`
  const elided = (kept: number) => `\n… (${detail.length - kept} chars elided) …\n`
  const room = available - elided(0).length
  if (room <= 0) return `${heading}\n${detail}`.slice(0, cap)
  const head = Math.floor((room * 2) / 3)
  const tail = room - head
  return `${heading}\n${detail.slice(0, head)}${elided(head + tail)}${detail.slice(-tail)}`
}

/**
 * Format a bounded digest of the collected failures, at most `limit`
 * characters long: one `--- (fail) <file> > <name> ---` section per failure
 * with its error detail, allocated by {@link allocateSections}. Returns `''`
 * when there are no failures.
 */
export function formatFailureDigest(
  failures: readonly CollectedFailure[],
  options: { limit?: number; omitted?: number } = {},
): string {
  const limit = options.limit ?? FAILURE_DIGEST_LIMIT
  const omitted = options.omitted ?? 0
  if (failures.length === 0 && omitted === 0) return ''
  const count = failures.length + omitted
  const header = `=== failure digest: ${count} failing test(s) (bounded to ${limit} chars) ===`
  const headings = failures.map((failure) => `--- (fail) ${failureLabel(failure)} ---`)
  const details = failures.map((failure) => errorSection(failure.detail))
  const names = failures.map((failure) => `(fail) ${failureLabel(failure)}`)
  // Each part costs its own length plus the newline that joins it.
  const lengths = headings.map(
    (heading, index) => heading.length + 1 + (details[index]?.length ?? 0) + 1,
  )
  const reserve = omitted > 0 ? MORE_LINE_RESERVE : 0
  const budget = limit - header.length - reserve
  const { caps } = allocateSections(
    lengths,
    budget,
    names.map((name) => name.length + 1),
  )

  const parts = [header]
  let used = header.length
  let unlisted = omitted
  for (const [index, cap] of caps.entries()) {
    const heading = headings[index] ?? ''
    const detail = details[index] ?? ''
    if (cap !== null) {
      const section = elide(heading, detail, cap - 1)
      parts.push(section)
      used += section.length + 1
      continue
    }
    const name = names[index] ?? ''
    if (used + name.length + 1 + MORE_LINE_RESERVE <= limit) {
      parts.push(name)
      used += name.length + 1
    } else unlisted += 1
  }
  if (unlisted > 0) parts.push(`… and ${unlisted} more failing tests`)
  // The allocation keeps the digest within `limit`; the slice is a final guard.
  return parts.join('\n').slice(0, limit)
}

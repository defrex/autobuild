/**
 * `defaultDelay` — the abortable real-timer sleep behind the remote long-poll
 * runner. The runner itself is unit-tested in `remote-poll.test.ts`.
 */
import { describe, test } from 'bun:test'
import { defaultDelay } from './remote-poll'

// ── defaultDelay ─────────────────────────────────────────────────────────────

describe('defaultDelay', () => {
  test('resolves after the requested delay and as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const slept = defaultDelay(5)
    const aborted = defaultDelay(1000, controller.signal)
    const alreadyAborted = defaultDelay(1000, AbortSignal.abort())
    const timer = setTimeout(() => controller.abort(), 1)
    await Promise.all([slept, aborted, alreadyAborted])
    clearTimeout(timer)
  })
})

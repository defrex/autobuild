import type { BuildState } from './reducer'
import type { BuildStore } from '../store/types'
import { DISPATCHER } from '../events/envelope'
export async function recordJanitorFailure(
  store: BuildStore,
  slug: string,
  previous: BuildState['janitor'],
  message: string,
  now: Date,
  policy: { janitorBackoffMaxSeconds: number; janitorFailureAttentionSeconds: number },
): Promise<void> {
  const attempt = (previous?.attempt ?? 0) + 1
  const firstFailureAt = previous?.firstFailureAt ?? now.toISOString()
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.janitor-attempt-failed',
    payload: {
      firstFailureAt,
      attempt,
      message,
      nextAttemptAt: new Date(
        now.getTime() +
          Math.min(policy.janitorBackoffMaxSeconds, 30 * 2 ** Math.min(attempt - 1, 30)) * 1000,
      ).toISOString(),
    },
  })
  if (
    !previous?.attention &&
    now.getTime() - Date.parse(firstFailureAt) >= policy.janitorFailureAttentionSeconds * 1000
  )
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.janitor-failing',
      payload: { message },
    })
}

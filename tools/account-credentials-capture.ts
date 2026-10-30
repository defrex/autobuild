import { missingAccountCredentials } from '../packages/core/src/accounts/availability'
import {
  buildDashboardFromProjected,
  type DashboardModel,
} from '../packages/core/src/cli/dashboard/model'
import { DISPATCHER } from '../packages/core/src/events/envelope'
import type { RepositoryEvent } from '../packages/core/src/events/repository'

/** Shared production projection over a deterministic credential episode. */
export function accountCredentialsCapture(
  model: DashboardModel,
  recovered = false,
): DashboardModel {
  const payload = missingAccountCredentials(
    { billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' } },
    {},
    'project-secrets',
  )[0]!
  const envelope = { repo: model.repo, seq: 1, ts: '2026-10-29T00:00:00.000Z', actor: DISPATCHER }
  const events: RepositoryEvent[] = [
    { ...envelope, type: 'account.credentials-unavailable', payload },
  ]
  if (recovered)
    events.push({
      ...envelope,
      seq: 2,
      type: 'account.credentials-recovered',
      payload: { name: payload.name },
    })
  const projected = buildDashboardFromProjected(
    [],
    {
      repo: model.repo,
      queued: 0,
      activeCount: 0,
      capacity: 4,
      observationCount: 0,
      observationLimit: 5,
    },
    events,
  )
  return { ...model, warningLines: projected.warningLines }
}

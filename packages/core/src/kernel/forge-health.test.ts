import { expect, test } from 'bun:test'
import type { RepositoryEvent } from '../events/repository'
import {
  activeForgeCredentialLimits,
  FORGE_CREDENTIAL_LIMIT_CAP,
  forgeCredentialLimitsReducer,
  forgeHealthReducer,
} from './forge-health'

const limited = (seq: number, process: string, resetAt: string) =>
  ({
    repo: 'r',
    seq,
    ts: '2026-11-11T21:35:54.921Z',
    actor: { kind: 'kernel' },
    type: 'forge.credential-limited',
    payload: {
      forge: 'github',
      process,
      credential: 'unauthenticated',
      missingCredential: 'unset',
      message: 'limit',
      resetAt,
    },
  }) as RepositoryEvent

test('credential limits keep the latest per process, bounded, and never degrade the repository', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 22, minutes)).toISOString()
  const events = [
    limited(1, 'build-runner a', at(1)),
    limited(2, 'build-runner a', at(5)),
    ...Array.from({ length: FORGE_CREDENTIAL_LIMIT_CAP + 4 }, (_, i) =>
      limited(3 + i, `build-runner p${i}`, at(10 + i)),
    ),
  ]
  const limits = forgeCredentialLimitsReducer.reduce(events)
  expect(limits).toHaveLength(FORGE_CREDENTIAL_LIMIT_CAP)
  // The oldest resets fall out first; the newest reset survives.
  expect(limits.map((limit) => limit.process)).not.toContain('build-runner a')
  expect(limits.at(-1)?.process).toBe(`build-runner p${FORGE_CREDENTIAL_LIMIT_CAP + 3}`)
  expect(limits[0]?.at).toBe('2026-11-11T21:35:54.921Z')
  expect(forgeHealthReducer.reduce(events)).toBeUndefined()
  // Expiry is a read-time projection: a reset at or before now is inactive.
  expect(
    activeForgeCredentialLimits(limits, new Date(at(27))).map((limit) => limit.process),
  ).toEqual(['build-runner p18', 'build-runner p19'])
})

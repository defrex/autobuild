import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER } from '../events/envelope'
import { getRepositoryStatus } from '../operator/query'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'
import { MemoryBuildStore } from '../store/memory'
import type { RepositoryArtifact } from '../store/types'
import { localOverridesFromArtifact, renderRepositoryStatus } from './repository-status'

const REPO = '/main/repo'
const LOCAL = '/main/repo/.autobuild/local.toml'

function artifact(metadata: Record<string, unknown>): Pick<RepositoryArtifact, 'meta'> {
  return {
    meta: {
      kind: 'dispatcher-effective-config',
      revision: 0,
      blobRef: 'b',
      metadata,
      createdAt: '2026-11-23T00:00:00.000Z',
    } as RepositoryArtifact['meta'],
  }
}

describe('local overrides in repository status', () => {
  test('reads the record from effective-config artifact metadata defensively', () => {
    const record = { file: LOCAL, settings: ['capacity', 'roles.default.model'] }
    expect(localOverridesFromArtifact(artifact({ run: 'r1', localOverrides: record }))).toEqual(
      record,
    )
    expect(localOverridesFromArtifact(artifact({ run: 'r1' }))).toBeUndefined()
    expect(localOverridesFromArtifact(undefined)).toBeUndefined()
    for (const malformed of [
      'capacity',
      [],
      { file: 1, settings: [] },
      { file: LOCAL, settings: 'capacity' },
      { file: LOCAL, settings: [1] },
    ])
      expect(localOverridesFromArtifact(artifact({ localOverrides: malformed }))).toBeUndefined()
  })

  test('status reports and renders the held dispatcher local overrides', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    const config = parseConfig(`
capacity = 3
[tickets]
source = "file"
readyState = "ready"
`)
    await store.appendRepoWithArtifacts(
      REPO,
      [
        {
          kind: 'dispatcher-effective-config',
          content: effectiveBuildConfigContent(config),
          metadata: { run: 'r1', localOverrides: { file: LOCAL, settings: ['capacity'] } },
        },
      ],
      (deposited) => ({
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'r1',
          pid: 1,
          host: 'h',
          effectiveConfig: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          roleWarnings: [],
        },
      }),
    )
    expect(await store.claimRepoLease(REPO, 'r1', 60_000)).toBe(true)
    const status = await getRepositoryStatus(store, REPO)
    expect(status.localOverrides).toEqual({ file: LOCAL, settings: ['capacity'] })
    expect(renderRepositoryStatus(status)).toContain(
      `dispatcher local overrides (${LOCAL}): capacity`,
    )
    await store.releaseRepoLease(REPO, 'r1')
    const released = await getRepositoryStatus(store, REPO)
    expect(released).not.toHaveProperty('localOverrides')
    expect(renderRepositoryStatus(released).join('\n')).not.toContain('local overrides')
  })
})

import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { Artifact } from '../store/types'
import { buildOwnedSectionsDiffer, parseBuildConfigMetadata } from './build-execution-state'

function artifact(metadata: Record<string, unknown>): Artifact {
  return {
    meta: {
      build: 'b1',
      kind: 'build-runner-effective-config',
      revision: 0,
      blobRef: '',
      metadata,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    content: new Uint8Array(),
  }
}

const BASE = `
[tickets]
source = "file"
readyState = "ready"

[commands]
unit = "bun test"

[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "unit"
`

describe('parseBuildConfigMetadata (SPEC §16.1)', () => {
  test('reads the revision and a valid pipeline source', () => {
    expect(
      parseBuildConfigMetadata(
        artifact({
          revision: 3,
          pipelineSource: { ref: 'branch-head', commit: 'abc123' },
        }),
      ),
    ).toEqual({ revision: 3, pipelineSource: { ref: 'branch-head', commit: 'abc123' } })
  })

  test('omits an absent, malformed, or unknown-ref pipeline source', () => {
    expect(parseBuildConfigMetadata(artifact({ revision: 0 }))).toEqual({ revision: 0 })
    expect(parseBuildConfigMetadata(artifact({ pipelineSource: { ref: 'elsewhere' } }))).toEqual({})
    expect(parseBuildConfigMetadata(artifact({ pipelineSource: 'nonsense' }))).toEqual({})
  })

  test('drops a non-string commit but keeps the ref', () => {
    expect(
      parseBuildConfigMetadata(artifact({ pipelineSource: { ref: 'base', commit: 7 } })),
    ).toEqual({ pipelineSource: { ref: 'base' } })
  })
})

describe('buildOwnedSectionsDiffer (SPEC §16.1)', () => {
  test('detects pipeline changes and ignores deployment-only changes', () => {
    const base = parseConfig(BASE)
    const pipelineChanged = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
unit = "bun test"
lint = "bun run check"

[verify]
steps = ["unit", "lint"]
[verify.unit]
kind = "check"
command = "unit"
[verify.lint]
kind = "check"
command = "lint"
`)
    const deploymentChanged = parseConfig(`${BASE}
[policy]
stallRounds = 9
`)
    expect(buildOwnedSectionsDiffer(base, pipelineChanged)).toBe(true)
    expect(buildOwnedSectionsDiffer(base, deploymentChanged)).toBe(false)
  })
})

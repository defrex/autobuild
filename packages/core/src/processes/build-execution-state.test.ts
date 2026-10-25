import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { Artifact } from '../store/types'
import {
  buildOwnedSectionsDiffer,
  effectiveBuildConfigContent,
  parseEffectiveBuildConfig,
  parseBuildConfigMetadata,
} from './build-execution-state'

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

describe('effective build config verification policy', () => {
  test.each([true, false])(
    'preserves repository %s and opposite step override across deposits',
    (enabled) => {
      const config = parseConfig(
        BASE.replace('[verify]\n', `[verify]\nafterReconcile = ${enabled}\n`) +
          `afterReconcile = ${!enabled}\n`,
      )
      let current = config
      for (let deposit = 0; deposit < 2; deposit++) {
        const content = effectiveBuildConfigContent(current)
        expect(JSON.parse(content).verify.afterReconcile).toBe(enabled)
        current = parseEffectiveBuildConfig({
          ...artifact({}),
          content: new TextEncoder().encode(content),
        })
        expect(current).toEqual(config)
        expect(current.verify.afterReconcile).toBe(enabled)
        expect(current.verify.stepConfigs.unit?.afterReconcile).toBe(!enabled)
      }
    },
  )

  test('historical deposits without the scalar keep the default enabled policy', () => {
    const content = JSON.parse(effectiveBuildConfigContent(parseConfig(BASE)))
    delete content.verify.afterReconcile
    expect(
      parseEffectiveBuildConfig({
        ...artifact({}),
        content: new TextEncoder().encode(JSON.stringify(content)),
      }).verify.afterReconcile,
    ).toBe(true)
  })
})

describe('effective config stage pinning', () => {
  test.each(['[["a", "b"], "c"]', '[["a"], "b", "c"]', '["a", "b", "c"]', '[]'])(
    'preserves normalized stages through repeated deposits: %s',
    (steps) => {
      const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
check = "true"
[verify]
steps = ${steps}
afterReconcile = false
${steps === '[]' ? '' : ['a', 'b', 'c'].map((name) => `[verify.${name}]\nkind = "check"\ncommand = "check"\nfailFast = true\nafterReconcile = true\nalways = true\n`).join('')}
`)
      let current = config
      for (let i = 0; i < 3; i++) {
        const content = effectiveBuildConfigContent(current)
        expect(JSON.parse(content).verify).not.toHaveProperty('stages')
        expect(JSON.parse(content).verify.steps).toEqual(
          config.verify.stages ?? config.verify.steps,
        )
        current = parseEffectiveBuildConfig({
          ...artifact({}),
          content: new TextEncoder().encode(content),
        })
        expect(current).toEqual(config)
        expect(current.verify.steps).toEqual(steps === '[]' ? [] : ['a', 'b', 'c'])
        if (!steps.includes('[[')) expect(current.verify).not.toHaveProperty('stages')
        // A deployment-only redeposit must keep the pipeline pin intact.
        current = { ...current, policy: { ...current.policy, stallRounds: 9 } }
        expect(buildOwnedSectionsDiffer(config, current)).toBe(false)
        current = parseEffectiveBuildConfig({
          ...artifact({}),
          content: new TextEncoder().encode(effectiveBuildConfigContent(current)),
        })
        expect(current.policy.stallRounds).toBe(9)
        expect(current.verify).toEqual(config.verify)
        current = { ...current, policy: config.policy }
      }
    },
  )

  test('legacy flattened deposits stay flat when reused', () => {
    const legacy = JSON.parse(effectiveBuildConfigContent(parseConfig(BASE)))
    legacy.verify.steps = ['unit']
    const parsed = parseEffectiveBuildConfig({
      ...artifact({}),
      content: new TextEncoder().encode(JSON.stringify(legacy)),
    })
    expect(parsed.verify).not.toHaveProperty('stages')
    expect(JSON.parse(effectiveBuildConfigContent(parsed)).verify.steps).toEqual(['unit'])
  })
})

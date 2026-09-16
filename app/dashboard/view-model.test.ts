import { expect, test } from 'bun:test'
import type { DashboardBuild } from '@defrex/autobuild/operator-presentation'
import { pipelineProvenance } from './view-model'

function build(
  fields: Partial<Pick<DashboardBuild, 'pipelineSource' | 'effectiveConfigRev'>>,
): DashboardBuild {
  return {
    slug: 'demo',
    status: 'running',
    alsoPaused: false,
    steps: [],
    blockers: [],
    autoMerge: 'off',
    ...fields,
  }
}

test('a pinned build yields its short commit, ref, and config revision', () => {
  const text = pipelineProvenance(
    build({
      pipelineSource: { ref: 'branch-head', commit: 'a'.repeat(40) },
      effectiveConfigRev: 3,
    }),
  )
  expect(text).toBe(`autobuild.toml@${'a'.repeat(7)} (branch-head) · config rev 3`)
})

test('a pinned build without a commit degrades to an unknown commit', () => {
  const text = pipelineProvenance(build({ pipelineSource: { ref: 'legacy-fallback' } }))
  expect(text).toBe('autobuild.toml@unknown (legacy-fallback)')
})

test('only an effective config revision renders the pre-pin path', () => {
  const text = pipelineProvenance(build({ effectiveConfigRev: 2 }))
  expect(text).toBe('autobuild.toml@unknown (pre-pin) · config rev 2')
})

test('a build with neither field renders no provenance', () => {
  expect(pipelineProvenance(build({}))).toBeUndefined()
})

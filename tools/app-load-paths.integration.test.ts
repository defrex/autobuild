import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { loadConfig } from '../packages/core/src/config/load'
import { compilePathSelectors } from '../packages/core/src/config/path-selectors'
import {
  evaluateVerifyApplicability,
  type VerifyApplicabilityRule,
} from '../packages/core/src/kernel/verify-applicability'
import {
  bundleClientPages,
  discoverClientPages,
} from '../packages/web-dashboard-capture/src/client-load'

// This repository's `app-load` verify step must run for every diff that can
// change what the web app's client bundles load, and only for those. #951
// changed kernel files alone and broke the dashboard in the browser.

const REPO_ROOT = resolve(import.meta.dir, '..')

test('every file the client bundles read is a path that runs app-load', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs['app-load']
  if (!step || !('paths' in step) || !step.paths) throw Error('app-load has no paths')
  const matches = compilePathSelectors(step.paths)
  const outDir = await mkdtemp(join(tmpdir(), 'ab-client-load-bundle-'))
  try {
    const bundles = await bundleClientPages(discoverClientPages(), outDir)
    const unmatched = new Set<string>()
    let inputs = 0
    for (const bundle of bundles)
      for (const input of bundle.inputs) {
        if (input.includes('/node_modules/')) continue
        inputs++
        const path = relative(REPO_ROOT, input)
        if (!matches(path)) unmatched.add(path)
      }
    expect(inputs).toBeGreaterThan(0)
    expect([...unmatched]).toEqual([])
    // The #951 chain: a kernel module reached through the operator presentation.
    expect(matches('packages/core/src/kernel/ticket-wait.ts')).toBe(true)
    expect(matches('packages/core/src/events/compatibility.ts')).toBe(true)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 120_000)

test('only diffs that can reach the web app pay for a browser', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const rule = (step: string): VerifyApplicabilityRule => {
    const settings = config.verify.stepConfigs[step]
    if (!settings) throw Error(`no ${step} step`)
    if ('always' in settings && settings.always) return { kind: 'always' }
    if (!('paths' in settings) || !settings.paths) return { kind: 'always' }
    return { kind: 'paths', step, paths: settings.paths }
  }
  const applies = (step: string, changed: string[]) =>
    evaluateVerifyApplicability(rule(step), changed).applies
  const docsOnly = [
    'docs/verification.md',
    'packages/website/src/docs-baseline/verification.json',
    'skills/guide/SKILL.md',
    '.agents/skills/ab-plan/SKILL.md',
    '.agents/skills/.ab-pristine/ab-plan/SKILL.md',
    'packages/website/src/index.ts',
    'README.md',
  ]
  // app-load and ui-app are the only steps that load the web app in a browser.
  expect(applies('app-load', docsOnly)).toBe(false)
  expect(applies('ui-app', docsOnly)).toBe(false)
  // #951's diff was kernel-only.
  expect(applies('app-load', ['packages/core/src/kernel/ticket-wait.ts'])).toBe(true)
  const client = ['packages/hosted-store-service/app/dashboard/DashboardClient.tsx']
  expect(applies('app-load', client)).toBe(true)
  expect(applies('ui-app', client)).toBe(true)
})

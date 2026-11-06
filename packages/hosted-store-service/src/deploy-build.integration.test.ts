import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildDeployment,
  deploymentDependencies,
  deploymentTraceRoot,
  stageDeployment,
} from './deploy-build'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'service-stage-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), '{}')
  return root
}
async function dependency(root: string, name: string, exports: Record<string, string>) {
  const dir = join(root, 'node_modules', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, exports }))
  for (const path of Object.values(exports)) await writeFile(join(dir, path), '')
}
test('stages store-only app repeatedly and rejects edits or consumer collisions', async () => {
  const root = await fixture()
  await stageDeployment(root, false)
  expect(await readFile(join(root, 'app/api/dispatch/route.ts'), 'utf8')).toContain(
    'dispatch runs elsewhere',
  )
  expect(await readFile(join(root, 'tsconfig.json'), 'utf8')).not.toContain('../../')
  await stageDeployment(root, false)
  await stageDeployment(root, true)
  expect(await readFile(join(root, 'app/api/dispatch/route.ts'), 'utf8')).toContain(
    'dispatcherEndpoint',
  )
  await writeFile(join(root, 'app/page.tsx'), 'consumer edit')
  await expect(stageDeployment(root, false)).rejects.toThrow('consumer-owned')
  expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('consumer edit')
})
test('missing required dependency and installed broken dispatcher fail clearly', async () => {
  const awaitRoot = await fixture()
  const root = await fixture()
  expect(() => deploymentDependencies(awaitRoot)).toThrow('next')
  await dependency(root, 'next', { './dist/bin/next': './next.js' })
  await dependency(root, '@defrex/autobuild-postgres-store', { '.': './index.ts' })
  expect(deploymentDependencies(root).dispatcher).toBe(false)
  await dependency(root, '@defrex/autobuild-hosted-dispatcher', { '.': './index.ts' })
  expect(() => deploymentDependencies(root)).toThrow('runtime')
  // A fresh root: Bun caches the resolution of the first manifest.
  const older = await fixture()
  await dependency(older, 'next', { './dist/bin/next': './next.js' })
  await dependency(older, '@defrex/autobuild-hosted-dispatcher', { './runtime': './runtime.ts' })
  expect(() => deploymentDependencies(older)).toThrow(
    'installed @defrex/autobuild-hosted-dispatcher lacks the deploy bin',
  )
})
test('with the dispatcher installed the build packs, migrates, builds, then ships', async () => {
  const root = await fixture()
  await dependency(root, 'next', { './dist/bin/next': './next.js' })
  await dependency(root, '@defrex/autobuild-postgres-store', { '.': './index.ts' })
  await dependency(root, '@defrex/autobuild-hosted-dispatcher', {
    './runtime': './runtime.ts',
    './bin': './bin.ts',
  })
  const bin = join(root, 'node_modules/@defrex/autobuild-hosted-dispatcher/bin.ts')
  const calls: { args: string[]; env: Record<string, string> }[] = []
  await buildDeployment(root, async (args, cwd, env) => {
    expect(cwd).toBe(root)
    calls.push({ args, env })
    if (args[1] === 'build')
      for (const path of ['tsconfig.json', 'next-env.d.ts']) await writeFile(join(root, path), '')
  })
  expect(calls.map(({ args }) => args)).toEqual([
    [bin, 'pack-distribution', '--root', root],
    [expect.stringContaining('bin.ts'), 'migrate'],
    [expect.stringContaining('next'), 'build'],
    [bin, 'ship-deployment', '--root', root],
  ])
  for (const { env } of calls) expect(env.AB_SERVICE_BUILD_ROOT).toBe(root)
})
test('the tracing root is the matching workspace root, else the folder itself', async () => {
  const root = await fixture()
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }))
  await mkdir(join(root, 'apps/autobuild'), { recursive: true })
  await mkdir(join(root, 'tools/autobuild'), { recursive: true })
  expect(deploymentTraceRoot(join(root, 'apps/autobuild'))).toBe(root)
  expect(deploymentTraceRoot(join(root, 'tools/autobuild'))).toBe(resolve(root, 'tools/autobuild'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ workspaces: { packages: ['tools/*'] } }),
  )
  expect(deploymentTraceRoot(join(root, 'tools/autobuild'))).toBe(root)
  const standalone = await fixture()
  expect(deploymentTraceRoot(standalone)).toBe(standalone)
})
test('migration precedes build and either failure is propagated', async () => {
  const root = await fixture()
  await dependency(root, 'next', { './dist/bin/next': './next.js' })
  await dependency(root, '@defrex/autobuild-postgres-store', { '.': './index.ts' })
  const calls: string[][] = []
  await expect(
    buildDeployment(root, async (args) => {
      calls.push(args)
      throw new Error('migration failed')
    }),
  ).rejects.toThrow('migration failed')
  // Store-only: no pack step precedes migration.
  expect(calls).toHaveLength(1)
  expect(calls[0]?.[1]).toBe('migrate')
  calls.length = 0
  await expect(
    buildDeployment(root, async (args, cwd) => {
      expect(cwd).toBe(root)
      calls.push(args)
      if (args[1] === 'build') throw new Error('build failed')
    }),
  ).rejects.toThrow('build failed')
  expect(calls).toHaveLength(2)
})

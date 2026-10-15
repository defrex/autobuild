import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDeployment, deploymentDependencies, stageDeployment } from './deploy-build'

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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVICE_PACKAGES, selectDeploymentPlugins } from './deployment-plugins'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function deployment(manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-deployment-plugins-'))
  temporary.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  return root
}

async function install(root: string, name: string, peers: Record<string, string> = {}) {
  const directory = join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', peerDependencies: peers }),
  )
}

const dependencies = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, '1.0.0']))

describe('selectDeploymentPlugins', () => {
  test('flags beat the manifest, and the manifest beats dependencies', async () => {
    const root = await deployment({
      dependencies: dependencies('@acme/plugin'),
      autobuild: { plugins: ['@acme/listed'] },
    })
    await install(root, '@acme/plugin', { '@defrex/autobuild': '*' })
    expect(await selectDeploymentPlugins(root, ['@acme/flagged'])).toEqual({
      packages: ['@acme/flagged'],
      rule: 'flag',
    })
    expect(await selectDeploymentPlugins(root)).toEqual({
      packages: ['@acme/listed'],
      rule: 'manifest',
    })
  })

  test('an explicit empty list ships none', async () => {
    const root = await deployment({
      dependencies: dependencies('@acme/plugin'),
      autobuild: { plugins: [] },
    })
    await install(root, '@acme/plugin', { '@defrex/autobuild': '*' })
    expect(await selectDeploymentPlugins(root)).toEqual({ packages: [], rule: 'manifest' })
  })

  test('a malformed field names package.json and the field', async () => {
    for (const autobuild of [{ plugins: 'x' }, { plugins: [''] }, { plugins: ['a', 'a'] }, 7]) {
      const root = await deployment({ autobuild })
      await expect(selectDeploymentPlugins(root)).rejects.toThrow(/package\.json: "autobuild/)
    }
    const root = await deployment({})
    await expect(selectDeploymentPlugins(root, ['a', 'a'])).rejects.toThrow('--plugin')
  })

  test('the default rule picks dependencies that peer on @defrex/autobuild, minus service packages', async () => {
    const root = await deployment({
      dependencies: dependencies(
        ...SERVICE_PACKAGES,
        '@defrex/autobuild',
        '@defrex/autobuild-vercel-sandbox',
        'next',
        'not-installed',
      ),
    })
    for (const name of SERVICE_PACKAGES) await install(root, name, { '@defrex/autobuild': '*' })
    await install(root, '@defrex/autobuild')
    await install(root, '@defrex/autobuild-vercel-sandbox', { '@defrex/autobuild': '*' })
    await install(root, 'next', { react: '*' })
    expect(await selectDeploymentPlugins(root)).toEqual({
      packages: ['@defrex/autobuild-vercel-sandbox'],
      rule: 'dependencies',
    })
  })

  test('a workspace member reads dependencies installed at the workspace root', async () => {
    const root = await deployment({ workspaces: ['apps/*'] })
    const member = join(root, 'apps', 'autobuild')
    await mkdir(member, { recursive: true })
    await writeFile(
      join(member, 'package.json'),
      JSON.stringify({ dependencies: dependencies('@acme/plugin') }),
    )
    await install(root, '@acme/plugin', { '@defrex/autobuild': '*' })
    expect((await selectDeploymentPlugins(member)).packages).toEqual(['@acme/plugin'])
  })
})

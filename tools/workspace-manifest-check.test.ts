import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateWorkspaceManifests } from './workspace-manifest-check'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const dependencies = { alpha: '^1.0.0', beta: '2.0.0' }

async function fixture(core: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-workspaces-'))
  temporary.push(root)
  await mkdir(join(root, 'packages', 'core'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'autobuild',
      version: '1.2.3',
      workspaces: ['packages/*'],
      engines: { bun: '>=1.4.0' },
      dependencies,
    }),
  )
  await writeFile(
    join(root, 'packages', 'core', 'package.json'),
    JSON.stringify({
      name: '@autobuild/core',
      version: '1.2.3',
      engines: { bun: '>=1.4.0' },
      dependencies,
      ...core,
    }),
  )
  return root
}

describe('workspace manifest invariants', () => {
  test('accepts matching versions, Bun minimums, and runtime dependencies', async () => {
    expect((await validateWorkspaceManifests(await fixture())).map((entry) => entry.path)).toEqual([
      'package.json',
      'packages/core/package.json',
    ])
  })

  test('rejects version and Bun runtime drift', async () => {
    await expect(validateWorkspaceManifests(await fixture({ version: '1.2.4' }))).rejects.toThrow(
      'version must match root',
    )
    await expect(
      validateWorkspaceManifests(await fixture({ engines: { bun: '>=1.3.0' } })),
    ).rejects.toThrow('engines.bun must match root')
    await expect(validateWorkspaceManifests(await fixture({ engines: {} }))).rejects.toThrow(
      'engines.bun is required',
    )
  })

  test('rejects missing, extra, and changed dependencies', async () => {
    await expect(
      validateWorkspaceManifests(await fixture({ dependencies: { alpha: '^1.0.0' } })),
    ).rejects.toThrow('dependency beta')
    await expect(
      validateWorkspaceManifests(
        await fixture({ dependencies: { ...dependencies, gamma: '^3.0.0' } }),
      ),
    ).rejects.toThrow('dependency gamma')
    await expect(
      validateWorkspaceManifests(
        await fixture({ dependencies: { ...dependencies, alpha: '^9.0.0' } }),
      ),
    ).rejects.toThrow('dependency alpha')
  })

  test('fails closed for missing and malformed workspace manifests', async () => {
    const missing = await fixture()
    await rm(join(missing, 'packages', 'core', 'package.json'))
    await expect(validateWorkspaceManifests(missing)).rejects.toThrow(
      'missing or unreadable workspace manifest',
    )

    const malformed = await fixture()
    await writeFile(join(malformed, 'packages', 'core', 'package.json'), '{nope')
    await expect(validateWorkspaceManifests(malformed)).rejects.toThrow('invalid package manifest')
  })
})

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

// The four pins mirrored between the root manifest and the hosted-store-service
// manifest; every fixture carries them identically so existing tests keep
// passing under the mirror rule.
const reactPins = {
  react: '19.2.4',
  'react-dom': '19.2.4',
  '@types/react': '19.2.14',
  '@types/react-dom': '19.2.3',
}
const hostedDependencies = {
  react: reactPins.react,
  'react-dom': reactPins['react-dom'],
  pg: '8.18.0',
}
const hostedDevDependencies = {
  '@types/react': reactPins['@types/react'],
  '@types/react-dom': reactPins['@types/react-dom'],
}

async function fixture(
  core: Record<string, unknown> = {},
  hosted: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'ab-workspaces-'))
  temporary.push(rootPath)
  await mkdir(join(rootPath, 'packages', 'core'), { recursive: true })
  await mkdir(join(rootPath, 'packages', 'hosted-store-service'), { recursive: true })
  await writeFile(
    join(rootPath, 'package.json'),
    JSON.stringify({
      name: 'autobuild',
      version: '1.2.3',
      workspaces: ['packages/*'],
      engines: { bun: '>=1.4.0' },
      dependencies,
      devDependencies: reactPins,
      ...root,
    }),
  )
  await writeFile(
    join(rootPath, 'packages', 'core', 'package.json'),
    JSON.stringify({
      name: '@defrex/autobuild-core',
      version: '1.2.3',
      engines: { bun: '>=1.4.0' },
      dependencies,
      ...core,
    }),
  )
  await writeFile(
    join(rootPath, 'packages', 'hosted-store-service', 'package.json'),
    JSON.stringify({
      name: '@defrex/autobuild-hosted-store-service',
      version: '1.2.3',
      engines: { bun: '>=1.4.0' },
      dependencies: hostedDependencies,
      devDependencies: hostedDevDependencies,
      ...hosted,
    }),
  )
  return rootPath
}

describe('workspace manifest invariants', () => {
  test('accepts matching versions, Bun minimums, runtime dependencies, and react pins', async () => {
    expect((await validateWorkspaceManifests(await fixture())).map((entry) => entry.path)).toEqual([
      'package.json',
      'packages/core/package.json',
      'packages/hosted-store-service/package.json',
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

  test('rejects react pin drift between root and hosted-store-service', async () => {
    await expect(
      validateWorkspaceManifests(
        await fixture({}, {}, { devDependencies: { ...reactPins, react: '19.2.5' } }),
      ),
    ).rejects.toThrow(
      'package.json and packages/hosted-store-service/package.json: react pin drift (root 19.2.5; hosted-store-service 19.2.4)',
    )
    await expect(
      validateWorkspaceManifests(
        await fixture({}, {}, { devDependencies: { ...reactPins, '@types/react': '19.2.15' } }),
      ),
    ).rejects.toThrow('@types/react pin drift')
    await expect(
      validateWorkspaceManifests(
        await fixture({}, { dependencies: { ...hostedDependencies, react: '19.2.5' } }),
      ),
    ).rejects.toThrow('react pin drift (root 19.2.4; hosted-store-service 19.2.5)')
    await expect(
      validateWorkspaceManifests(
        await fixture(
          {},
          {
            devDependencies: {
              '@types/react': reactPins['@types/react'],
              '@types/react-dom': '19.2.4',
            },
          },
        ),
      ),
    ).rejects.toThrow('@types/react-dom pin drift (root 19.2.3; hosted-store-service 19.2.4)')
    await expect(
      validateWorkspaceManifests(
        await fixture({}, { dependencies: { 'react-dom': reactPins['react-dom'], pg: '8.18.0' } }),
      ),
    ).rejects.toThrow('react pin drift (root 19.2.4; hosted-store-service not pinned)')
  })

  test('does not constrain non-mirrored dependencies between root and hosted-store-service', async () => {
    await expect(
      validateWorkspaceManifests(
        await fixture({}, { dependencies: { ...hostedDependencies, pg: '9.0.0' } }),
      ),
    ).resolves.toBeDefined()
    await expect(
      validateWorkspaceManifests(
        await fixture({}, {}, { devDependencies: { ...reactPins, '@types/bun': '^1.3.14' } }),
      ),
    ).resolves.toBeDefined()
  })

  test('fails closed when the hosted-store-service manifest is missing', async () => {
    await expect(
      validateWorkspaceManifests(await fixture({}, { name: '@defrex/autobuild-something-else' })),
    ).rejects.toThrow('workspace @defrex/autobuild-hosted-store-service is required')
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

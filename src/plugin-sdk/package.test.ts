import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  FakeForge,
  FakeTicketSource,
  FakeWorkspaceProvider,
  MemoryBlobStore,
  MemoryBuildStore,
  PLUGIN_API_VERSION,
  ScriptedAgentRunner,
  describeBlobStoreContract,
  describeBuildStoreContract,
  describeForgeContract,
  describeTicketSourceContract,
  describeWorkspaceProviderContract,
  type AutobuildPluginManifest,
  type TicketSourcePluginDescriptor,
} from 'autobuild/plugin-sdk'

const root = resolve(import.meta.dir, '..', '..')
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('autobuild/plugin-sdk package surface', () => {
  test('exports manifest types, contracts, and reference adapters from the public subpath', () => {
    const ticketSource = {
      factory: () => new FakeTicketSource(),
      requiredEnv: ['SAMPLE_TOKEN'],
    } satisfies TicketSourcePluginDescriptor
    const sample = {
      name: 'sample-package',
      apiVersion: '^1.1.0',
      ticketSources: { sample: ticketSource },
    } satisfies AutobuildPluginManifest

    expect(sample.name).toBe('sample-package')
    expect(PLUGIN_API_VERSION).toBe('1.1.0')
    for (const symbol of [
      describeTicketSourceContract,
      describeWorkspaceProviderContract,
      describeForgeContract,
      describeBuildStoreContract,
      describeBlobStoreContract,
      FakeTicketSource,
      FakeWorkspaceProvider,
      FakeForge,
      ScriptedAgentRunner,
      MemoryBuildStore,
      MemoryBlobStore,
    ]) {
      expect(symbol).toBeDefined()
    }
  })

  test('a dev-only type dependency checks and builds a plugin with no Autobuild runtime import', async () => {
    const source = `
      import type {
        AutobuildPluginManifest,
        PluginFactoryContext,
      } from 'autobuild/plugin-sdk'
      interface SampleConfig { endpoint: string }
      const manifest = {
        name: 'erased-types',
        apiVersion: '^1.0.0',
        ticketSources: {
          sample: {
            requiredEnv: ['SAMPLE_TOKEN'],
            factory: async ({ config }: PluginFactoryContext<SampleConfig>) => {
              throw new Error(\`fixture factory for \${config.endpoint} is lazy\`)
            },
          },
        },
      } satisfies AutobuildPluginManifest
      export default manifest
    `
    const destination = await mkdtemp(join(tmpdir(), 'ab-erased-plugin-'))
    temporary.push(destination)
    await writeFile(
      join(destination, 'package.json'),
      JSON.stringify({
        name: 'sample-autobuild-plugin',
        type: 'module',
        devDependencies: { autobuild: '2.0.0', '@types/bun': '^1.3.14' },
      }),
    )
    await writeFile(join(destination, 'plugin.ts'), source)
    const dependencyDir = join(destination, 'node_modules')
    await mkdir(join(dependencyDir, '@types'), { recursive: true })
    await symlink(root, join(dependencyDir, 'autobuild'), 'dir')
    await symlink(
      join(root, 'node_modules', '@types', 'bun'),
      join(dependencyDir, '@types', 'bun'),
      'dir',
    )

    const typecheck = Bun.spawn(
      [
        join(root, 'node_modules', '.bin', 'tsc'),
        '--noEmit',
        '--target',
        'ESNext',
        '--module',
        'ESNext',
        '--moduleResolution',
        'bundler',
        '--types',
        'bun',
        '--skipLibCheck',
        'plugin.ts',
      ],
      { cwd: destination, stdout: 'pipe', stderr: 'pipe' },
    )
    const typecheckExit = await typecheck.exited
    const [typecheckOutput, typecheckError] = await Promise.all([
      new Response(typecheck.stdout).text(),
      new Response(typecheck.stderr).text(),
    ])
    if (typecheckExit !== 0) {
      throw new Error(`sample plugin typecheck failed:\n${typecheckOutput}${typecheckError}`)
    }

    const output = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(source)
    expect(output).not.toContain('autobuild/plugin-sdk')
    const built = join(destination, 'plugin.mjs')
    await writeFile(built, output)
    await rm(dependencyDir, { recursive: true, force: true })
    const loaded = await import(pathToFileURL(built).href)
    expect(loaded.default.name).toBe('erased-types')
  })

  test('the packed artifact contains the SDK and all reusable contract suites', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'ab-plugin-sdk-pack-'))
    temporary.push(destination)
    const packed = Bun.spawn(
      [
        'bun',
        'pm',
        'pack',
        '--destination',
        destination,
        '--ignore-scripts',
        '--quiet',
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    )
    const exit = await packed.exited
    const stderr = await new Response(packed.stderr).text()
    expect(exit, stderr).toBe(0)

    const tarballs = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const archive = join(destination, tarballs[0]!)
    const listingProcess = Bun.spawn(['tar', '-tzf', archive], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const listing = await new Response(listingProcess.stdout).text()
    expect(await listingProcess.exited).toBe(0)
    for (const path of [
      'package/src/plugin-sdk/index.ts',
      'package/src/ports/tickets/contract.ts',
      'package/src/ports/workspace/contract.ts',
      'package/src/ports/forge/contract.ts',
      'package/src/store/contract.ts',
    ]) {
      expect(listing).toContain(path)
    }

    const manifestProcess = Bun.spawn(
      ['tar', '-xOf', archive, 'package/package.json'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const packedManifest = JSON.parse(
      await new Response(manifestProcess.stdout).text(),
    ) as { exports?: Record<string, { types?: string; import?: string }> }
    expect(await manifestProcess.exited).toBe(0)
    expect(packedManifest.exports?.['./plugin-sdk']).toMatchObject({
      types: './src/plugin-sdk/index.ts',
      import: './src/plugin-sdk/index.ts',
    })
  })
})

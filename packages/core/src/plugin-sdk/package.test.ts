import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageAutobuildDistribution } from '../ports/workspace/vercel-sandbox'
import { installPackedDistribution } from '../testing/packed-install'
import {
  FakeForge,
  FakeTicketSource,
  FakeWorkspaceProvider,
  MemoryBlobStore,
  MemoryBuildStore,
  PLUGIN_API_VERSION,
  ScriptedAgentRunner,
  describeAgentRunnerContract,
  describeBlobStoreContract,
  describeBuildStoreContract,
  describeForgeContract,
  describeTicketSourceContract,
  describeWorkspaceProviderContract,
  type AutobuildPluginManifest,
  type TicketSourcePluginDescriptor,
} from './index'

const root = resolve(import.meta.dir, '..', '..', '..', '..')
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('plugin SDK package surface', () => {
  test('exports manifest types, contracts, and reference adapters from the local SDK barrel', () => {
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
    expect(PLUGIN_API_VERSION).toBe('1.5.0')
    for (const symbol of [
      describeAgentRunnerContract,
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
      } from '@defrex/autobuild/plugin-sdk'
      interface SampleConfig { endpoint: string }
      const manifest = {
        name: 'erased-types',
        apiVersion: '^1.1.0',
        ticketSources: {
          sample: {
            requiredEnv: ['SAMPLE_TOKEN'],
            factory: async ({ config }: PluginFactoryContext<SampleConfig>) => {
              throw new Error(\`fixture factory for \${config.endpoint} is lazy\`)
            },
            contract: {
              factory: (_context: PluginFactoryContext) => async () => {
                throw new Error('contract fixture is lazy')
              },
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
        devDependencies: { '@defrex/autobuild': '2.0.0', '@types/bun': '^1.3.14' },
      }),
    )
    await writeFile(join(destination, 'plugin.ts'), source)
    const dependencyDir = join(destination, 'node_modules')
    await mkdir(join(dependencyDir, '@types'), { recursive: true })
    await mkdir(join(dependencyDir, '@defrex'), { recursive: true })
    await symlink(root, join(dependencyDir, '@defrex', 'autobuild'), 'dir')
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
    expect(output).not.toContain('@defrex/autobuild/plugin-sdk')
    const built = join(destination, 'plugin.mjs')
    await writeFile(built, output)
    await rm(dependencyDir, { recursive: true, force: true })
    const loaded = await import(pathToFileURL(built).href)
    expect(loaded.default.name).toBe('erased-types')
  })

  test('the packed artifact contains the SDK and all reusable contract suites', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'ab-plugin-sdk-pack-'))
    temporary.push(destination)
    const archive = join(destination, 'autobuild.tgz')
    await writeFile(archive, await packageAutobuildDistribution())
    const listingProcess = Bun.spawn(['tar', '-tzf', archive], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const listing = await new Response(listingProcess.stdout).text()
    expect(await listingProcess.exited).toBe(0)
    for (const path of [
      'package/packages/core/src/plugin-sdk/index.ts',
      'package/packages/core/src/ports/tickets/contract.ts',
      'package/packages/core/src/ports/runner/contract.ts',
      'package/packages/core/src/ports/workspace/contract.ts',
      'package/packages/core/src/ports/forge/contract.ts',
      'package/packages/core/src/store/contract.ts',
      'package/bin/ab.ts',
      'package/bin/agent/ab',
      'package/skills/implement/SKILL.md',
      'package/templates/autobuild.toml',
    ]) {
      expect(listing).toContain(path)
    }

    const manifestProcess = Bun.spawn(['tar', '-xOf', archive, 'package/package.json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const packedManifest = JSON.parse(await new Response(manifestProcess.stdout).text()) as {
      exports?: Record<string, { types?: string; import?: string }>
      dependencies?: Record<string, string>
      patchedDependencies?: Record<string, string>
    }
    expect(await manifestProcess.exited).toBe(0)
    expect(packedManifest.exports?.['./plugin-sdk']).toMatchObject({
      types: './packages/core/src/plugin-sdk/index.ts',
      import: './packages/core/src/plugin-sdk/index.ts',
    })
    expect(packedManifest.dependencies?.['@defrex/autobuild-core']).toBeUndefined()
    expect(packedManifest.patchedDependencies).toBeUndefined()

    const consumer = join(destination, 'consumer')
    await mkdir(consumer)
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'packed-plugin-sdk-consumer',
        private: true,
        type: 'module',
        dependencies: { '@defrex/autobuild': `file:${archive}` },
      }),
    )
    const install = await installPackedDistribution(['--linker', 'isolated'], consumer)
    if (install.exitCode !== 0) {
      throw new Error(`packed consumer install failed:\n${install.stdout}${install.stderr}`)
    }

    await writeFile(
      join(consumer, 'verify.ts'),
      `
        import {
          FakeTicketSource,
          PLUGIN_API_VERSION,
          describeTicketSourceContract,
        } from '@defrex/autobuild/plugin-sdk'

        if (PLUGIN_API_VERSION !== '1.5.0') {
          throw new Error(\`unexpected plugin API version: \${PLUGIN_API_VERSION}\`)
        }
        if (typeof FakeTicketSource !== 'function') {
          throw new Error('FakeTicketSource is unavailable')
        }
        if (typeof describeTicketSourceContract !== 'function') {
          throw new Error('describeTicketSourceContract is unavailable')
        }
      `,
    )
    const consumerImport = Bun.spawn(['bun', 'verify.ts'], {
      cwd: consumer,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const consumerImportExit = await consumerImport.exited
    const [consumerImportOutput, consumerImportError] = await Promise.all([
      new Response(consumerImport.stdout).text(),
      new Response(consumerImport.stderr).text(),
    ])
    if (consumerImportExit !== 0) {
      throw new Error(
        `packed consumer autobuild/plugin-sdk import failed:\n${consumerImportOutput}${consumerImportError}`,
      )
    }

    const extracted = join(destination, 'extracted')
    await mkdir(extracted)
    const extract = Bun.spawn(['tar', '-xzf', archive, '-C', extracted])
    expect(await extract.exited).toBe(0)
    const packageRoot = join(extracted, 'package')
    const version = Bun.spawn(['bun', join(packageRoot, 'bin', 'ab.ts'), '--version'], {
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await version.exited, await new Response(version.stderr).text()).toBe(0)
    // The packed CLI reports the packed manifest's version — derive the
    // expectation from the source manifest so a release bump cannot stale the
    // pin (as the v0.7.0 release did to its hardcoded predecessor), and take
    // the plugin API version from the SDK constant for the same reason.
    const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    expect((await new Response(version.stdout).text()).trim()).toBe(
      `autobuild ${rootManifest.version}\nplugin API ${PLUGIN_API_VERSION}`,
    )

    const initialized = join(destination, 'initialized')
    await mkdir(initialized)
    const init = Bun.spawn(['bun', join(packageRoot, 'bin', 'ab.ts'), 'init'], {
      cwd: initialized,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await init.exited, await new Response(init.stderr).text()).toBe(0)
    expect(await Bun.file(join(initialized, 'autobuild.toml')).exists()).toBe(true)
    expect(
      await Bun.file(join(initialized, '.agents', 'skills', 'ab-implement', 'SKILL.md')).exists(),
    ).toBe(true)
  }, 600_000)

  test('the packed distribution installs next to better-auth without a patchedDependencies declaration', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'ab-pack-patch-consumer-'))
    temporary.push(destination)
    const archive = join(destination, 'autobuild.tgz')
    await writeFile(archive, await packageAutobuildDistribution())

    const consumer = join(destination, 'consumer')
    await mkdir(consumer)
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'packed-better-auth-consumer',
        private: true,
        type: 'module',
        dependencies: { '@defrex/autobuild': `file:${archive}`, 'better-auth': '1.4.18' },
      }),
    )
    // bun 1.4.0 panics (exit 134, Option::unwrap) when the consumed manifest
    // declares a patchedDependencies entry for a package the consumer tree
    // contains, so this install only succeeds while the packed manifest
    // carries no patchedDependencies field.
    const install = await installPackedDistribution([], consumer)
    if (install.exitCode !== 0) {
      throw new Error(
        `packed distribution install next to better-auth failed:\n${install.stdout}${install.stderr}`,
      )
    }
    expect(
      await Bun.file(join(consumer, 'node_modules', 'better-auth', 'package.json')).exists(),
    ).toBe(true)
    expect(
      await Bun.file(
        join(consumer, 'node_modules', '@defrex', 'autobuild', 'bin', 'ab.ts'),
      ).exists(),
    ).toBe(true)
  }, 600_000)
})

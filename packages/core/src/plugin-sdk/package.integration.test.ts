import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageAutobuildDistribution } from '../ports/workspace/distribution-archive'
import { installPackedDistribution } from '../testing/packed-install'
import { PLUGIN_API_VERSION } from './index'

const root = resolve(import.meta.dir, '..', '..', '..', '..')
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** One packed distribution for every test that consumes the tarball. */
let packed: Promise<Uint8Array> | undefined
const packedDistribution = () => (packed ??= packageAutobuildDistribution())

/** A plugin whose only Autobuild dependency is erased types. */
const ERASED_TYPES_PLUGIN = `
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

const TYPECHECK_DEADLINE_EXCEEDED = Symbol('typecheck-deadline-exceeded')

/** Bound the real consumer compile and identify deadline failures separately. */
async function typecheckExitWithinDeadline(
  typecheck: Bun.ReadableSubprocess,
  deadlineMs: number,
): Promise<{ exitCode: number; elapsedMs: number; output: string; error: string }> {
  const start = performance.now()
  // The deadline resolves with a sentinel rather than rejecting, so the
  // diagnostic is thrown on the main path below and the losing branch can
  // never produce an unhandled rejection.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TYPECHECK_DEADLINE_EXCEEDED>((resolve) => {
    deadlineTimer = setTimeout(() => {
      typecheck.kill()
      resolve(TYPECHECK_DEADLINE_EXCEEDED)
    }, deadlineMs)
  })
  let raceResult: number | typeof TYPECHECK_DEADLINE_EXCEEDED
  try {
    raceResult = await Promise.race([typecheck.exited, deadline])
  } finally {
    clearTimeout(deadlineTimer)
  }
  await typecheck.exited
  const elapsedMs = Math.round(performance.now() - start)
  const [output, error] = await Promise.all([
    new Response(typecheck.stdout).text(),
    new Response(typecheck.stderr).text(),
  ])
  if (raceResult === TYPECHECK_DEADLINE_EXCEEDED) {
    throw new Error(
      `plugin-sdk package-surface fixture: tsc --noEmit exceeded ${deadlineMs}ms (${elapsedMs}ms elapsed) — this is the test's heavy step (machine-speed-bound), not a type error; see the deadline comment at its call site`,
    )
  }
  return { exitCode: raceResult, elapsedMs, output, error }
}

describe('plugin SDK package surface', () => {
  test('the packed artifact contains the SDK and all reusable contract suites', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'ab-plugin-sdk-pack-'))
    temporary.push(destination)
    const archive = join(destination, 'autobuild.tgz')
    await writeFile(archive, await packedDistribution())
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
    await installPackedDistribution(['--linker', 'isolated'], consumer)

    await writeFile(
      join(consumer, 'verify.ts'),
      `
        import {
          FakeTicketSource,
          type AutobuildPluginManifest, type TicketSourcePluginDescriptor,
          ForgeFailure, isForgeFailure,
          type ForgeFailureDetails, type ForgeRequestObserver, type ForgeRequestContext,
          type TicketCriteria, type TicketPage, type TicketPageListing, type TicketSource,
          type TicketSearchHit, type TicketSearchPage, type TicketSearchQuery,
          PLUGIN_API_VERSION,
          describeTicketSourceContract,
        } from '@defrex/autobuild/plugin-sdk'

        import * as sdk from '@defrex/autobuild/plugin-sdk'

        const ticketSource = {
          factory: () => new FakeTicketSource(), requiredEnv: ['SAMPLE_TOKEN'],
        } satisfies TicketSourcePluginDescriptor
        const sample = {
          name: 'sample-package', apiVersion: '^1.1.0', ticketSources: { sample: ticketSource },
        } satisfies AutobuildPluginManifest
        if (sample.name !== 'sample-package') throw new Error('manifest types')
        for (const name of [
          'describeAgentRunnerContract', 'describeTicketSourceContract', 'describeWorkspaceProviderContract',
          'describeForgeContract', 'describeBuildStoreContract', 'describeBlobStoreContract',
          'FakeTicketSource', 'FakeWorkspaceProvider', 'FakeForge', 'ScriptedAgentRunner',
          'MemoryBuildStore', 'MemoryBlobStore',
        ]) if (typeof (sdk as Record<string, unknown>)[name] !== 'function') {
          throw new Error('missing SDK export: ' + name)
        }
        const criteria: TicketCriteria = { state: 'Ready', labels: ['web'] }
        const page: TicketPage = { limit: 0, offset: 2, order: 'newest' }
        const listing: TicketPageListing = { tickets: [], diagnostics: [], total: 5 }
        const native: NonNullable<TicketSource['listPage']> = async (_criteria, _page) => listing
        if ((await native(criteria, page)).total !== 5) throw new Error('page types')
        const hit: TicketSearchHit = { id: 'T-1', title: 'Rate limit', state: 'Ready', labels: [], kind: 'work' }
        const search: NonNullable<TicketSource['search']> = async (query: TicketSearchQuery) =>
          ({ tickets: [hit], cursor: String(query.limit), diagnostics: [] }) satisfies TicketSearchPage
        const searched = await search({ text: 'rate', limit: 1 })
        if (searched.tickets[0]?.id !== 'T-1' || searched.cursor !== '1') throw new Error('search types')
        const searchless: TicketSource = Object.assign(new FakeTicketSource(), { search: undefined })
        if (searchless.search !== undefined) throw new Error('optional search types')
        const assigned: TicketCriteria = { state: 'Ready', assignee: 'me' }
        const capable: Pick<
          TicketSource,
          'readyAssignee' | 'prepareReadyAssignee' | 'readyAssigneeRefusal' | 'describeReadyAssignee'
        > = {
          readyAssignee: true,
          prepareReadyAssignee: async () => {},
          readyAssigneeRefusal: (value) => (value === assigned.assignee ? undefined : 'only me'),
          describeReadyAssignee: async (value) => \`\${value} → @fixture\`,
        }
        await capable.prepareReadyAssignee?.()
        if (capable.readyAssigneeRefusal?.('me') !== undefined) throw new Error('assignee types')
        if ((await capable.describeReadyAssignee?.('me')) !== 'me → @fixture') throw new Error('assignee types')
        const details: ForgeFailureDetails = { kind: 'rate-limited', resetAt: '2026-10-20T00:00:00.000Z' }
        const context: ForgeRequestContext = { build: 'fixture' }
        const observer: ForgeRequestObserver = (request) => { if (request.build !== context.build) throw new Error('context') }
        observer(context)
        if (!isForgeFailure(new ForgeFailure('limit', details))) throw new Error('missing runtime failure export')
        if (PLUGIN_API_VERSION !== '1.11.0') {
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
    await mkdir(join(consumer, 'node_modules', '@types'), { recursive: true })
    await symlink(
      join(root, 'node_modules', '@types', 'bun'),
      join(consumer, 'node_modules', '@types', 'bun'),
      'dir',
    )
    // A plugin with only a dev-time type dependency checks against the same
    // packed SDK in the same compile.
    await writeFile(join(consumer, 'plugin.ts'), ERASED_TYPES_PLUGIN)
    const emitted = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(
      ERASED_TYPES_PLUGIN,
    )
    expect(emitted).not.toContain('@defrex/autobuild/plugin-sdk')
    const built = join(consumer, 'plugin.mjs')
    await writeFile(built, emitted)
    expect((await import(pathToFileURL(built).href)).default.name).toBe('erased-types')
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
        '--skipLibCheck',
        '--types',
        'bun',
        'verify.ts',
        'plugin.ts',
      ],
      {
        cwd: consumer,
        env: { ...process.env, NODE_COMPILE_CACHE: join(consumer, '.node-compile-cache') },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    // The compile is machine-speed-bound (~4-5 s warm on a 4-vCPU sandbox):
    // an internal deadline names it before the test's own timeout can.
    const consumerTypes = await typecheckExitWithinDeadline(typecheck, 90_000)
    expect(consumerTypes.exitCode, consumerTypes.output + consumerTypes.error).toBe(0)
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

    const packageRoot = join(consumer, 'node_modules', '@defrex', 'autobuild')
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
      env: { ...process.env, TMPDIR: initialized, TMP: initialized, TEMP: initialized },
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
    await writeFile(archive, await packedDistribution())

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
    await installPackedDistribution([], consumer)
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

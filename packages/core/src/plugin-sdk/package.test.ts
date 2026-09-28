import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageAutobuildDistribution } from '../ports/workspace/distribution-archive'
import { spawnExec } from '../ports/workspace/git-worktree'
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

const TYPECHECK_DEADLINE_EXCEEDED = Symbol('typecheck-deadline-exceeded')

/** Races a spawned tsc against an injected wall-clock deadline; kills the
 * process when the deadline wins and throws the deadline-specific diagnostic
 * so that failure mode stays distinguishable from the typecheck-exit guard's
 * generic type-error failure. The deadline is a parameter so a test can
 * inject an artificially small value and deterministically drive the
 * deadline branch regardless of compile speed. */
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
  const elapsedMs = Math.round(performance.now() - start)
  const [output, error] = await Promise.all([
    new Response(typecheck.stdout).text(),
    new Response(typecheck.stderr).text(),
  ])
  if (raceResult === TYPECHECK_DEADLINE_EXCEEDED) {
    throw new Error(
      `plugin-sdk package-surface fixture: tsc --noEmit exceeded ${deadlineMs}ms (${elapsedMs}ms elapsed) — this is the test's heavy step (machine-speed-bound), not a type error; see the per-test timeout comment above`,
    )
  }
  return { exitCode: raceResult, elapsedMs, output, error }
}

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
    expect(PLUGIN_API_VERSION).toBe('1.7.0')
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
    // This test runs a full `tsc --noEmit` plus a transpile and a dynamic
    // import inside bun's per-test timeout, and the compile alone is
    // machine-speed-bound right at bun's 5000ms default cap: on the 4-vcpu
    // vercel-sandbox guest it failed 3/3 isolated and 2/2 full-suite runs
    // with "this test timed out after 5000ms" and empty typecheck output
    // (build pin-the-dashboard, event seq 118), while it passed on the faster
    // verify hardware. Measured warm on that same guest the fixture's tsc
    // takes ~3.6-4.9s (well under the cap on faster machines), so this one
    // test gets a 120s per-test budget — roughly 25x the observed compile —
    // and an internal 90s deadline around the tsc step fails with a
    // diagnostic naming the heavy step before bun's own timeout can ever be
    // the first signal. A genuine type error still fails via the
    // typecheck-exit guard below; only the time budget and the failure
    // labeling changed.
    const {
      exitCode: typecheckExit,
      elapsedMs: typecheckMs,
      output: typecheckOutput,
      error: typecheckError,
    } = await typecheckExitWithinDeadline(typecheck, 90_000)
    if (typecheckExit !== 0) {
      throw new Error(
        `sample plugin typecheck failed after ${typecheckMs}ms:\n${typecheckOutput}${typecheckError}`,
      )
    }

    const output = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(source)
    expect(output).not.toContain('@defrex/autobuild/plugin-sdk')
    const built = join(destination, 'plugin.mjs')
    await writeFile(built, output)
    await rm(dependencyDir, { recursive: true, force: true })
    const loaded = await import(pathToFileURL(built).href)
    expect(loaded.default.name).toBe('erased-types')
  }, 120_000)

  test('an injected short deadline deterministically drives the tsc-deadline branch, independent of compile speed', async () => {
    // The deadline branch's race/kill/diagnostic mechanics were verified by
    // hand during #472 but never deterministically exercised by the suite:
    // with the production 90s constant the branch only fires on a genuinely
    // slow compile. This pin spawns a real tsc that would exit quickly and
    // successfully on any machine (`--version`; node startup alone is tens
    // of ms) and injects a 1ms deadline, so the sentinel provably wins by
    // injection rather than by wall-clock luck — and if that ever stopped
    // holding, the resolve below fails the test loudly instead of silently
    // passing.
    const typecheck = Bun.spawn([join(root, 'node_modules', '.bin', 'tsc'), '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const outcome = await typecheckExitWithinDeadline(typecheck, 1).then(
      () => null,
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(Error)
    const message = outcome instanceof Error ? outcome.message : ''
    expect(message).toMatch(/exceeded 1ms/)
    expect(message).toContain('not a type error')
    expect(message).not.toContain('typecheck failed')
  }, 10_000)

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

        if (PLUGIN_API_VERSION !== '1.7.0') {
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

    // Negative control, in the consumed-manifest shape a non-stripped packed
    // manifest would impose (probed against the pinned bun 1.4.0): a tiny
    // synthetic dependency package ships a patches/better-auth@1.4.18.patch
    // file (content irrelevant — the failure precedes patch application) and
    // declares patchedDependencies for it, and is installed into a consumer
    // whose dependency set also contains better-auth@1.4.18.
    //
    // The synthetic package must be a packed tarball (`bun pm pack`), not a
    // directory `file:` dep: only the tarball shape reproduces the panic a
    // non-stripped `bun pm pack`-produced artifact imposes on its consumer
    // (exit 134, `Option::unwrap`, before patch application, triggered by the
    // patched package's presence in the consumer tree, output not naming the
    // patch). A directory `file:` dep with the same manifest never reaches
    // the panic: bun resolves the patch path against the consumer root, so
    // it either fails gracefully (exit 1, `Couldn't find patch file`, when
    // the path does not resolve there) or installs successfully (exit 0,
    // patch applied, when it does) — the latter is also a false failure for
    // this control, since the strip is fine.
    // Assert only the non-zero exit: a future bun that converts the panic
    // into a graceful error still fails here, and if
    // packedManifestOmittedFields ever loses 'patchedDependencies' the
    // successful install above fails with exactly this shape.
    const syntheticPackage = join(destination, 'patched-dependency-fixture')
    await mkdir(join(syntheticPackage, 'patches'), { recursive: true })
    await writeFile(
      join(syntheticPackage, 'package.json'),
      JSON.stringify({
        name: 'ab-packed-patch-negative-control',
        version: '1.0.0',
        patchedDependencies: {
          'better-auth@1.4.18': 'patches/better-auth@1.4.18.patch',
        },
      }),
    )
    await writeFile(join(syntheticPackage, 'patches', 'better-auth@1.4.18.patch'), 'irrelevant')
    const packed = await spawnExec(['bun', 'pm', 'pack'], { cwd: syntheticPackage })
    if (packed.exitCode !== 0) {
      throw new Error(
        `bun pm pack of the negative-control fixture failed:\n${packed.stdout}${packed.stderr}`,
      )
    }
    const syntheticTarball = join(syntheticPackage, 'ab-packed-patch-negative-control-1.0.0.tgz')
    if (!(await Bun.file(syntheticTarball).exists())) {
      throw new Error(`bun pm pack produced no tarball:\n${packed.stdout}${packed.stderr}`)
    }
    const negativeConsumer = join(destination, 'negative-control-consumer')
    await mkdir(negativeConsumer)
    await writeFile(
      join(negativeConsumer, 'package.json'),
      JSON.stringify({
        name: 'packed-patch-negative-control-consumer',
        private: true,
        type: 'module',
        dependencies: {
          'ab-packed-patch-negative-control': `file:${syntheticTarball}`,
          'better-auth': '1.4.18',
        },
      }),
    )
    const failing = await installPackedDistribution([], negativeConsumer)
    if (failing.exitCode === 0) {
      throw new Error(
        `the consumed-manifest negative control installed successfully — the patchedDependencies strip no longer guards the failure it exists for:\n${failing.stdout}${failing.stderr}`,
      )
    }
  }, 600_000)
})

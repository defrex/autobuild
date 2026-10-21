import { readDistributionIdentity } from './installation'
import { captureRuntimeIdentity } from '../runtime-identity'
import { DispatchUpgradeController } from './dispatch-upgrade-controller'
import { existsSync } from 'node:fs'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  prepareRuntime,
  validateRuntime,
  RUNTIME_CONFIG,
  validateCoreConfigs,
} from './dispatch-runtime-cache'
import {
  copyDependencies,
  scanDependencies,
  treeDigest,
  standalonePluginManifest,
} from './dispatch-runtime-dependencies'
import {
  releasePreparedRuntime,
  reservePreparedRuntime,
  activateRuntime,
  pruneRuntimes,
  retainRuntime,
  spawnUsingRuntime,
} from './dispatch-runtime-use'
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'ab-runtime-'))
  temporary.push(root)
  return root
}
async function file(path: string, bytes: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}
async function fixture() {
  const source = await temp(),
    checkout = await temp()
  await file(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@defrex/autobuild',
      version: '1.2.3',
      files: ['bin', 'packages'],
      dependencies: { example: '^1' },
    }),
  )
  await file(
    join(source, 'bin/ab.ts'),
    `import {value} from 'example'; if(value !== 42) throw new Error('mutable dependency'); console.log(value)`,
  )
  await file(join(source, 'bin/agent/ab'), 'source launcher')
  for (const entry of [
    'ab-dispatch-generation.ts',
    'ab-dispatch-kernel.ts',
    'ab-build-runner.ts',
    'ab-harvest-runner.ts',
    'ab-process-group-reaper.ts',
  ])
    await file(join(source, 'bin', entry), 'export {}')
  await file(join(source, 'packages/core/src/value.ts'), 'export const value = 42')
  await file(
    join(source, 'node_modules/example/package.json'),
    JSON.stringify({ name: 'example', version: '1.0.0', main: 'index.js' }),
  )
  await file(join(source, 'node_modules/example/index.js'), 'exports.value = 42')
  // This intentionally broken development config must remain byte-identical.
  await file(
    join(source, 'node_modules/example/tsconfig.json'),
    '{"extends":"@missing/development-config"}',
  )
  return { source, checkout }
}
test('offline content identity, exact reuse, independent dependency bytes and immutable corruption rejection', async () => {
  const { source, checkout } = await fixture()
  const first = await prepareRuntime(source, checkout)
  await validateRuntime(first)
  expect(await readFile(join(first.root, 'tsconfig.json'), 'utf8')).toBe(RUNTIME_CONFIG)
  const cachedDependency = join(first.root, 'node_modules/example/index.js')
  expect((await stat(cachedDependency)).ino).not.toBe(
    (await stat(join(source, 'node_modules/example/index.js'))).ino,
  )
  expect(await readFile(join(first.root, 'node_modules/example/tsconfig.json'), 'utf8')).toBe(
    '{"extends":"@missing/development-config"}',
  )
  expect((await prepareRuntime(source, checkout)).id).toBe(first.id)
  await file(join(source, 'packages/core/src/value.ts'), 'export const value = 43')
  const second = await prepareRuntime(source, checkout)
  expect(second.id).not.toBe(first.id)
  expect(second.dependencies).toBe(first.dependencies)
  await chmod(join(source, 'bin/ab.ts'), 0o755)
  expect((await prepareRuntime(source, checkout)).id).not.toBe(second.id)
  await file(join(first.root, 'tsconfig.json'), '{}')
  await expect(validateRuntime(first)).rejects.toThrow('compiler boundary')
  expect(await readFile(join(first.root, 'tsconfig.json'), 'utf8')).toBe('{}')
}, 30000)
test('missing installed required dependency fails before publication; optional absence and nested versions survive', async () => {
  const { source, checkout } = await fixture()
  await rm(join(source, 'node_modules/example'), { recursive: true })
  await expect(prepareRuntime(source, checkout)).rejects.toThrow(
    'repair the Autobuild installation',
  )
  await file(
    join(source, 'node_modules/example/package.json'),
    JSON.stringify({
      name: 'example',
      version: '1',
      main: 'index.js',
      dependencies: { nested: '1' },
      optionalDependencies: { absent: '1' },
    }),
  )
  await file(join(source, 'node_modules/example/index.js'), 'exports.value = 42')
  await file(
    join(source, 'node_modules/example/node_modules/nested/package.json'),
    '{"name":"nested","version":"1"}',
  )
  await file(
    join(source, 'node_modules/example/node_modules/nested/index.js'),
    'module.exports = 1',
  )
  const graph = await scanDependencies(source)
  expect(graph.packages.map((p) => p.manifest.name)).toEqual(['example', 'nested'])
  const destination = join(await temp(), 'distribution')
  await copyDependencies(graph, destination)
  expect(
    await readFile(join(destination, 'node_modules/example/node_modules/nested/index.js'), 'utf8'),
  ).toBe('module.exports = 1')
})
test('Autobuild compiler configs fail closed while third-party configs are outside the audit', async () => {
  const { source } = await fixture()
  await file(join(source, 'packages/tsconfig.json'), '{"extends":"../../mutable.json"}')
  await expect(validateCoreConfigs(source)).rejects.toThrow('escapes runtime')
  await file(join(source, 'packages/tsconfig.json'), '{"extends":"./base"}')
  await file(join(source, 'packages/base.json'), '{"extends":"../../mutable.json"}')
  await expect(validateCoreConfigs(source)).rejects.toThrow('escapes runtime')
  await file(join(source, 'packages/base.json'), '{ /* self-contained JSONC chain */ }')
  await validateCoreConfigs(source)
  await rm(join(source, 'packages/tsconfig.json'))
  await validateCoreConfigs(source)
  await symlink('/etc/passwd', join(source, 'packages/escape'))
  await expect(treeDigest(source)).rejects.toThrow('escapes runtime')
})
test('current, distinct previous, held and a live child survive pruning', async () => {
  const { source, checkout } = await fixture()
  const first = await prepareRuntime(source, checkout)
  activateRuntime(first.root)
  await file(join(source, 'packages/core/src/value.ts'), 'second')
  const second = await prepareRuntime(source, checkout)
  activateRuntime(second.root)
  activateRuntime(second.root)
  await file(join(source, 'packages/core/src/value.ts'), 'third')
  const third = await prepareRuntime(source, checkout)
  activateRuntime(third.root)
  await file(join(source, 'packages/core/src/value.ts'), 'fourth')
  const fourth = await prepareRuntime(source, checkout)
  retainRuntime(fourth.root, true)
  for (const runtime of [first, second, third, fourth]) releasePreparedRuntime(runtime.root)
  const use = spawnUsingRuntime(first.root, () =>
    Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  )
  try {
    pruneRuntimes(dirname(dirname(first.root)))
    await validateRuntime(first)
    await validateRuntime(second)
    await validateRuntime(third)
    await validateRuntime(fourth)
    retainRuntime(fourth.root, false)
    pruneRuntimes(dirname(dirname(first.root)))
    await expect(validateRuntime(fourth)).rejects.toThrow()
  } finally {
    use.child.kill()
    await use.child.exited
    use.release()
  }
  pruneRuntimes(dirname(dirname(first.root)))
  await expect(validateRuntime(first)).rejects.toThrow()
}, 30000)

test('concurrent offline preparations converge and internal asset links preserve native module identity', async () => {
  const { source, checkout } = await fixture()
  await symlink('index.js', join(source, 'node_modules/example/alias.js'))
  await file(
    join(source, 'bin/ab.ts'),
    `if(require('example') !== require('example/alias.js')) throw new Error('split module alias'); console.log('ok')`,
  )
  const [first, second] = await Promise.all([
    prepareRuntime(source, checkout),
    prepareRuntime(source, checkout),
  ])
  expect(first.id).toBe(second.id)
  await validateRuntime(first)
  await validateRuntime(second)
}, 30000)

test('a missing compiler boundary invalidates a dependency layer without repairing it', async () => {
  const { source, checkout } = await fixture()
  const runtime = await prepareRuntime(source, checkout)
  const compiler = join(
    checkout,
    '.autobuild/runtime/layers',
    runtime.dependencies,
    'distribution/tsconfig.json',
  )
  await rm(compiler)
  await expect(prepareRuntime(source, checkout)).rejects.toThrow('corrupt dependency layer')
  await expect(readFile(compiler)).rejects.toThrow()
})

test('standalone plugins infer literal native edges without importing consumer code', async () => {
  const source = await temp()
  await file(
    join(source, 'plugin.ts'),
    "import fs from 'fs'; import './local.cjs'; export const later=()=>import('@defrex/autobuild/plugin-sdk')",
  )
  await file(join(source, 'local.cjs'), "const h=require('helper'); module.exports=h")
  expect((await standalonePluginManifest(join(source, 'plugin.ts'), source)).dependencies).toEqual({
    '@defrex/autobuild': '*',
    helper: '*',
  })
})

test('standalone closure follows native suffix substitutions and every supported directory index', async () => {
  const source = await temp()
  const edges = [
    ['js-ts.js', 'js-ts.ts'],
    ['js-tsx.js', 'js-tsx.tsx'],
    ['jsx-ts.jsx', 'jsx-ts.ts'],
    ['jsx-tsx.jsx', 'jsx-tsx.tsx'],
    ['esm.mjs', 'esm.mts'],
    ['common.cjs', 'common.cts'],
    ...['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].map((extension) => [
      `directory-${extension}`,
      `directory-${extension}/index.${extension}`,
    ]),
    ['exact.js', 'exact.js'],
  ]
  for (const [, target] of edges)
    await file(join(source, target!), 'throw new Error("never evaluate while scanning")')
  await file(join(source, 'exact.ts'), 'throw new Error("must not select over exact.js")')
  const entry = join(source, 'plugin.ts')
  await file(entry, edges.map(([specifier]) => `import './${specifier}'`).join('\n'))
  const files = new Set<string>()
  await standalonePluginManifest(entry, source, files)
  expect([...files].sort()).toEqual(
    [entry, ...edges.map(([, target]) => join(source, target!))].sort(),
  )
})

test('standalone closure rejects missing relative imports with importer and specifier', async () => {
  const source = await temp()
  const entry = join(source, 'plugin.ts')
  const helper = join(source, 'lib/helper.ts')
  await file(entry, "export * from './lib/helper.js'")
  await file(helper, "export * from './missing.js'")
  await expect(standalonePluginManifest(entry, source)).rejects.toThrow(
    `cannot resolve standalone plugin import: ${helper}: ./missing.js`,
  )
})

test('first preparation, reuse and code edits work with installs forbidden and an unreachable registry', async () => {
  const { source, checkout } = await fixture()
  const commands = join(await temp(), 'commands')
  await mkdir(commands)
  await file(
    join(commands, 'bun'),
    `#!/bin/sh
if [ "$1" != pm ] || [ "$2" != pack ]; then
  echo 'dependency install or resolution is forbidden' >&2
  exit 97
fi
exec "$AB_TEST_REAL_BUN" "$@"
`,
  )
  await chmod(join(commands, 'bun'), 0o755)
  const script = `
    import {prepareRuntime} from ${JSON.stringify(join(import.meta.dir, 'dispatch-runtime-cache.ts'))};
    const first=await prepareRuntime(${JSON.stringify(source)},${JSON.stringify(checkout)});
    const again=await prepareRuntime(${JSON.stringify(source)},${JSON.stringify(checkout)});
    if(first.id !== again.id) throw new Error('offline exact reuse failed');
    await Bun.write(${JSON.stringify(join(source, 'packages/core/src/value.ts'))},'code edit');
    const changed=await prepareRuntime(${JSON.stringify(source)},${JSON.stringify(checkout)});
    if(first.id === changed.id || first.dependencies !== changed.dependencies) throw new Error('dependency layer was not reused');
  `
  const child = Bun.spawn([process.execPath, '--no-install', '--eval', script], {
    cwd: checkout,
    env: {
      PATH: `${commands}:${process.env.PATH}`,
      AB_TEST_REAL_BUN: process.execPath,
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
}, 30000)

test('a separate pruner cannot cross a spawn boundary before its live claim is published', async () => {
  const { source, checkout } = await fixture()
  const old = await prepareRuntime(source, checkout)
  activateRuntime(old.root)
  await file(join(source, 'packages/core/src/value.ts'), 'next')
  const next = await prepareRuntime(source, checkout)
  activateRuntime(next.root)
  await file(join(source, 'packages/core/src/value.ts'), 'current')
  const current = await prepareRuntime(source, checkout)
  activateRuntime(current.root)
  for (const runtime of [old, next, current]) releasePreparedRuntime(runtime.root)
  const ready = join(checkout, 'pruner-ready')
  const script = `import {writeFileSync} from 'node:fs'; import {pruneRuntimes} from ${JSON.stringify(join(import.meta.dir, 'dispatch-runtime-use.ts'))}; writeFileSync(${JSON.stringify(ready)},'ready'); pruneRuntimes(${JSON.stringify(dirname(dirname(old.root)))});`
  let pruner: ReturnType<typeof Bun.spawn> | undefined
  const use = spawnUsingRuntime(old.root, () => {
    // This callback executes under the pruning lock. The second process reaches
    // its barrier before the child exists; no timing-based scheduling is needed.
    pruner = Bun.spawn([process.execPath, '--no-install', '--eval', script], {
      cwd: checkout,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const deadline = Date.now() + 10000
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error('pruner failed to reach spawn barrier')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
    return Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
  })
  try {
    expect(await pruner!.exited).toBe(0)
    await validateRuntime(old)
  } finally {
    use.child.kill()
    await use.child.exited
    use.release()
    if (pruner?.exitCode === null) {
      pruner.kill()
      await pruner.exited
    }
  }
  pruneRuntimes(dirname(dirname(old.root)))
  await expect(validateRuntime(old)).rejects.toThrow()
}, 30000)

test('launcher-owned candidate reservations survive generation exit and are reclaimed on launcher death', async () => {
  const { source, checkout } = await fixture()
  const runtime = await prepareRuntime(source, checkout)
  const cache = dirname(dirname(runtime.root))
  const owner = Bun.spawn([process.execPath, '--eval', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    reservePreparedRuntime(cache, runtime.id, owner.pid)
    releasePreparedRuntime(runtime.root)
    pruneRuntimes(cache)
    expect(existsSync(runtime.root)).toBe(true)
    owner.kill('SIGTERM')
    await owner.exited
    pruneRuntimes(cache)
    expect(existsSync(runtime.root)).toBe(false)
  } finally {
    if (owner.exitCode === null) {
      owner.kill('SIGTERM')
      await owner.exited
    }
  }
})

test('cached and archived forge runtimes preserve abbreviated Bun provenance for fresh-launch comparison', async () => {
  const { source, checkout } = await fixture()
  const tag = 'fork-owner-repo-name-a1b2c3d'
  const manifestPath = join(source, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, bin: 'bin/ab.ts' }))
  await writeFile(join(source, '.bun-tag'), tag)
  const runtime = await prepareRuntime(source, checkout)
  const extracted = await temp()
  await Bun.$`tar -xzf ${join(dirname(runtime.root), 'distribution.tgz')} --strip-components=1 -C ${extracted}`.quiet()
  for (const root of [runtime.root, extracted]) {
    const installed = await readDistributionIdentity(root)
    expect(installed.bunTag).toBe(tag)
    expect(installed.commit).toBe('a1b2c3d')
    const from = captureRuntimeIdentity(root)
    expect(from.commit).toBe('unknown')
    const controller = new DispatchUpgradeController({
      run: 'fresh',
      lineage: 'fresh-lineage',
      from,
      runningBunTag: installed.bunTag,
      failedKeys: [],
      enabled: () => true,
      resolve: async () => ({
        mode: 'pinned',
        key: 'forge',
        source: 'main',
        record: ['@defrex/autobuild@github:fork-owner/repo-name#a1b2c3d', {}, tag],
      }),
      prepare: async () => {
        throw new Error('unchanged forge target must not install')
      },
      append: async () => {
        throw new Error('unchanged forge target must not emit upgrade facts')
      },
      cutover: async () => {
        throw new Error('unchanged forge target must not cut over')
      },
    })
    await controller.check()
    await controller.stop()
  }
})

import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionRoot } from '../distribution'
import { prepareRuntime } from '../cli/dispatch-runtime-cache'

test('native plugin closures share frozen SDK values across ESM, CJS, delayed imports and real shipped packages', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ab-plugin-runtime-'))
  try {
    const runtime = await prepareRuntime(distributionRoot(), temporary)
    const plugin = join(temporary, 'consumer', 'plugin')
    const helper = join(plugin, 'node_modules', 'helper')
    await mkdir(helper, { recursive: true })
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({ name: 'proof-plugin', type: 'module', dependencies: { helper: '1' } }),
    )
    await writeFile(join(plugin, 'tsconfig.json'), '{"extends":"../../mutable.json"}')
    await writeFile(join(plugin, 'asset.txt'), 'copied asset')
    await writeFile(
      join(helper, 'package.json'),
      JSON.stringify({
        name: 'helper',
        version: '1',
        main: 'index.cjs',
        peerDependencies: { '@defrex/autobuild': '*' },
      }),
    )
    await writeFile(
      join(helper, 'index.cjs'),
      `const sdk = require('@defrex/autobuild/plugin-sdk'); exports.sdk = sdk; exports.path = require.resolve('@defrex/autobuild/plugin-sdk');`,
    )
    await writeFile(
      join(plugin, 'index.ts'),
      `
      import * as sdk from '@defrex/autobuild/plugin-sdk';
      import helper from 'helper';
      import {createRequire} from 'node:module';
      export {PluginApiCompatibilityError} from '@defrex/autobuild/plugin-sdk';
      export {sdk,helper};
      export const required = createRequire(import.meta.url)('@defrex/autobuild/plugin-sdk');
      export const delayed = () => import(['@defrex/autobuild','plugin-sdk'].join('/'));
      export const asset = await Bun.file(new URL('./asset.txt',import.meta.url)).text();
    `,
    )
    const mutable = join(temporary, 'mutable.ts')
    await writeFile(mutable, "throw new Error('mutable compiler alias loaded')")
    await writeFile(
      join(temporary, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '*': [mutable] }, baseUrl: '.' } }),
    )
    const entry = join(plugin, 'index.ts')
    const probe = `
      import {snapshotPlugin} from ${JSON.stringify(join(runtime.root, 'packages/core/src/plugins/runtime-snapshot.ts'))};
      import * as core from ${JSON.stringify(join(runtime.root, 'packages/core/src/plugin-sdk/index.ts'))};
      const copied=await snapshotPlugin(${JSON.stringify(entry)},true);
      const p=await import(copied);
      for(const value of [p.sdk,p.helper.sdk,p.required,await p.delayed()]) {
        if(value.PluginApiCompatibilityError !== core.PluginApiCompatibilityError || value.VERCEL_SANDBOX_CAPABILITIES !== core.VERCEL_SANDBOX_CAPABILITIES) throw new Error('duplicate core identity');
      }
      if(!p.helper.path.startsWith(${JSON.stringify(runtime.root)}) || p.asset !== 'copied asset' || copied === ${JSON.stringify(entry)}) throw new Error('mutable filename or lost asset');
      const vercel=await snapshotPlugin(${JSON.stringify(Bun.resolveSync('@defrex/autobuild-vercel-sandbox', distributionRoot()))},false);
      const v=await import(vercel);
      if(v.default.workspaceProviders['vercel-sandbox'].capabilities !== core.VERCEL_SANDBOX_CAPABILITIES) throw new Error('shipped plugin identity');
      const postgres=await snapshotPlugin(${JSON.stringify(Bun.resolveSync('@defrex/autobuild-postgres-store', distributionRoot()))},false);
      if(typeof (await import(postgres)).PostgresBuildStore !== 'function') throw new Error('postgres missing');
      for(const [base,name] of [[vercel,'@vercel/sandbox'],[postgres,'@vercel/blob'],[postgres,'@aws-sdk/client-s3']]) {
        const path=Bun.resolveSync(name,base.slice(0,base.lastIndexOf('/')));
        const namespace=await import(path);
        if(Object.keys(namespace).length < 10) throw new Error('empty dependency namespace '+name);
      }
      console.log('native closures loaded');
    `
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--tsconfig-override',
        join(runtime.root, 'tsconfig.json'),
        '--eval',
        probe,
      ],
      { cwd: temporary, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toBe('native closures loaded\n')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 60000)

test('root repo modules copy only reached files and dependencies and reclaim dead snapshots while core stays live', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ab-plugin-bounded-'))
  try {
    const runtime = await prepareRuntime(distributionRoot(), temporary)
    const repo = join(temporary, 'consumer')
    await mkdir(join(repo, 'node_modules/unused'), { recursive: true })
    await writeFile(join(repo, 'autobuild.toml'), 'plugins = ["./autobuild-plugin.ts"]')
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'consumer', devDependencies: { unused: '1' } }),
    )
    await writeFile(
      join(repo, 'node_modules/unused/package.json'),
      '{"name":"unused","version":"1"}',
    )
    await writeFile(join(repo, 'unrelated.txt'), 'unrelated bytes')
    const { symlink } = await import('node:fs/promises')
    await symlink('/outside-consumer', join(repo, 'unrelated-link'))
    await mkdir(join(repo, 'node_modules/@defrex'), { recursive: true })
    await symlink(distributionRoot(), join(repo, 'node_modules/@defrex/autobuild'))
    const fifo = Bun.spawn(['mkfifo', join(repo, 'unrelated-fifo')])
    expect(await fifo.exited).toBe(0)
    await writeFile(join(repo, 'asset.txt'), 'asset')
    await mkdir(join(repo, 'lib'), { recursive: true })
    await writeFile(join(repo, 'lib/helper.ts'), 'export const value = 1')
    await writeFile(join(repo, 'lib/view.tsx'), 'export const view = 2')
    await writeFile(join(repo, 'lib/esm.mts'), 'export const esm = 3')
    await writeFile(join(repo, 'lib/common.cts'), 'exports.common = 4')
    await mkdir(join(repo, 'lib/directory'), { recursive: true })
    await writeFile(join(repo, 'lib/directory/index.tsx'), 'export const directory = 5')
    await writeFile(
      join(repo, 'autobuild-plugin.ts'),
      `
      export {value} from './lib/helper.js';
      export {view} from './lib/view.jsx';
      export {esm} from './lib/esm.mjs';
      export {common} from './lib/common.cjs';
      export {directory} from './lib/directory';
      export const asset = await Bun.file(new URL('./asset.txt', import.meta.url)).text();
      export {PluginApiCompatibilityError} from '@defrex/autobuild/plugin-sdk';
    `,
    )
    const direct = await import(join(repo, 'autobuild-plugin.ts'))
    expect([direct.value, direct.view, direct.esm, direct.common, direct.directory]).toEqual([
      1, 2, 3, 4, 5,
    ])
    const run = async () => {
      const script = `
        import {snapshotPlugin} from ${JSON.stringify(join(runtime.root, 'packages/core/src/plugins/runtime-snapshot.ts'))};
        const path = await snapshotPlugin(${JSON.stringify(join(repo, 'autobuild-plugin.ts'))}, true);
        const p = await import(path);
        console.log(JSON.stringify({path,value:p.value,asset:p.asset,suffixes:[p.view,p.esm,p.common,p.directory]}));
      `
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          '--tsconfig-override',
          join(runtime.root, 'tsconfig.json'),
          '--eval',
          script,
        ],
        { cwd: repo, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, error).toBe(0)
      return JSON.parse(output) as {
        path: string
        value: number
        asset: string
        suffixes: number[]
      }
    }
    const first = await run()
    const { access, readdir } = await import('node:fs/promises')
    const root = first.path.slice(0, first.path.lastIndexOf('/'))
    expect(first).toMatchObject({ value: 1, asset: 'asset', suffixes: [2, 3, 4, 5] })
    expect((await readdir(root)).sort()).toEqual([
      'asset.txt',
      'autobuild-plugin.ts',
      'lib',
      'node_modules',
      'package.json',
      'tsconfig.json',
    ])
    expect((await readdir(join(root, 'lib'))).sort()).toEqual([
      'common.cts',
      'directory',
      'esm.mts',
      'helper.ts',
      'view.tsx',
    ])
    expect(await readdir(join(root, 'node_modules'))).toEqual(['@defrex'])
    await writeFile(join(repo, 'unrelated.txt'), 'edited unrelated bytes')
    expect((await run()).path).toBe(first.path)
    await writeFile(join(repo, 'lib/helper.ts'), 'export const value = 2')
    const changed = await run()
    expect(changed.value).toBe(2)
    expect(changed.path).not.toBe(first.path)
    await expect(access(first.path)).rejects.toThrow()
    expect(
      (await readdir(join(temporary, '.autobuild/runtime/extensions'))).filter((x) =>
        /^[a-f0-9]{64}$/.test(x),
      ),
    ).toHaveLength(1)
    // The preparer's core claim is still live: reclamation needed no launcher exit.
    await access(runtime.root)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 60000)

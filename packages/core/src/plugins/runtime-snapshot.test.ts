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
      const vercel=await snapshotPlugin(${JSON.stringify(join(distributionRoot(), 'packages/vercel-sandbox/src/index.ts'))},false);
      const v=await import(vercel);
      if(v.default.workspaceProviders['vercel-sandbox'].capabilities !== core.VERCEL_SANDBOX_CAPABILITIES) throw new Error('shipped plugin identity');
      const postgres=await snapshotPlugin(${JSON.stringify(join(distributionRoot(), 'packages/postgres-store/src/index.ts'))},false);
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

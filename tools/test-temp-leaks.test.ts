import { expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkoutRoot, inspectionRoot, runInspected, suiteCommands } from './test-temp-leaks'

const inline = (script: string) => [process.execPath, '-e', script]

test('clean children and grandchildren inherit isolated external temp; concurrent runs do not share it', async () => {
  const fixture = await inspectionRoot()
  try {
    const runs = [0, 1].map((index) =>
      runInspected([
        inline(`
      import {tmpdir} from 'node:os';
      import {writeFileSync} from 'node:fs';
      const git = Bun.spawnSync(['git','rev-parse','--show-toplevel'], {cwd:tmpdir()});
      if (git.exitCode === 0) process.exit(10);
      const child = Bun.spawnSync([process.execPath,'-e','console.log(require("node:os").tmpdir())']);
      if (child.stdout.toString().trim() !== tmpdir()) process.exit(11);
      writeFileSync(${JSON.stringify(join(fixture, 'root-'))} + ${index}, tmpdir());
    `),
      ]),
    )
    expect(await Promise.all(runs)).toEqual([0, 0])
    const roots = await Promise.all([0, 1].map((i) => readFile(join(fixture, `root-${i}`), 'utf8')))
    expect(roots[0]).not.toBe(roots[1])
    for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('leaks fail successful children, failed children retain exit status, and later commands are skipped', async () => {
  for (const exit of [0, 7]) {
    const reports: string[] = []
    const code = await runInspected(
      [
        inline(
          `require('node:fs').mkdirSync(require('node:os').tmpdir()+'/ab-dispatch-route-leak'); process.exit(${exit})`,
        ),
        inline('throw Error("rehearsal must not run")'),
      ],
      { report: (message) => reports.push(message) },
    )
    expect(code).toBe(exit || 1)
    expect(reports.join()).toContain('ab-dispatch-route-leak')
  }
})

test.each(['file', 'socket', 'symlink'])(
  'reports a leaked %s before removing the owned inspection root',
  async (kind) => {
    const fixture = await inspectionRoot()
    try {
      const record = join(fixture, 'root')
      const reports: string[] = []
      const code = await runInspected(
        [
          inline(`
          import {tmpdir} from 'node:os';
          import {writeFileSync,symlinkSync} from 'node:fs';
          import {createServer} from 'node:net';
          writeFileSync(${JSON.stringify(record)},tmpdir());
          const path=tmpdir()+'/leaked-${kind}';
          if (${JSON.stringify(kind)} === 'file') writeFileSync(path,'leak');
          if (${JSON.stringify(kind)} === 'symlink') symlinkSync('missing-target',path);
          if (${JSON.stringify(kind)} === 'socket') {
            const server=createServer();
            await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)});
          }
          process.exit(0);
        `),
        ],
        { report: (message) => reports.push(message) },
      )
      expect(code).toBe(1)
      expect(reports.join()).toContain(`leaked-${kind}`)
      await expect(stat(await readFile(record, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  },
)

test('each integration stage is inspected before rehearsal starts', async () => {
  const reports: string[] = []
  expect(
    await runInspected(
      [
        inline('void 0'),
        inline("require('node:fs').mkdirSync(require('node:os').tmpdir()+'/arbitrary-leak')"),
      ],
      { report: (message) => reports.push(message) },
    ),
  ).toBe(1)
  expect(reports.join()).toContain('arbitrary-leak')
  const commands = await suiteCommands('integration', [])
  expect(commands[0]?.some((arg) => arg.endsWith('.integration.test.ts'))).toBe(true)
  expect(commands[1]).toEqual([process.execPath, 'tools/hosted-service-packaging.ts'])
})

test('checkout-contained ambient temp falls back; Bun temp cwd does not discover checkout env or config', async () => {
  const fixture = await inspectionRoot()
  try {
    const synthetic = join(fixture, 'checkout')
    await mkdir(synthetic)
    await writeFile(join(synthetic, '.env'), 'TEMP_DISCOVERY_SENTINEL=wrong\n')
    await writeFile(join(synthetic, 'bunfig.toml'), '[run]\nshell="invalid"\n')
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
      import {inspectionRoot} from ${JSON.stringify(join(checkoutRoot, 'tools/test-temp-leaks.ts'))};
      const root = await inspectionRoot(${JSON.stringify(synthetic)});
      const fs = await import('node:fs/promises');
      await fs.mkdir(root+'/node_modules/temp-fixture',{recursive:true});
      await fs.writeFile(root+'/node_modules/temp-fixture/package.json',JSON.stringify({name:'temp-fixture',main:'index.js'}));
      await fs.writeFile(root+'/node_modules/temp-fixture/index.js','module.exports=42');
      const child = Bun.spawnSync([process.execPath,'-e','if(process.env.TEMP_DISCOVERY_SENTINEL || require("temp-fixture")!==42)process.exit(12)'],{cwd:root});
      await require('node:fs/promises').rm(root,{recursive:true,force:true});
      process.exit(child.exitCode);
    `,
      ],
      {
        cwd: fixture,
        env: { ...process.env, TMPDIR: synthetic, TEMP_DISCOVERY_SENTINEL: undefined },
      },
    )
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test.each(['SIGINT', 'SIGTERM'] as const)(
  'forwards %s and waits for child shutdown before removing inspection root',
  async (signal) => {
    const fixture = await inspectionRoot()
    let wrapper: ReturnType<typeof Bun.spawn> | undefined
    try {
      const ready = join(fixture, 'ready')
      const stopped = join(fixture, 'stopped')
      const script = `
      import {writeFileSync,existsSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      process.on('${signal}',async()=>{
        await Bun.sleep(30);
        if(!existsSync(tmpdir()))process.exit(22);
        writeFileSync(${JSON.stringify(stopped)},'stopped');
        process.exit(9);
      });
      writeFileSync(${JSON.stringify(ready)},tmpdir());
      await Bun.sleep(60000);
    `
      wrapper = Bun.spawn(
        [
          process.execPath,
          '-e',
          `
      import {runInspected} from ${JSON.stringify(join(checkoutRoot, 'tools/test-temp-leaks.ts'))};
      process.exitCode=await runInspected([${JSON.stringify(inline(script))}]);
    `,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const deadline = Date.now() + 5000
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw Error('child did not start')
        await Bun.sleep(10)
      }
      const scratch = await readFile(ready, 'utf8')
      wrapper.kill(signal)
      expect(await wrapper.exited).toBe(9)
      expect(await readFile(stopped, 'utf8')).toBe('stopped')
      const { stat } = await import('node:fs/promises')
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (wrapper && wrapper.exitCode === null) {
        wrapper.kill()
        await wrapper.exited
      }
      await rm(fixture, { recursive: true, force: true })
    }
  },
)

test('fixture ownership survives failed beforeEach setup', async () => {
  const fixture = await inspectionRoot()
  try {
    const path = join(fixture, 'setup.test.ts')
    await writeFile(
      path,
      `
      import {afterEach,beforeEach,test} from 'bun:test';
      import {temporaryDirectories} from ${JSON.stringify(join(checkoutRoot, 'packages/core/src/testing/temp-directories.ts'))};
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const allocate=temporaryDirectories(afterEach);
      beforeEach(async()=>{await allocate(join(tmpdir(),'partial-setup-'));throw Error('setup failed')});
      test('unreachable',()=>{});
    `,
    )
    const reports: string[] = []
    expect(
      await runInspected([[process.execPath, 'test', path]], {
        report: (message) => reports.push(message),
      }),
    ).toBe(1)
    expect(reports).toEqual([])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('failed child diagnostics survive leak reporting and the owned root is removed', async () => {
  const fixture = await inspectionRoot()
  try {
    const record = join(fixture, 'root')
    const childScript = `
      import {tmpdir} from 'node:os';
      import {mkdirSync,writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(record)},tmpdir());
      mkdirSync(tmpdir()+'/arbitrary-leak');
      console.error('original child diagnostic');
      process.exit(7);
    `
    const wrapper = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
      import {runInspected} from ${JSON.stringify(join(checkoutRoot, 'tools/test-temp-leaks.ts'))};
      process.exitCode=await runInspected([${JSON.stringify(inline(childScript))}]);
    `,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stderr] = await Promise.all([wrapper.exited, new Response(wrapper.stderr).text()])
    expect(code).toBe(7)
    expect(stderr).toContain('original child diagnostic')
    expect(stderr).toContain('arbitrary-leak')
    await expect(stat(await readFile(record, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

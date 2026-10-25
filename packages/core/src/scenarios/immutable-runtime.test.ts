import { openLocalStore } from '../store/local/store'
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { distributionRoot } from '../distribution'
import { packageDistribution } from '../distribution-packaging'
import {
  prepareRuntime,
  runtimeSpawnArguments,
  validateRuntime,
} from '../cli/dispatch-runtime-cache'
import { installPackedDistribution } from '../testing/packed-install'
import { scanDependencies, treeDigest } from '../cli/dispatch-runtime-dependencies'
import { spawnExec } from '../ports/workspace/git-worktree'

// Installed files can share inodes with Bun's package cache. Unlink before
// mutation so this fixture only changes its disposable installation.
async function replaceInstalledFile(path: string, contents: string) {
  await rm(path, { force: true })
  await writeFile(path, contents)
}

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
for (const mode of ['package', 'source'])
  test(`real ${mode} runtime freezes production graphs, later runners, agents and third-party bytes`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'ab-real-runtime-'))
    try {
      const installed = join(temporary, 'installed'),
        checkout = join(temporary, 'consumer with spaces')
      await mkdir(installed)
      await mkdir(checkout)
      const archive = join(temporary, 'distribution.tgz')
      await writeFile(archive, await packageDistribution(distributionRoot()))
      expect(
        (await spawnExec(['tar', '-xzf', archive, '--strip-components=1', '-C', installed], {}))
          .exitCode,
      ).toBe(0)
      const setup = await installPackedDistribution(['--production', '--ignore-scripts'], installed)
      expect(setup.exitCode, setup.stderr).toBe(0)
      const mutableDependency = Bun.resolveSync('smol-toml', installed)
      if (mode === 'source') {
        await writeFile(join(installed, '.gitignore'), 'node_modules/\n')
        for (const command of [
          ['git', 'init', '-q', '-b', 'main'],
          ['git', 'config', 'user.name', 'Source Fixture'],
          ['git', 'config', 'user.email', 'source@example.invalid'],
          ['git', 'add', '.'],
          ['git', 'commit', '-qm', 'source fixture'],
        ])
          expect((await spawnExec(command, { cwd: installed })).exitCode).toBe(0)
        await writeFile(
          join(installed, 'packages/core/src/uncommitted-runtime-probe.ts'),
          'export const uncommitted = true',
        )
      }
      const outside = join(temporary, 'mutable.ts')
      await writeFile(outside, "throw new Error('MUTABLE CHECKOUT LOADED')")
      await writeFile(
        join(checkout, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@defrex/autobuild/*': [outside] } },
        }),
      )
      if (mode === 'source')
        await replaceInstalledFile(
          join(installed, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { paths: { '@defrex/autobuild/*': [outside] }, baseUrl: '.' },
          }),
        )
      const runtime = await prepareRuntime(installed, checkout)
      if (mode === 'source')
        expect(
          await readFile(
            join(runtime.root, 'packages/core/src/uncommitted-runtime-probe.ts'),
            'utf8',
          ),
        ).toBe('export const uncommitted = true')
      // express-rate-limit ships a development config extending files omitted
      // from npm; @ljharb packages likewise carry development-only extends.
      const graph = await scanDependencies(installed)
      expect(graph.packages.some((p) => p.manifest.name === 'express-rate-limit')).toBe(true)
      let hasLjharbConfig = false
      for (const entry of graph.packages) {
        try {
          hasLjharbConfig ||= (
            await readFile(join(entry.source, 'tsconfig.json'), 'utf8')
          ).includes('@ljharb/')
        } catch {}
      }
      expect(hasLjharbConfig).toBe(true)
      for (const [index, entry] of graph.packages.entries()) {
        expect(
          await treeDigest(
            join(runtime.root, 'node_modules', '.ab-packages', String(index)),
            new Set(['node_modules']),
          ),
          entry.manifest.name,
        ).toBe(entry.digest)
      }
      const probe = `
      import { RUNTIME_IDENTITY } from ${JSON.stringify(join(runtime.root, 'packages/core/src/runtime-identity.ts'))};
      await import(${JSON.stringify(join(runtime.root, 'packages/core/src/cli/binary-direct.ts'))});
      await import(${JSON.stringify(join(runtime.root, 'packages/core/src/cli/dispatch.ts'))});
      await import(${JSON.stringify(join(runtime.root, 'packages/core/src/processes/build-child.ts'))});
      await import(${JSON.stringify(join(runtime.root, 'packages/core/src/processes/harvest-child.ts'))});
      if(RUNTIME_IDENTITY.source.location !== ${JSON.stringify(runtime.root)}) throw new Error('wrong runtime');
      const {resolveDistributionArchive}=await import(${JSON.stringify(join(runtime.root, 'packages/core/src/ports/workspace/distribution-archive.ts'))});
      if((await resolveDistributionArchive()).digest !== ${JSON.stringify(runtime.archiveDigest)}) throw new Error('wrong frozen archive');
      console.log('graphs loaded');`
      const command = [
        process.execPath,
        '--no-install',
        '--tsconfig-override',
        join(runtime.root, 'tsconfig.json'),
        '--eval',
        probe,
      ]
      expect(await run(command, checkout)).toMatchObject({
        code: 0,
        stdout: 'graphs loaded\n',
        stderr: '',
      })
      await writeFile(
        join(checkout, 'package.json'),
        JSON.stringify({ name: 'runtime-consumer', type: 'module' }),
      )
      await writeFile(join(checkout, '.gitignore'), '.autobuild/\ntickets/\n')
      await writeFile(
        join(checkout, 'autobuild.toml'),
        `baseBranch = "main"
forge = "local-git"
ticketScanIntervalSeconds = 1
plugins = ["./fixture-plugin.ts"]
[roles.default]
runtime = "proof"
[tickets]
source = "file"
dir = ${JSON.stringify(join(checkout, 'tickets'))}
readyState = "ready"
`,
      )
      await writeFile(
        join(checkout, 'fixture-plugin.ts'),
        `
      import {ScriptedAgentRunner,defaultTurnResult} from '@defrex/autobuild/plugin-sdk';
      export default {name:'proof',apiVersion:'^1.0.0',agentRuntimes:{proof:()=>({servesModels:[],runner:new ScriptedAgentRunner({script:async ctx=>{
        if(ctx.opts.env.AB_DISPATCH_GENERATION) throw new Error('marker leaked to agent');
        const context = Bun.spawn(['ab','context','--json'],{cwd:ctx.opts.workspacePath,env:ctx.opts.env,stdout:'pipe',stderr:'pipe'});
        const text = await new Response(context.stdout).text();
        const error = await new Response(context.stderr).text();
        if(await context.exited !== 0) throw new Error(error);
        const stop = Bun.spawn(['ab','escalate','cached agent context succeeded'],{cwd:ctx.opts.workspacePath,env:ctx.opts.env,stdout:'ignore',stderr:'pipe'});
        const stopError = await new Response(stop.stderr).text();
        if(await stop.exited !== 0) throw new Error(stopError);
        return defaultTurnResult(text);
      }})})}};
    `,
      )
      for (const command of [
        ['git', 'init', '-q', '-b', 'main'],
        ['git', 'config', 'user.name', 'Runtime Test'],
        ['git', 'config', 'user.email', 'runtime@example.invalid'],
        ['git', 'add', '.'],
        ['git', 'commit', '-qm', 'fixture'],
      ])
        expect((await spawnExec(command, { cwd: checkout })).exitCode).toBe(0)
      await mkdir(join(checkout, 'tickets/ready'), { recursive: true })
      const storePath = join(checkout, '.autobuild', 'store')
      const store = openLocalStore(storePath)
      const dispatch = Bun.spawn(
        [
          process.execPath,
          join(installed, 'bin/ab.ts'),
          'dispatch',
          '--plain',
          '--intake',
          '--interval',
          '0.05',
          '--store',
          storePath,
        ],
        {
          cwd: checkout,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            AB_DISPATCH_GENERATION: 'inherited-invalid-marker',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const dispatchOutput = new Response(dispatch.stdout).text()
      const dispatchErrors = new Response(dispatch.stderr).text()
      async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
        const deadline = Date.now() + 30000
        for (;;) {
          const value = await read()
          if (value !== undefined) return value
          if (dispatch.exitCode !== null)
            throw new Error(`dispatcher exited: ${await dispatchErrors}`)
          if (Date.now() > deadline)
            throw new Error(
              'timed out waiting for durable runtime evidence: ' +
                JSON.stringify({
                  repo: await store.getRepoEvents(checkout),
                  builds: await Promise.all(
                    (await store.listBuilds()).map(async (b) => await store.getEvents(b.slug)),
                  ),
                }),
            )
          await Bun.sleep(25)
        }
      }
      try {
        const started = await until(async () =>
          (await store.getRepo(checkout))
            ? (await store.getRepoEvents(checkout)).find(
                (e) => e.type === 'dispatcher.runtime-recorded',
              )
            : undefined,
        )
        expect(started.payload).toMatchObject({ runtime: { source: { location: runtime.root } } })
        // Replace the invoking installation and every ancestor compiler alias.
        await replaceInstalledFile(
          mutableDependency,
          "throw new Error('MUTABLE DEPENDENCY LOADED')",
        )
        if (mode === 'source')
          await replaceInstalledFile(
            join(installed, 'tsconfig.json'),
            JSON.stringify({
              compilerOptions: {
                paths: { '*': [outside] },
                baseUrl: dirname(outside),
                jsx: 'react',
              },
            }),
          )
        await replaceInstalledFile(
          join(installed, 'bin/ab.ts'),
          "throw new Error('MUTABLE INSTALL LOADED')",
        )
        await replaceInstalledFile(
          join(installed, 'packages/core/src/cli/binary-direct.ts'),
          "throw new Error('MUTABLE CORE LOADED')",
        )
        await writeFile(
          join(checkout, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { baseUrl: dirname(outside), jsx: 'react', paths: { '*': [outside] } },
          }),
        )
        expect(await run(command, checkout)).toMatchObject({
          code: 0,
          stdout: 'graphs loaded\n',
          stderr: '',
        })
        for (const entry of ['ab-build-runner.ts', 'ab-harvest-runner.ts']) {
          const result = await run(
            runtimeSpawnArguments(runtime.root, join(runtime.root, 'bin', entry)),
            checkout,
            { PATH: process.env.PATH },
          )
          expect(result, entry).toMatchObject({ code: 2, stderr: '' })
        }
        const agent = await run([join(runtime.root, 'bin/agent/ab'), '--version'], checkout, {
          PATH: process.env.PATH,
          AB_DISPATCH_GENERATION: 'invalid',
        })
        expect(agent.code, agent.stderr).toBe(0)
        expect(agent.stdout).toContain('autobuild')
        await rm(join(installed, 'packages/core/src'), { recursive: true })
        await writeFile(
          join(checkout, 'tickets/ready/proof.md'),
          '+++\nid = "proof"\ntitle = "Immutable runtime proof"\n+++\nHat: product.\n## What\nProve cached execution.\n## Acceptance criteria\n- Record a cached agent escalation.\n## Out of scope\n- Automatic upgrades.\n## Evidence\n- Disposable runtime mutation fixture.\n',
        )
        const record = await until(async () => (await store.listBuilds()).at(0))
        const escalation = await until(async () =>
          (await store.getEvents(record.slug)).find((e) => e.type === 'escalation.raised'),
        )
        expect(escalation.payload).toMatchObject({ question: 'cached agent context succeeded' })
        const recorded = (await store.getEvents(record.slug)).find(
          (e) => e.type === 'runner.runtime-recorded',
        )
        expect(recorded?.payload).toMatchObject({ runtime: { source: { location: runtime.root } } })
      } finally {
        dispatch.kill('SIGINT')
        await dispatch.exited
        expect(await dispatchErrors).not.toContain('MUTABLE')
        await dispatchOutput
        await store.close()
      }
      await validateRuntime(runtime)
      expect(await realpath(runtime.root)).toBe(runtime.root)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 180000)

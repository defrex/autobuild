import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginModuleReport } from './load'

/**
 * End-to-end loader behavior with the installer out of reach (AUT-587).
 *
 * The production crash: `Bun.resolveSync` of a bare package specifier that
 * no `node_modules` lookup satisfies hands the specifier to Bun's runtime
 * auto-installer, which fetches from the network and writes a cache — and on
 * the hosted dispatcher function's read-only filesystem that is a fatal,
 * uncatchable process exit (`error: bun is unable to write files: EROFS`,
 * exit status 1). The loader's disk-first gate keeps the installer
 * unreachable; these subprocess tests pin the loader's shape when the
 * installer cannot answer at all, spawned under `bun --no-install`:
 *
 * - an unresolvable bare specifier is an ordinary failed report, not a crash;
 * - a package staged on disk loads from disk;
 * - a missing repo-path specifier stays a catchable failure.
 *
 * The manual proof of the fatal class itself is the planner-verified EROFS
 * repro (a read-only tmpfs remount plus `--install=force`): permission-bit
 * read-only directories are NOT a valid repro — Bun falls back to writing
 * `node_modules/.cache` and succeeds — and `--install=force` must never be
 * combined with these fixtures, because it shadows on-disk packages from the
 * registry. Neither is attempted in CI; `--no-install` is the portable bound.
 */

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const LOAD_SOURCE = resolve(import.meta.dir, 'load.ts')

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-plugin-installcrash-'))
  temporary.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  return repo
}

/** A runner script: imports the loader from the core source by absolute
 * path, runs `diagnosePlugins` over the specifiers, and prints the reports
 * as JSON on stdout. Exit code 0 whenever the loader returns at all — a
 * nonzero exit means the process crashed, which is the property under test.
 * The installation root arrives through the environment — no string surgery
 * in generated code. */
async function writeRunner(
  directory: string,
  specifiers: string[],
  extraOptions: string,
): Promise<string> {
  const runner = join(directory, 'runner.ts')
  await writeFile(
    runner,
    `import { diagnosePlugins } from ${JSON.stringify(LOAD_SOURCE)}
const repoRoot = process.argv[2]!
const diagnosis = await diagnosePlugins(${JSON.stringify(specifiers)}, repoRoot, {
  installationRoot: process.env.AB_INSTALLATION_ROOT!,${
    extraOptions
      ? `
  ${extraOptions},`
      : ''
  }
})
console.log(JSON.stringify(diagnosis.reports))
`,
  )
  return runner
}

function run(
  runner: string,
  cwd: string,
  installationRoot: string,
): {
  exitCode: number
  reports: PluginModuleReport[]
  output: string
} {
  const spawned = Bun.spawnSync({
    cmd: ['bun', '--no-install', runner, cwd],
    cwd,
    env: { ...process.env, AB_INSTALLATION_ROOT: installationRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${spawned.stdout.toString()}${spawned.stderr.toString()}`
  return {
    exitCode: spawned.exitCode ?? -1,
    reports: JSON.parse(spawned.stdout.toString()) as PluginModuleReport[],
    output,
  }
}

describe('plugin loading with the installer out of reach (AUT-587)', () => {
  test('an unresolvable bare specifier is a failed report, never a process crash', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installation')
    await mkdir(installationRoot, { recursive: true })
    const runner = await writeRunner(repo, ['@defrex/autobuild-nonexistent-plugin'], '')
    const { exitCode, reports, output } = run(runner, repo, installationRoot)
    // The whole point: the loader REPORTS, the process survives.
    expect(exitCode).toBe(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      module: '@defrex/autobuild-nonexistent-plugin',
      status: 'failed',
      stage: 'resolution',
      resolutionKind: 'package',
    })
    expect(reports[0]?.error).toContain(`repository "${repo}"`)
    expect(reports[0]?.error).toContain(`installation "${installationRoot}"`)
    expect(output).not.toContain('EROFS')
    expect(output).not.toContain('unable to write files')
  })

  test('a package staged on disk loads from disk with the installer disabled', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installation')
    await mkdir(installationRoot, { recursive: true })
    await mkdir(join(repo, 'node_modules', 'staged-plugin'), { recursive: true })
    await writeFile(
      join(repo, 'node_modules', 'staged-plugin', 'package.json'),
      JSON.stringify({ name: 'staged-plugin', type: 'module', exports: './plugin.ts' }),
    )
    await writeFile(
      join(repo, 'node_modules', 'staged-plugin', 'plugin.ts'),
      `export default { name: 'staged', apiVersion: '^1.0.0', forges: { staged: () => ({}) } }\n`,
    )
    const runner = await writeRunner(repo, ['staged-plugin'], '')
    const { exitCode, reports } = run(runner, repo, installationRoot)
    expect(exitCode).toBe(0)
    expect(reports[0]).toMatchObject({
      module: 'staged-plugin',
      status: 'loaded',
      stage: 'loaded',
      resolvedFrom: 'repository',
    })
    expect(reports[0]?.resolved).toContain(join('node_modules', 'staged-plugin'))
  })

  test('a missing repo-path specifier stays a catchable resolution failure', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installation')
    await mkdir(installationRoot, { recursive: true })
    const runner = await writeRunner(repo, ['./absent.ts'], '')
    const { exitCode, reports, output } = run(runner, repo, installationRoot)
    expect(exitCode).toBe(0)
    expect(reports[0]).toMatchObject({
      module: './absent.ts',
      status: 'failed',
      stage: 'resolution',
      resolutionKind: 'repo-path',
    })
    expect(reports[0]?.error).toContain('could not be resolved from repository')
    expect(output).not.toContain('unable to write files')
  })
})

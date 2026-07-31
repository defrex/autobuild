import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnosePlugins, loadPlugins } from './load'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-plugin-load-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  return repo
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loadPlugins', () => {
  test('an empty list performs no resolution and returns builtin reservations', async () => {
    const repo = await fixture()
    const registry = await loadPlugins([], repo)
    expect([...registry.ticketSources.keys()]).toEqual(['file', 'linear'])
  })

  test('loads a repository-relative default manifest', async () => {
    const repo = await fixture()
    await write(
      join(repo, 'repo-local.ts'),
      `export default { name: 'local', apiVersion: '^1.0.0', ticketSources: { jira: { factory: () => ({}), requiredEnv: ['JIRA_TOKEN'] } } }\n`,
    )
    const registry = await loadPlugins(['./repo-local.ts'], repo)
    expect(registry.ticketSources.get('jira')?.owner).toEqual({
      kind: 'plugin',
      name: 'local',
    })
    expect(registry.ticketSources.get('jira')?.requiredEnv).toEqual(['JIRA_TOKEN'])
  })

  test('uses separate roots for repository paths and package exports', async () => {
    const worktree = await fixture()
    const packageRoot = join(worktree, '..', 'consumer')
    await write(
      join(worktree, 'repo-local.ts'),
      `export default { name: 'local', apiVersion: '^1.0.0', forges: { local: () => ({}) } }\n`,
    )
    await write(
      join(packageRoot, 'node_modules', 'fixture-package', 'package.json'),
      JSON.stringify({ name: 'fixture-package', type: 'module', exports: './plugin.ts' }),
    )
    await write(
      join(packageRoot, 'node_modules', 'fixture-package', 'plugin.ts'),
      `export default { name: 'package', apiVersion: '^1.0.0', forges: { package: () => ({}) } }\n`,
    )

    const registry = await loadPlugins(['./repo-local.ts', 'fixture-package'], worktree, {
      packageRoot,
    })
    expect(registry.forges.get('local')?.owner).toEqual({ kind: 'plugin', name: 'local' })
    expect(registry.forges.get('package')?.owner).toEqual({ kind: 'plugin', name: 'package' })
  })

  test('resolves a package export from the consuming repository by default', async () => {
    const repo = await fixture()
    const root = join(repo, '..')
    for (const [base, pluginName] of [
      [join(root, 'node_modules', 'fixture-plugin'), 'decoy'],
      [join(repo, 'node_modules', 'fixture-plugin'), 'consumer'],
    ] as const) {
      await write(
        join(base, 'package.json'),
        JSON.stringify({ name: 'fixture-plugin', type: 'module', exports: './plugin.ts' }),
      )
      await write(
        join(base, 'plugin.ts'),
        `export default { name: '${pluginName}', apiVersion: '^1.0.0', forges: { '${pluginName}': () => ({}) } }\n`,
      )
    }

    const registry = await loadPlugins(['fixture-plugin'], repo)
    expect(registry.forges.get('consumer')?.owner).toEqual({
      kind: 'plugin',
      name: 'consumer',
    })
    expect(registry.forges.has('decoy')).toBe(false)
  })

  test('diagnosis reports ordered failures and keeps later successful registrations', async () => {
    const repo = await fixture()
    await write(join(repo, 'throws.ts'), `throw new Error('diagnostic boom')\n`)
    await write(
      join(repo, 'good.ts'),
      `export default { name: 'good', apiVersion: '^1.1.0', forges: { gitlab: () => ({}) } }\n`,
    )
    const diagnosis = await diagnosePlugins(['./missing.ts', './throws.ts', './good.ts'], repo)
    expect(diagnosis.healthy).toBe(false)
    expect(diagnosis.reports.map((report) => [report.module, report.stage])).toEqual([
      ['./missing.ts', 'resolution'],
      ['./throws.ts', 'evaluation'],
      ['./good.ts', 'loaded'],
    ])
    expect(diagnosis.registry.forges.has('gitlab')).toBe(true)
    expect(diagnosis.reports[2]).toMatchObject({
      resolutionKind: 'repo-path',
      pluginName: 'good',
      api: { hostVersion: '1.3.0', status: 'compatible' },
    })
  })

  test('names unresolved modules, evaluation failures, invalid defaults, and collisions', async () => {
    const repo = await fixture()
    const packageRoot = join(repo, '..', 'package-root')
    const diagnosis = await diagnosePlugins(['missing-plugin'], repo, { packageRoot })
    expect(diagnosis.reports[0]).toMatchObject({
      module: 'missing-plugin',
      stage: 'resolution',
      error: expect.stringContaining(`package root "${packageRoot}"`),
    })
    await expect(loadPlugins(['missing-plugin'], repo, { packageRoot })).rejects.toThrow(
      /missing-plugin.*could not be resolved/,
    )

    await write(join(repo, 'throws.ts'), `throw new Error('top-level boom')\n`)
    await expect(loadPlugins(['./throws.ts'], repo)).rejects.toThrow(
      /\.\/throws\.ts.*top-level boom/,
    )

    await write(join(repo, 'missing-default.ts'), `export const value = 1\n`)
    await expect(loadPlugins(['./missing-default.ts'], repo)).rejects.toThrow(
      /missing-default\.ts.*no default export/,
    )

    await write(
      join(repo, 'future.ts'),
      `export default { name: 'future-plugin', apiVersion: '^2.0.0' }\n`,
    )
    await expect(loadPlugins(['./future.ts'], repo)).rejects.toThrow(
      /future\.ts.*future-plugin.*\^2\.0\.0.*1\.3\.0/,
    )

    await write(
      join(repo, 'collision.ts'),
      `export default { name: 'collision', apiVersion: '^1.0.0', forges: { github: () => ({}) } }\n`,
    )
    await expect(loadPlugins(['./collision.ts'], repo)).rejects.toThrow(
      /collision\.ts.*collision.*forge.*github.*builtin/,
    )
  })

  test('a malformed registration reports which adapter and which field', async () => {
    const repo = await fixture()
    await write(
      join(repo, 'bad-descriptor.ts'),
      `export default { name: 'bad', apiVersion: '^1.0.0', ticketSources: { acme: { factory: 'nope' } }, forges: { widget: { factory: () => ({}), extra: 1 } } }\n`,
    )
    const diagnosis = await diagnosePlugins(['./bad-descriptor.ts'], repo)

    // The message a plugin author gets from `ab plugin doctor`, verbatim. The
    // ticket-source line is what `ticketSourceRegistrationSchema`'s deliberate
    // transform exists to produce; the forge line comes through the entry
    // boundary with its `unrecognized_keys` code intact.
    expect(diagnosis.reports[0]?.error).toBe(
      'plugin module "./bad-descriptor.ts" has an invalid manifest: ' +
        'ticketSources.acme.factory: must be a factory function; ' +
        'forges.widget: Unrecognized key: "extra"',
    )
  })

  test('loads an adapter whose declared name collides with an inherited object member', async () => {
    const repo = await fixture()
    // The computed key is load-bearing: `{ __proto__: fn }` in a module's
    // object literal sets the prototype and declares no adapter at all.
    await write(
      join(repo, 'proto-plugin.ts'),
      `export default { name: 'proto-plugin', apiVersion: '^1.0.0', forges: { ['__proto__']: () => ({}) } }\n`,
    )
    const diagnosis = await diagnosePlugins(['./proto-plugin.ts'], repo)
    expect(diagnosis.healthy).toBe(true)
    expect(diagnosis.reports[0]).toMatchObject({ module: './proto-plugin.ts', stage: 'loaded' })
    expect(diagnosis.registry.forges.get('__proto__')?.owner).toEqual({
      kind: 'plugin',
      name: 'proto-plugin',
    })
  })
})

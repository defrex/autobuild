import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
    expect([...registry.ticketSources.keys()]).toEqual(['file', 'hosted', 'linear'])
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

  test('falls back to the Autobuild installation for a package the repository lacks', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installed', 'node_modules', '@defrex', 'autobuild')
    await write(
      join(installationRoot, '..', 'autobuild-extension', 'package.json'),
      JSON.stringify({
        name: '@defrex/autobuild-extension',
        type: 'module',
        exports: './plugin.ts',
      }),
    )
    await write(
      join(installationRoot, '..', 'autobuild-extension', 'plugin.ts'),
      `export default { name: 'extension', apiVersion: '^1.0.0', forges: { extension: () => ({}) } }\n`,
    )

    const diagnosis = await diagnosePlugins(['@defrex/autobuild-extension'], repo, {
      installationRoot,
    })
    expect(diagnosis.healthy).toBe(true)
    expect(diagnosis.reports[0]?.resolvedFrom).toBe('installation')
    expect(diagnosis.registry.forges.get('extension')?.owner).toEqual({
      kind: 'plugin',
      name: 'extension',
    })
  })

  test('a repository copy of a package wins over the installed one', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installed', 'node_modules', '@defrex', 'autobuild')
    for (const [base, pluginName] of [
      [join(installationRoot, '..', 'autobuild-extension'), 'installed'],
      [join(repo, 'node_modules', '@defrex', 'autobuild-extension'), 'repository'],
    ] as const) {
      await write(
        join(base, 'package.json'),
        JSON.stringify({
          name: '@defrex/autobuild-extension',
          type: 'module',
          exports: './plugin.ts',
        }),
      )
      await write(
        join(base, 'plugin.ts'),
        `export default { name: '${pluginName}', apiVersion: '^1.0.0', forges: { '${pluginName}': () => ({}) } }\n`,
      )
    }

    const diagnosis = await diagnosePlugins(['@defrex/autobuild-extension'], repo, {
      installationRoot,
    })
    expect(diagnosis.reports[0]?.resolvedFrom).toBe('repository')
    expect(diagnosis.registry.forges.has('repository')).toBe(true)
    expect(diagnosis.registry.forges.has('installed')).toBe(false)
  })

  test('a missing package names both roots it was not found in', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installed', 'node_modules', '@defrex', 'autobuild')
    const diagnosis = await diagnosePlugins(['@defrex/autobuild-missing'], repo, {
      installationRoot,
    })
    expect(diagnosis.reports[0]?.status).toBe('failed')
    expect(diagnosis.reports[0]?.error).toContain(`repository "${repo}"`)
    expect(diagnosis.reports[0]?.error).toContain(`installation "${installationRoot}"`)
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
      api: { hostVersion: '1.6.0', status: 'compatible' },
    })
  })

  test('names unresolved modules, evaluation failures, invalid defaults, and collisions', async () => {
    const repo = await fixture()
    const packageRoot = join(repo, '..', 'package-root')
    const diagnosis = await diagnosePlugins(['missing-plugin'], repo, { packageRoot })
    expect(diagnosis.reports[0]).toMatchObject({
      module: 'missing-plugin',
      stage: 'resolution',
      error: expect.stringContaining(`repository "${packageRoot}"`),
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
      /future\.ts.*future-plugin.*\^2\.0\.0.*1\.6\.0/,
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

  test('a plugin re-registering a builtin workspace provider is skipped, not fatal (AUT-517)', async () => {
    const repo = await fixture()
    await write(
      join(repo, 'dup-provider.ts'),
      `export default { name: 'dup-provider', apiVersion: '^1.6.0', workspaceProviders: { 'vercel-sandbox': { factory: () => { throw new Error('never constructed') }, capabilities: {} } } }\n`,
    )
    const diagnosis = await diagnosePlugins(['./dup-provider.ts'], repo)
    expect(diagnosis.healthy).toBe(true)
    expect(diagnosis.reports[0]).toMatchObject({
      status: 'skipped',
      stage: 'registration',
      pluginName: 'dup-provider',
    })
    expect(diagnosis.reports[0]?.notice).toContain('dup-provider')
    expect(diagnosis.reports[0]?.notice).toContain('vercel-sandbox')
    // Registry unchanged: the builtin keeps serving the name through its
    // host-owned factory.
    const registration = diagnosis.registry.workspaceProviders.get('vercel-sandbox')
    expect(registration?.owner).toEqual({ kind: 'builtin', name: 'autobuild' })
    expect(typeof registration?.builtinFactory).toBe('function')
    expect(registration?.factory).toBeUndefined()
  })

  test('loadPlugins announces a skipped plugin through the notice channel and continues', async () => {
    const repo = await fixture()
    await write(
      join(repo, 'dup-provider.ts'),
      `export default { name: 'dup-provider', apiVersion: '^1.6.0', workspaceProviders: { 'vercel-sandbox': () => ({}) } }\n`,
    )
    await write(
      join(repo, 'good.ts'),
      `export default { name: 'good', apiVersion: '^1.0.0', forges: { gitlab: () => ({}) } }\n`,
    )
    const notices: string[] = []
    const registry = await loadPlugins(['./dup-provider.ts', './good.ts'], repo, {
      onNotice: (line) => notices.push(line),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('skipping it')
    expect(registry.forges.get('gitlab')?.owner).toEqual({ kind: 'plugin', name: 'good' })
  })

  test('a plugin-vs-plugin workspace-provider collision still throws', async () => {
    const repo = await fixture()
    await write(
      join(repo, 'first.ts'),
      `export default { name: 'first', apiVersion: '^1.0.0', workspaceProviders: { 'acme-sandbox': () => ({}) } }\n`,
    )
    await write(
      join(repo, 'second.ts'),
      `export default { name: 'second', apiVersion: '^1.0.0', workspaceProviders: { 'acme-sandbox': () => ({}) } }\n`,
    )
    await expect(loadPlugins(['./first.ts', './second.ts'], repo)).rejects.toThrow(
      /workspace provider adapter "acme-sandbox" from plugin "second" collides with plugin "first"/,
    )
  })

  test('a manifest mixing a builtin provider name with another colliding port still throws', async () => {
    const repo = await fixture()
    // The duplicate-skip rule is all-or-nothing: one extra colliding port
    // means the module cannot be skipped atomically, so registration throws.
    await write(
      join(repo, 'mixed.ts'),
      `export default { name: 'mixed', apiVersion: '^1.0.0', workspaceProviders: { 'vercel-sandbox': () => ({}) }, forges: { github: () => ({}) } }\n`,
    )
    await expect(loadPlugins(['./mixed.ts'], repo)).rejects.toThrow(
      /workspace provider adapter "vercel-sandbox" from plugin "mixed" collides with builtin adapter/,
    )
  })

  test('guest tolerance skips an unresolvable package specifier but stays fail-closed otherwise', async () => {
    const repo = await fixture()
    const diagnosis = await diagnosePlugins(['@defrex/autobuild-absent-provider'], repo, {
      guest: true,
    })
    expect(diagnosis.healthy).toBe(true)
    expect(diagnosis.reports[0]).toMatchObject({
      module: '@defrex/autobuild-absent-provider',
      status: 'skipped',
      stage: 'resolution',
      resolutionKind: 'package',
    })
    expect(diagnosis.reports[0]?.notice).toContain('guests never construct workspace providers')

    // loadPlugins announces the skip through the notice channel and continues.
    const loadNotices: string[] = []
    await loadPlugins(['@defrex/autobuild-absent-provider'], repo, {
      guest: true,
      onNotice: (line) => loadNotices.push(line),
    })
    expect(loadNotices).toHaveLength(1)
    expect(loadNotices[0]).toContain('@defrex/autobuild-absent-provider')
    expect(loadNotices[0]).toContain('guests never construct workspace providers')

    // Repo-path specifiers stay fail-closed in guests: a missing checkout file
    // is a real misconfiguration, not a provider the guest need not load.
    await expect(loadPlugins(['./absent-plugin.ts'], repo, { guest: true })).rejects.toThrow(
      /absent-plugin\.ts.*could not be resolved/,
    )

    // Post-resolution failures stay fail-closed in guests.
    await write(join(repo, 'guest-throws.ts'), `throw new Error('guest boom')\n`)
    await expect(loadPlugins(['./guest-throws.ts'], repo, { guest: true })).rejects.toThrow(
      /guest-throws\.ts.*guest boom/,
    )
    await write(
      join(repo, 'guest-future.ts'),
      `export default { name: 'guest-future', apiVersion: '^2.0.0' }\n`,
    )
    await expect(loadPlugins(['./guest-future.ts'], repo, { guest: true })).rejects.toThrow(
      /guest-future\.ts.*\^2\.0\.0.*1\.6\.0/,
    )
  })

  test('guest tolerance is off by default', async () => {
    const repo = await fixture()
    await expect(loadPlugins(['@defrex/autobuild-absent-provider'], repo)).rejects.toThrow(
      /could not be resolved/,
    )
  })

  describe('disk-first resolution gate (AUT-587)', () => {
    // Bun's object is mutable in-process: swapping `resolveSync` for a
    // sentinel turns "did the loader hand a bare specifier to the resolver"
    // into a portable assertion. The crash class this pins: `Bun.resolveSync`
    // of a bare specifier absent from every `node_modules` lookup fires the
    // runtime auto-installer, which exits the process fatally on a read-only
    // filesystem (the hosted dispatcher). Restored in `afterEach`.
    const originalResolveSync = Bun.resolveSync
    let sentinelCalls = 0

    beforeEach(() => {
      sentinelCalls = 0
      const sentinel = (): string => {
        sentinelCalls++
        throw new Error('sentinel: Bun.resolveSync must not run for a disk miss')
      }
      Bun.resolveSync = sentinel as typeof Bun.resolveSync
    })

    afterEach(() => {
      Bun.resolveSync = originalResolveSync
    })

    test('a package absent from disk produces the failed report without ever calling Bun.resolveSync', async () => {
      const repo = await fixture()
      // Both candidate roots exist on disk but carry no matching
      // node_modules entry — the exact state that used to reach the
      // installer.
      const installationRoot = join(repo, '..', 'installed', 'node_modules', '@defrex', 'autobuild')
      await mkdir(installationRoot, { recursive: true })
      const diagnosis = await diagnosePlugins(['@defrex/autobuild-absent'], repo, {
        installationRoot,
      })
      expect(diagnosis.healthy).toBe(false)
      expect(diagnosis.reports[0]).toMatchObject({
        module: '@defrex/autobuild-absent',
        status: 'failed',
        stage: 'resolution',
      })
      expect(diagnosis.reports[0]?.error).toContain(`repository "${repo}"`)
      expect(diagnosis.reports[0]?.error).toContain(`installation "${installationRoot}"`)
      expect(sentinelCalls).toBe(0)
    })

    test('a disk-present package reaches Bun.resolveSync exactly once, from the root the walk found', async () => {
      const repo = await fixture()
      await write(
        join(repo, 'node_modules', 'gated-package', 'package.json'),
        JSON.stringify({ name: 'gated-package', type: 'module', exports: './plugin.ts' }),
      )
      await write(
        join(repo, 'node_modules', 'gated-package', 'plugin.ts'),
        `export default { name: 'gated', apiVersion: '^1.0.0', forges: { gated: () => ({}) } }\n`,
      )
      const seenBases: string[] = []
      Bun.resolveSync = ((specifier: string, base: string): string => {
        seenBases.push(base)
        return originalResolveSync(specifier, base)
      }) as typeof Bun.resolveSync
      const diagnosis = await diagnosePlugins(['gated-package'], repo)
      expect(diagnosis.healthy).toBe(true)
      expect(diagnosis.reports[0]?.status).toBe('loaded')
      expect(seenBases).toEqual([repo])
    })

    test('a subpath export of a disk-present package resolves without failing the gate', async () => {
      const repo = await fixture()
      await write(
        join(repo, 'node_modules', 'subpath-package', 'package.json'),
        JSON.stringify({
          name: 'subpath-package',
          type: 'module',
          exports: { './plugin': './plugin.ts' },
        }),
      )
      await write(
        join(repo, 'node_modules', 'subpath-package', 'plugin.ts'),
        `export default { name: 'subpath', apiVersion: '^1.0.0', forges: { subpath: () => ({}) } }\n`,
      )
      Bun.resolveSync = originalResolveSync
      const diagnosis = await diagnosePlugins(['subpath-package/plugin'], repo)
      expect(diagnosis.healthy).toBe(true)
      expect(diagnosis.reports[0]?.status).toBe('loaded')
    })
  })

  test('a package absent from every existing candidate root fails with the same report shape (no stub)', async () => {
    const repo = await fixture()
    const installationRoot = join(repo, '..', 'installed', 'node_modules', '@defrex', 'autobuild')
    await mkdir(installationRoot, { recursive: true })
    const diagnosis = await diagnosePlugins(['totally-absent-package'], repo, {
      installationRoot,
    })
    expect(diagnosis.healthy).toBe(false)
    expect(diagnosis.reports[0]).toMatchObject({
      module: 'totally-absent-package',
      status: 'failed',
      stage: 'resolution',
      resolutionKind: 'package',
    })
    expect(diagnosis.reports[0]?.error).toContain(
      `could not be resolved from repository "${repo}" or installation "${installationRoot}"`,
    )
    await expect(
      loadPlugins(['totally-absent-package'], repo, { installationRoot }),
    ).rejects.toThrow(/totally-absent-package.*could not be resolved/)
  })
})

import { expect, test } from 'bun:test'
import {
  consumeGenerationMarker,
  DISPATCH_GENERATION_ENV,
  DISPATCH_LAUNCH_VERSION,
  GENERATION_ENTRY,
  GENERATION_EXITS,
  GENERATION_SIGNALS,
  generationArguments,
  generationResult,
} from './dispatch-launch-contract'

test('launcher ABI v1 literal compatibility fixture', () => {
  expect({
    version: DISPATCH_LAUNCH_VERSION,
    marker: DISPATCH_GENERATION_ENV,
    entry: GENERATION_ENTRY,
    exits: GENERATION_EXITS,
    signals: GENERATION_SIGNALS,
    argv: generationArguments('/cache/core', ['dispatch', '--plain']),
  }).toEqual({
    version: 1,
    marker: 'AB_DISPATCH_GENERATION',
    entry: 'bin/ab-dispatch-generation.ts',
    exits: { stopped: 80, handoff: 81, failed: 82 },
    signals: ['SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGTERM'],
    argv: [
      '--no-install',
      '--tsconfig-override',
      '/cache/core/tsconfig.json',
      '/cache/core/bin/ab-dispatch-generation.ts',
      'dispatch',
      '--plain',
    ],
  })
  const env = {
    AB_DISPATCH_GENERATION: JSON.stringify({
      version: 1,
      runtimeRoot: '/cache/core',
      checkout: '/repo',
    }),
  }
  expect(consumeGenerationMarker(env, '/cache/core')).toEqual({
    version: 1,
    runtimeRoot: '/cache/core',
    checkout: '/repo',
  })
  expect(env.AB_DISPATCH_GENERATION).toBeUndefined()
  for (const raw of [
    undefined,
    '{}',
    'bad',
    JSON.stringify({ version: 2, runtimeRoot: '/cache/core', checkout: '/repo' }),
    JSON.stringify({ version: 1, runtimeRoot: '/other', checkout: '/repo' }),
  ]) {
    const invalid = { AB_DISPATCH_GENERATION: raw }
    expect(() => consumeGenerationMarker(invalid, '/cache/core')).toThrow()
    expect(invalid.AB_DISPATCH_GENERATION).toBeUndefined()
  }
  expect(generationResult(80, null)).toEqual({ reason: 'stopped', publicCode: 0 })
  expect(generationResult(81, null)).toEqual({ reason: 'handoff', publicCode: 1 })
  for (const code of [0, 82, 255]) expect(generationResult(code, null).reason).toBe('failed')
  expect(generationResult(80, 'SIGKILL').reason).toBe('failed')
})

test('launcher transitive graph is eagerly loaded filesystem/process code', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolve, dirname } = await import('node:path')
  const visited = new Set<string>()
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const source = transpiler.transformSync(await readFile(file, 'utf8'))
    expect(source, file).not.toMatch(/\bimport\s*\(/)
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const path = resolve(dirname(file), `${match[1]}.ts`)
      expect(path).not.toMatch(/\/(store|kernel|plugins|ports)\//)
      await visit(path)
    }
  }
  await visit(resolve(import.meta.dir, 'dispatch-launcher.ts'))
  expect(visited.size).toBeGreaterThan(5)
})

test('optional frozen source launch metadata is validated and preserved in ABI v1', () => {
  const sourceLaunch = {
    repository: '/repo/.git',
    commit: 'a'.repeat(40),
    baseline: 'b'.repeat(64),
  }
  const marker = { version: 1, runtimeRoot: '/runtime', checkout: '/repo', sourceLaunch }
  expect(
    consumeGenerationMarker({ AB_DISPATCH_GENERATION: JSON.stringify(marker) }, '/runtime')
      .sourceLaunch,
  ).toEqual(sourceLaunch)
  for (const invalid of [
    null,
    {},
    { ...sourceLaunch, commit: 'main' },
    { ...sourceLaunch, baseline: '' },
    { ...sourceLaunch, repository: 'relative' },
  ])
    expect(() =>
      consumeGenerationMarker(
        { AB_DISPATCH_GENERATION: JSON.stringify({ ...marker, sourceLaunch: invalid }) },
        '/runtime',
      ),
    ).toThrow()
})

test('rollback capability is independent of v1 and validates owned cache paths and lineage', async () => {
  const { validRecoveryContext } = await import('./dispatch-launch-contract')
  const a = `1.0.0-${'a'.repeat(64)}`,
    b = `2.0.0-${'b'.repeat(64)}`
  const root = (id: string) => `/repo/.autobuild/runtime/${id}/distribution`
  const rollback = {
    version: 1 as const,
    correlation: 'rollback',
    lineage: 'launcher',
    predecessor: 'a',
    successor: 'b',
    handoff: 'h',
    takeoverAt: '2026-01-01T00:00:00.000Z',
    failures: 3 as const,
    failed: { root: root(b), cacheId: b },
    restored: { root: root(a), cacheId: a },
  }
  const launch = {
    version: 1 as const,
    runtimeRoot: root(a),
    checkout: '/repo',
    run: 'restored',
    lineage: 'launcher',
    rollbackVersion: 1 as const,
    rollback,
  }
  expect(
    consumeGenerationMarker({ AB_DISPATCH_GENERATION: JSON.stringify(launch) }, root(a)).rollback,
  ).toEqual(rollback)
  for (const changed of [
    { lineage: 'other' },
    { runtimeRoot: root(b) },
    { predecessor: 'a' },
    { rollbackVersion: undefined },
    { rollback: { ...rollback, restored: { root: '/foreign/distribution', cacheId: a } } },
    { rollback: { ...rollback, failed: { root: root(a), cacheId: a } } },
    { rollback: { ...rollback, takeoverAt: 'invalid' } },
    { rollback: { ...rollback, failures: 2 } },
    { rollback: null },
  ])
    expect(validRecoveryContext({ ...launch, ...changed } as typeof launch)).toBe(false)
})

test('conditional reader negotiates independently and consumes its one-shot environment', async () => {
  const { consumeUpgradeCondition, DISPATCH_CONDITIONAL_ENV, conditionalUpgradeClient } =
    await import('./dispatch-launch-contract')
  const env = { [DISPATCH_CONDITIONAL_ENV]: JSON.stringify({ version: 1, identity: 'reader' }) }
  expect(consumeUpgradeCondition(env)).toEqual({ version: 1, identity: 'reader' })
  expect(env[DISPATCH_CONDITIONAL_ENV]).toBeUndefined()
  for (const value of [
    null,
    { version: 2 },
    { version: 1, identity: 'r', position: 0 },
    { version: 1, identity: 'r', position: '0' },
  ]) {
    expect(() =>
      consumeUpgradeCondition({ [DISPATCH_CONDITIONAL_ENV]: JSON.stringify(value) }),
    ).toThrow()
  }
  // Old runtime ignores the request; no unsupported-capability retry is needed.
  const client = conditionalUpgradeClient()
  for (let i = 0; i < 3; i++)
    expect(
      await client('old', async (request) => {
        expect(request.position).toBeUndefined()
        return { version: 1, handoff: null, takeover: false }
      }),
    ).toEqual({ version: 1, handoff: null, takeover: false })
})

test('conditional cache validates positions, identities, errors and malformed replies', async () => {
  const { conditionalUpgradeClient } = await import('./dispatch-launch-contract')
  const guards = { handoff: null, rollbackRecorded: false, failedRoot: null }
  const client = conditionalUpgradeClient()
  for (const position of ['0', '90071992547409931234567890']) {
    await client('a', async () => ({
      conditionalVersion: 1,
      identity: 'a',
      kind: 'full',
      position,
      guards,
      projection: { version: 1, handoff: null, takeover: true },
    }))
    expect(
      (
        await client('a', async (request) => {
          expect(request.position).toBe(position)
          return {
            conditionalVersion: 1,
            identity: 'a',
            kind: 'unchanged',
            position,
            handoff: null,
            rollbackRetained: false,
          }
        })
      ).takeover,
    ).toBe(true)
  }
  await expect(client('a', async () => ({ conditionalVersion: 2 }))).rejects.toThrow()
  await expect(
    client('a', async (request) => {
      expect(request.position).toBeUndefined()
      throw new Error('offline')
    }),
  ).rejects.toThrow('offline')
  await client('b', async (request) => {
    expect(request.position).toBeUndefined()
    return { version: 1, handoff: null, takeover: false }
  })
  await expect(
    client('b', async () => ({
      conditionalVersion: 1,
      identity: 'b',
      kind: 'unchanged',
      position: '0',
      handoff: null,
      rollbackRetained: false,
    })),
  ).rejects.toThrow()
})

test('older launcher accepts runtime-owned handoff extensions in legacy, full and unchanged replies', async () => {
  const { conditionalUpgradeClient } = await import('./dispatch-launch-contract')
  const owned = {
    root: '/runtime',
    cacheId: 'cache',
    run: 'run',
    lineage: 'lineage',
    correlation: 'handoff',
  }
  // A future runtime may add modes, source kinds, or omit descriptors entirely.
  for (const handoff of [
    owned,
    {
      ...owned,
      target: { mode: 'branch' },
      from: { source: { kind: 'future-source' } },
      to: { source: { kind: 'future-source' } },
      future: { revision: 2 },
    },
  ]) {
    const projection = { version: 1, handoff, takeover: false }
    const client = conditionalUpgradeClient()
    expect<unknown>(await client('reader', async () => projection)).toEqual(projection)
    expect<unknown>(
      await client('reader', async () => ({
        conditionalVersion: 1,
        identity: 'reader',
        kind: 'full',
        position: '1',
        guards: { handoff, rollbackRecorded: false, failedRoot: null },
        projection,
      })),
    ).toEqual(projection)
    const updated = {
      ...handoff,
      target: { mode: 'another-future-mode' },
      future: true,
    }
    expect<unknown>(
      (
        await client('reader', async (request) => {
          expect(request.position).toBe('1')
          return {
            conditionalVersion: 1,
            identity: 'reader',
            kind: 'unchanged',
            position: '1',
            handoff: updated,
            rollbackRetained: false,
          }
        })
      ).handoff,
    ).toEqual(updated)
    // Opaque changes are safe; changing the launcher's actual destination is not.
    await expect(
      client('reader', async () => ({
        conditionalVersion: 1,
        identity: 'reader',
        kind: 'unchanged',
        position: '1',
        handoff: { ...updated, root: '/different' },
        rollbackRetained: false,
      })),
    ).rejects.toThrow('invalid unchanged upgrade response')
  }
})

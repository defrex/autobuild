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

import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readBoundaries, checkReadBoundaries, type ReadException } from './persisted-reduced-reads'
import exceptions from './persisted-reduced-read-exceptions.json'

test('production current reductions use persisted reads; every exception has a live function identity and reason', async () => {
  const boundaries = []
  for (const root of ['bin', 'packages']) {
    for await (const file of new Glob('**/*.{ts,tsx}').scan(root)) {
      if (
        /\.test\.|\/(?:__fixtures__|fixtures|generators)\//.test(`/${file}`) ||
        /(?:^|\/)(testing|scenarios)\//.test(file) ||
        file.endsWith('/store/contract.ts')
      )
        continue
      const path = `${root}/${file}`
      boundaries.push(...readBoundaries(path, await Bun.file(path).text()))
    }
  }
  expect(checkReadBoundaries(boundaries, exceptions as Record<string, ReadException>)).toEqual([])
  // Full-tree TypeScript parsing exceeded 5s alongside unit/build/integration
  // in the 4-vCPU sandbox (1.90s focused); keep the complete source audit.
}, 15_000)

for (const [label, source] of Object.entries({
  alias: `import { reduceBuild as project } from './kernel/reducer'; export async function view(store) { const rows = await store.getEvents('b'); return project(rows) }`,
  intermediate: `import { buildReducer as reducer } from './kernel/reducer'; export async function view(store) {const rows = await store.getEvents('b'); const copy = rows; const fold = reducer.reduce; return fold(copy)}`,
  selector: `export async function view(store) { const raw = await store.getRepoEvents('r'); const rows = raw; return rows.filter(event => event.type === 'harvest.failed').at(-1) }`,
  bound: `export async function view(store) { const read = store.getEvents.bind(store); return (await read('b')).find(event => event.type === 'build.created') }`,
}))
  test(`a new production file cannot introduce a ${label} replay or raw selector`, () => {
    expect(checkReadBoundaries(readBoundaries('packages/new/surface.ts', source), {})).not.toEqual(
      [],
    )
  })

test('reasoned cursor event output and pure reference folds are admitted; exceptions cannot go stale', () => {
  const source = `import { reduceBuild as project } from './kernel/reducer'; export function oracle(events) {return project(events)}; export async function events(store, cursor) { return store.getEvents('b',cursor) }`
  const boundaries = readBoundaries('surface.ts', source)
  const allowed: Record<string, ReadException> = {
    'surface.ts::oracle::project': { kind: 'reduction', reason: 'Pure reference oracle.' },
    'surface.ts::events::getEvents': {
      kind: 'raw',
      cursor: true,
      reason: 'Actual cursor event output.',
    },
  }
  // Imported aliases are canonical in both detection and the exception key.
  delete allowed['surface.ts::oracle::project']
  allowed['surface.ts::oracle::reduceBuild'] = {
    kind: 'reduction',
    reason: 'Pure reference oracle.',
  }
  expect(checkReadBoundaries(boundaries, allowed)).toEqual([])
  expect(
    checkReadBoundaries(boundaries, {
      ...allowed,
      'gone::reader::reduceBuild': { kind: 'reduction', reason: 'No longer exists.' },
    }).join('\n'),
  ).toContain('stale')
  expect(
    checkReadBoundaries(
      readBoundaries(
        'surface.ts',
        source.replace("store.getEvents('b',cursor)", "store.getEvents('b')"),
      ),
      allowed,
    ).join('\n'),
  ).toContain('persisted')
})

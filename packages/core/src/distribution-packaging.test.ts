import { expect, test } from 'bun:test'
import { parsePackDryRun } from './distribution-packaging'

const listing = (lines: string[], total = lines.length) =>
  [
    'bun pack v1.4.5 (a7733435c)',
    '',
    ...lines.map((line) => `packed 2B ${line}`),
    '',
    'fixture-1.0.0.tgz',
    '',
    `Total files: ${total}`,
    'Unpacked size: 11.34KB',
    '',
  ].join('\n')

test('dry-run listing parses real Bun output', () => {
  const output = listing(['package.json', 'src/a b.ts', 'src/n/[c].js']).replace(
    'packed 2B src/a b.ts',
    'packed 11.34KB src/a b.ts',
  )
  expect(parsePackDryRun(output)).toEqual(['package.json', 'src/a b.ts', 'src/n/[c].js'])
})

test('dry-run listing fails closed on anything it cannot prove complete', () => {
  const invalid = [
    listing(['package.json', 'src/a'], 3),
    listing(['package.json', 'src/a']).replace(/Total files.*\n/, ''),
    listing(['package.json', 'src/a', 'src/a']),
    listing(['package.json', '/etc/passwd']),
    listing(['package.json', 'src/../a']),
    listing(['package.json', 'src//a']),
    listing(['package.json', './a']),
    listing([]),
    listing(['src/a']),
    listing(['package.json']).replace('Unpacked size', 'Shasum'),
    `\u001b[1mbun pack\u001b[0m\n${listing(['package.json']).split('\n').slice(1).join('\n')}`,
  ]
  for (const output of invalid) expect(parsePackDryRun(output)).toBeUndefined()
})

import { describe, expect, test } from 'bun:test'
import { classifyGenerated, generatedSelectors } from './generated-files'

describe('classifyGenerated', () => {
  const declarations = [
    { paths: ['docs/baseline/**'], command: 'bun run docs:baseline' },
    { paths: ['shapes.json', 'docs/baseline/special.md'], command: 'bun tools/shapes.ts' },
  ]

  test('groups owned files by the first matching entry in declaration order', () => {
    expect(
      classifyGenerated(
        ['shapes.json', 'docs/baseline/a/b.md', 'docs/baseline/special.md', 'src/a.ts'],
        declarations,
      ),
    ).toEqual({
      groups: [
        {
          command: 'bun run docs:baseline',
          files: ['docs/baseline/a/b.md', 'docs/baseline/special.md'],
        },
        { command: 'bun tools/shapes.ts', files: ['shapes.json'] },
      ],
      other: ['src/a.ts'],
    })
  })

  test('omits entries that own no conflicted file', () => {
    expect(classifyGenerated(['shapes.json'], declarations)).toEqual({
      groups: [{ command: 'bun tools/shapes.ts', files: ['shapes.json'] }],
      other: [],
    })
  })

  test('no declarations leave every file to the agent', () => {
    expect(classifyGenerated(['shapes.json', 'src/a.ts'], [])).toEqual({
      groups: [],
      other: ['shapes.json', 'src/a.ts'],
    })
  })

  test('lists each selector once', () => {
    expect(generatedSelectors([...declarations, { paths: ['shapes.json'], command: 'x' }])).toEqual(
      ['docs/baseline/**', 'shapes.json', 'docs/baseline/special.md'],
    )
  })
})

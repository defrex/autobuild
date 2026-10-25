import { expect, test } from 'bun:test'
import { checkWriterFixture, writerFixture } from './writer-fixtures'
import { catalog } from './fixture-core'

test('writer actor policy and classifications cover the complete producer vocabulary', async () => {
  await checkWriterFixture()
  const fixture = writerFixture()
  const vocabulary = catalog()
  for (const scope of ['build', 'repository', 'session'] as const) {
    expect(Object.keys(fixture.actors[scope]).sort()).toEqual(vocabulary[scope]!)
  }
  for (const scope of ['build', 'repository'] as const) {
    expect(Object.keys(fixture.classification[scope]).sort()).toEqual(vocabulary[scope]!)
  }
})

import { expect, test } from 'bun:test'
import { checkControlCorpus, controlScenarios } from './control-fixtures'

test('native control oracle covers every control over active, pending and terminal states', async () => {
  const corpus = await checkControlCorpus()
  expect(corpus.fixtures.length).toBe(controlScenarios().length)
  for (const action of ['pause', 'cancel-pause', 'resume', 'abort', 'discard', 'land', 'hold']) {
    expect(corpus.fixtures.some((fixture) => fixture.scenario.id === `${action}-running`)).toBe(
      true,
    )
    expect(corpus.fixtures.some((fixture) => fixture.scenario.id === `${action}-done`)).toBe(true)
  }
  for (const fixture of corpus.fixtures) {
    if (fixture.status >= 400) {
      expect(fixture.after.events).toEqual(fixture.seed.events)
      expect(fixture.after.repository).toEqual(fixture.seed.repository)
    }
  }
})

import { expect, test } from 'bun:test'
import {
  artifactPreparationFixtures,
  checkArtifactPreparationFixtures,
} from './protocol-artifact-preparation-fixtures'

test('artifact decoding and payload placeholder oracle fixtures remain fresh', () => {
  checkArtifactPreparationFixtures()
  const fixtures = artifactPreparationFixtures()
  expect(fixtures.decode.length).toBeGreaterThan(280)
  expect(fixtures.substitution.length).toBeGreaterThan(60)
})

import { expect, test } from 'bun:test'

test('launcher reader preserves helper incompatibility through active and predecessor failure streaks', async () => {
  const { generationReaderResult, generationReaderFailures } = await import('./dispatch-launcher')
  const messages: string[] = []
  const streak = generationReaderFailures((message) => messages.push(message))
  const diagnostic =
    'incompatible reducer dispatchUpgrade: client version 1, server version 2; reducer version mismatch'
  const failed = (role: 'active' | 'predecessor') => {
    try {
      generationReaderResult(1, '', `${role}: ${diagnostic}`)
    } catch (error) {
      streak.report(role, error)
    }
  }
  // No predecessor: one diagnostic despite repeated probes.
  failed('active')
  failed('active')
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain(diagnostic)
  // Failed predecessor retains the original diagnostic and adds its own once.
  failed('predecessor')
  failed('active')
  failed('predecessor')
  expect(messages).toHaveLength(2)
  expect(messages[1]).toContain(`predecessor: ${diagnostic}`)
  expect(generationReaderResult(0, '{"version":1}', '')).toEqual({ version: 1 })
  streak.clear()
  failed('active')
  expect(messages).toHaveLength(3)
})

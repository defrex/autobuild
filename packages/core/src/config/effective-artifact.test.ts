import { expect, test } from 'bun:test'
import { normalizeEffectiveConfigArtifact } from './effective-artifact'
import { historicalEffectiveConfig } from './effective-artifact.fixture'
import { configSchema } from './schema'

for (const enabled of [false, true]) {
  test(`historical effective config retains sandbox settings, enabled=${enabled}`, () => {
    const input = historicalEffectiveConfig(enabled)
    const before = JSON.stringify(input)
    const parsed = configSchema.parse(normalizeEffectiveConfigArtifact(input))
    expect(parsed.orchestrator).toEqual({
      enabled,
      sandbox: {
        idleMinutes: 7,
        environmentVariables: ['CUSTOM_TOOL'],
      },
    })
    expect(JSON.stringify(input)).toBe(before)
  })
}
test('compatibility does not hide unknown keys or malformed retained values', () => {
  for (const extra of [{ typo: true }, { sandbox: { idleMinutes: 0 } }, { enabled: 'true' }]) {
    const input = historicalEffectiveConfig(true)
    Object.assign(input.orchestrator as object, extra)
    expect(configSchema.safeParse(normalizeEffectiveConfigArtifact(input)).success).toBe(false)
  }
})

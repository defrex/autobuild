import { expect, test } from 'bun:test'
import { normalizeEffectiveConfigArtifact } from './effective-artifact'
import { historicalEffectiveConfig } from './effective-artifact.fixture'
import { configSchema } from './schema'
import { parseConfig } from './load'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'

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

test('a deposited effective config tells an absent enabled apart from an explicit false', () => {
  const ready = '[tickets]\nsource = "file"\nreadyState = "ready"\n'
  const absent = JSON.parse(effectiveBuildConfigContent(parseConfig(ready)))
  expect(Object.hasOwn(absent.orchestrator, 'enabled')).toBe(false)
  expect(configSchema.parse(absent).orchestrator.enabled).toBeUndefined()
  const explicit = JSON.parse(
    effectiveBuildConfigContent(parseConfig(`${ready}[orchestrator]\nenabled = false\n`)),
  )
  expect(explicit.orchestrator.enabled).toBe(false)
  expect(configSchema.parse(explicit).orchestrator.enabled).toBe(false)
})

import { expect, test } from 'bun:test'
import { checkUpgradeCompatibility } from './upgrade-compatibility'

const health = {
  ok: true,
  autobuildVersion: '0.11.0',
  protocolVersion: '3',
  supportedClientRange: { minVersion: '0.9.0', maxVersionExclusive: '0.12.0' },
}
for (const [version, expected] of [
  ['0.11.999', undefined],
  ['0.12.0', 'upgrade the service to at least 0.12.0'],
  ['0.8.0', "upgrade the project's Autobuild"],
] as const) {
  test(`advisory probe for ${version} has correct direction and no credentials`, async () => {
    const warnings: string[] = []
    await checkUpgradeCompatibility({
      targetRepo: '/other/project',
      version,
      env: { AB_STORE: 'https://user:password@service.test/base?token=secret' },
      stderr: (line) => warnings.push(line),
      fetch: async (url, init) => {
        expect(url).toBe('https://service.test/base/health')
        expect(init.headers).toBeUndefined()
        return Response.json(health)
      },
    })
    if (expected) expect(warnings.join()).toContain(expected)
    else expect(warnings).toEqual([])
    expect(warnings.join()).not.toContain('password')
    expect(warnings.join()).not.toContain('secret')
  })
}

test('local stores make no probe; legacy health preserves exact-match contract', async () => {
  const warnings: string[] = []
  let probes = 0
  const options = {
    targetRepo: '/target',
    version: '0.11.0',
    stderr: (line: string) => warnings.push(line),
    fetch: async () => {
      probes++
      return Response.json({ autobuildVersion: '0.10.1' })
    },
  }
  await checkUpgradeCompatibility({ ...options, env: { AB_STORE: './local' } })
  expect(probes).toBe(0)
  await checkUpgradeCompatibility({ ...options, env: { AB_STORE: 'https://service.test' } })
  expect(warnings.join()).toContain('exact client version')
  expect(warnings.join()).toContain('compatibility-window release')
})

for (const failure of ['timeout', 'network', 'status', 'json', 'metadata', 'version']) {
  test(`${failure} probe warns and continues`, async () => {
    const warnings: string[] = []
    await checkUpgradeCompatibility({
      targetRepo: '/target',
      version: '0.12.0',
      env: { AB_STORE: 'https://service.test' },
      timeoutMs: 5,
      stderr: (line) => warnings.push(line),
      fetch: async () => {
        if (failure === 'timeout') return new Promise<Response>(() => {})
        if (failure === 'network') throw new Error('secret URL never printed')
        if (failure === 'status') return new Response('', { status: 500 })
        if (failure === 'json') return new Response('{')
        if (failure === 'version') return Response.json({ ...health, autobuildVersion: 'bad' })
        return Response.json({
          ...health,
          supportedClientRange: { minVersion: '0.9', maxVersionExclusive: 'bad' },
        })
      },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not be verified')
    expect(warnings[0]).toContain('may fail to connect')
  })
}

test('unreadable distribution identity remains advisory and local upgrades need no metadata', async () => {
  const warnings: string[] = []
  const options = {
    targetRepo: '/target',
    distRoot: '/missing-autobuild-distribution',
    stderr: (line: string) => warnings.push(line),
    fetch: async () => {
      throw new Error('unexpected probe')
    },
  }
  await checkUpgradeCompatibility({ ...options, env: {} })
  expect(warnings).toEqual([])
  await checkUpgradeCompatibility({ ...options, env: { AB_STORE: 'https://service.test' } })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('could not be verified')
})

for (const [version, expected] of [
  ['1.0.0-beta.0', undefined],
  ['1.0.0', undefined],
  ['0.14.0', "upgrade the project's Autobuild"],
  ['1.1.0-beta.0', 'service first'],
] as const) {
  test(`beta service upgrade probe classifies ${version}`, async () => {
    const warnings: string[] = []
    await checkUpgradeCompatibility({
      targetRepo: '/target',
      version,
      env: { AB_STORE: 'https://service.test' },
      stderr: (line) => warnings.push(line),
      fetch: async () =>
        Response.json({
          autobuildVersion: '1.0.0-beta.1',
          supportedClientRange: { minVersion: '1.0.0', maxVersionExclusive: '1.1.0' },
        }),
    })
    if (expected) expect(warnings.join()).toContain(expected)
    else expect(warnings).toEqual([])
    expect(warnings.join()).not.toContain('could not be verified')
  })
}

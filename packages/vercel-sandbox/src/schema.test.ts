/**
 * Schema tests migrated from core's `config/config.test.ts` (AUT-505): after
 * the builtin's removal the core parser validates nothing for the
 * `vercel-sandbox` name at parse time, so the same inputs and expectations are
 * driven against the moved `vercelSandboxConfigSchema` directly here.
 */
import { describe, expect, test } from 'bun:test'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { vercelSandboxConfigSchema } from './schema'

function parseConfig(tableToml: string) {
  return vercelSandboxConfigSchema.parse(parseToml(tableToml))
}

function parseError(tableToml: string): Error {
  try {
    parseConfig(tableToml)
  } catch (error) {
    return error as Error
  }
  throw new Error('expected vercelSandboxConfigSchema.parse to throw')
}

describe('vercelSandboxConfigSchema', () => {
  test('accepts only universal managed-image names, tags, and digests', () => {
    for (const image of [
      'vercel/sandbox/universal',
      'vercel/sandbox/universal:latest',
      'vercel/sandbox/universal:2025-03-03',
      `vercel/sandbox/universal@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(parseConfig(`timeoutSeconds = 600\nimage = "${image}"`).image).toBe(image)
    }

    for (const image of [
      'vercel/sandbox/node:latest',
      'vercel/sandbox/python:latest',
      'vercel/sandbox/ubuntu:latest',
      'acme/project/custom:latest',
      'vcr.vercel.com/acme/project/custom:latest',
    ]) {
      const error = parseError(`timeoutSeconds = 600\nimage = "${image}"`)
      expect(error.message).toContain('image')
      expect(error.message).toContain('Bun provisioning is validated only')
    }

    for (const digest of [`A${'a'.repeat(63)}`, 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
      const image = `vercel/sandbox/universal@sha256:${digest}`
      const error = parseError(`timeoutSeconds = 600\nimage = "${image}"`)
      expect(error.message).toContain('image')
      expect(error.message).toContain('64 lowercase hexadecimal characters')
    }
  })

  test('provisioning is ordered, strict, named, and declarative', () => {
    const config = parseConfig(`timeoutSeconds = 600
provisioning = [
  { name = "browser packages", command = """apt-get update
apt-get install -y chromium""" },
  { name = "browser smoke", command = "CHROMIUM_BIN=/usr/bin/chromium ./scripts/browser-smoke.sh" },
]`)
    expect(config.provisioning).toEqual([
      { name: 'browser packages', command: 'apt-get update\napt-get install -y chromium' },
      {
        name: 'browser smoke',
        command: 'CHROMIUM_BIN=/usr/bin/chromium ./scripts/browser-smoke.sh',
      },
    ])
    expect(parseConfig('timeoutSeconds = 600').provisioning).toEqual([])

    for (const declaration of [
      'provisioning = [{ name = "", command = "ok" }]',
      'provisioning = [{ name = "blank", command = "   " }]',
      'provisioning = [{ name = "same", command = "one" }, { name = "same", command = "two" }]',
      'provisioning = [{ name = "step", command = "ok", unknown = true }]',
    ]) {
      const error = parseError(`timeoutSeconds = 600\n${declaration}`)
      expect(error.message).toContain('provisioning')
    }
  })

  test('config is strict, bounded, and references secrets by name', () => {
    const config = parseConfig(`timeoutSeconds = 2700
operationTimeoutMs = 30000
vcpus = 8
image = "vercel/sandbox/universal:latest"
region = "iad1"
failoverRegions = ["sfo1"]
environmentVariables = ["ANTHROPIC_API_KEY"]
gitUsernameEnv = "AB_GIT_READ_USER"
gitPasswordEnv = "AB_GIT_READ_TOKEN"`)
    expect(config.timeoutSeconds).toBe(2700)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.snapshotExpirationSeconds).toBeUndefined()
    expect(
      parseConfig('timeoutSeconds = 2700\nsnapshotExpirationSeconds = 86400')
        .snapshotExpirationSeconds,
    ).toBe(86_400)

    for (const table of [
      'timeoutSeconds = 59',
      'timeoutSeconds = 86401',
      'timeoutSeconds = 600\noperationTimeoutMs = 999',
      'timeoutSeconds = 600\noperationTimeoutMs = 300001',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = 299',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = 2592001',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = 86400.5',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = 0',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = -1',
      'timeoutSeconds = 600\nsnapshotExpirationSeconds = 86400\nunknown = true',
      'timeoutSeconds = 600\nunknown = true',
      'timeoutSeconds = 600\nenvironmentVariables = ["TOKEN", "TOKEN"]',
      'timeoutSeconds = 600\ngitPasswordEnv = "AB_GIT_READ_TOKEN"',
      'timeoutSeconds = 600\ngitUsernameEnv = "x"\ngitPasswordEnv = "GITHUB_TOKEN"',
    ]) {
      expect(() => parseConfig(table)).toThrow()
    }
  })

  test('runtime provisioning is open by runtime name, strict by entry, and covers every effective route', () => {
    const config = parseConfig(`timeoutSeconds = 600
[runtimeProvisioning.pi]
install = "npm install -g pi@1.2.3"
preflight = "pi --version"
[runtimeProvisioning."plugin.runtime"]
install = "install-plugin@abc123"
preflight = "plugin-runtime --version"`)
    expect(Object.keys(config.runtimeProvisioning)).toEqual(['pi', 'plugin.runtime'])

    for (const entry of [
      'install = ""\npreflight = "pi --version"',
      'install = "npm install pi@1"',
      'install = "npm install pi@1"\npreflight = "pi --version"\nunknown = true',
    ]) {
      const error = parseError(
        `timeoutSeconds = 600
[runtimeProvisioning.pi]
${entry}`,
      )
      expect(error.message).toContain('runtimeProvisioning')
    }
  })

  test('every supported TOML key shape round-trips through the schema map', () => {
    const cases = [
      ['pi', 'pi'],
      ['plugin.runtime', '"plugin.runtime"'],
      ['plugin"runtime', '"plugin\\"runtime"'],
      ['plugin\\runtime', '"plugin\\\\runtime"'],
      ['plugin\u0001runtime', '"plugin\\u0001runtime"'],
      ['plugin\u007fruntime', '"plugin\\u007Fruntime"'],
      ['插件', '"\\u63D2\\u4EF6"'],
      ['plugin😀', '"plugin\\U0001F600"'],
    ] as const

    for (const [runtime] of cases) {
      const source = stringifyToml({
        timeoutSeconds: 600,
        runtimeProvisioning: { [runtime]: { install: 'install', preflight: 'check' } },
      })
      const parsed = vercelSandboxConfigSchema.parse(parseToml(source))
      expect(Object.keys(parsed.runtimeProvisioning)).toEqual([runtime])
      expect(parsed.runtimeProvisioning[runtime]).toEqual({
        install: 'install',
        preflight: 'check',
      })
    }
  })
})

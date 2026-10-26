import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDeploymentFixture } from './hosted-service-packaging.test-fixture'
import { expect, test } from 'bun:test'
import { checkDeploymentTemplates } from './hosted-service-packaging'
import { replaceHostedServicePins, replacePackageVersion } from './release'

test('deployment templates have matching released pins', async () => {
  await checkDeploymentTemplates()
})
test('releases bump exact deployment pins without changing source peer floors', () => {
  const template = replaceHostedServicePins(
    JSON.stringify({
      dependencies: {
        '@defrex/autobuild': '0.11.0',
        '@defrex/autobuild-hosted-store-service': '0.11.0',
        next: '16.1.6',
      },
    }),
    '0.12.0',
  )
  expect(JSON.parse(template).dependencies).toEqual({
    '@defrex/autobuild': '0.12.0',
    '@defrex/autobuild-hosted-store-service': '0.12.0',
    next: '16.1.6',
  })
  const service = {
    version: '0.11.0',
    peerDependencies: { '@defrex/autobuild': '>=0.11.0' },
  }
  expect(JSON.parse(replacePackageVersion(JSON.stringify(service, null, 2), '0.12.0'))).toEqual({
    ...service,
    version: '0.12.0',
  })
})

test('deployment pin policy retains lower stable pins only for prerelease roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deployment-pins-'))
  try {
    for (const [version, pin, servicePin, valid] of [
      ['1.0.0', '1.0.0', '1.0.0', true],
      ['1.0.0', '0.9.0', '0.9.0', false],
      ['1.0.0-beta.0', '0.9.0', '0.9.0', true],
      ['1.0.0-rc.2', '0.9.0', '0.9.0', true],
      ['1.0.0-beta.0', '1.0.0', '1.0.0', false],
      ['1.0.0-beta.0', '2.0.0', '2.0.0', false],
      ['1.0.0-beta.0', '0.9.0-beta.0', '0.9.0-beta.0', false],
      ['1.0.0-beta.0', '^0.9.0', '^0.9.0', false],
      ['1.0.0-beta.0', 'bad', 'bad', false],
      ['bad', '0.9.0', '0.9.0', false],
      ['1.0.0-beta.0', '0.9.0', '0.8.0', false],
    ] as const) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ version }))
      await addDeploymentFixture(root, pin, servicePin)
      if (valid) await checkDeploymentTemplates(root)
      else await expect(checkDeploymentTemplates(root)).rejects.toThrow()
    }
    await writeFile(join(root, 'package.json'), '{"version":"1.0.0-beta.0"}')
    await addDeploymentFixture(root, '0.9.0')
    await writeFile(join(root, 'packages/hosted-store-service/deployment/vercel.json'), '{}')
    await expect(checkDeploymentTemplates(root)).rejects.toThrow()
    await addDeploymentFixture(root, '0.9.0')
    const missing = '{"dependencies":{}}'
    for (const path of ['templates/hosted-service', 'packages/hosted-store-service/deployment'])
      await writeFile(join(root, path, 'package.json'), missing)
    await expect(checkDeploymentTemplates(root)).rejects.toThrow('exact semver')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

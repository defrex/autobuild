import { expect, test } from 'bun:test'
import { checkDeploymentTemplates } from './hosted-service-packaging'
import { replaceHostedServicePins, replacePackageVersion } from './release'

test('deployment templates and documentation have matching released pins', async () => {
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

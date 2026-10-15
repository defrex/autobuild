import { expect, test } from 'bun:test'
import { checkDeploymentTemplates } from './hosted-service-packaging'
import { replaceHostedServicePins, replacePackageVersion } from './release'

test('deployment templates and documentation have matching released pins', async () => {
  await checkDeploymentTemplates()
})
test('releases keep template pins and application core dependency aligned', () => {
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
  expect(
    replacePackageVersion(
      '{\n  "version": "0.11.0",\n  "dependencies": { "@defrex/autobuild": "0.11.0" }\n}\n',
      '0.12.0',
    ),
  ).toContain('"@defrex/autobuild": "0.12.0"')
})

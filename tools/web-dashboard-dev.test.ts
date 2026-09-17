import { expect, test } from 'bun:test'
import {
  parseWebAuthEnv,
  safeWebConfig,
  type WebEnv,
} from '../packages/hosted-store-service/src/web/config'
import { devEnv } from './web-dashboard-dev'

test('devEnv seeds normalized repository origins the web config accepts', () => {
  const config = parseWebAuthEnv(devEnv() as WebEnv)
  expect(safeWebConfig(config).repositories).toEqual([
    'https://github.com/example/happy',
    'https://github.com/example/mixed',
  ])
})

test('the pre-fix short-form spellings are rejected by the web config', () => {
  // The failure mode this seeding exists for: `owner/name` contains no
  // colon, so the normalizer passes it through and the config's
  // `^https://` check throws — which 500s every page that parses the env.
  const stale = { ...devEnv(), AB_WEB_REPOSITORIES: 'example/happy,example/mixed' }
  expect(() => parseWebAuthEnv(stale)).toThrow('unsafe repository name')
})

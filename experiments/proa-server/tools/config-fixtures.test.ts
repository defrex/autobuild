import { test } from 'bun:test'
import { checkConfigurationContract } from './config-fixtures'

test('native configuration grammar and differential oracle are source fresh', async () => {
  await checkConfigurationContract()
})

import { test } from 'bun:test'
import { checkConnectIdentityContract } from './connect-fixtures'
test('native connect identity oracle is source fresh', checkConnectIdentityContract)

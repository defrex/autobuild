import { expect, test } from 'bun:test'
import { hookCommandEnv } from './hook-command'

test('the hook environment strips build identity and names the hook', () => {
  expect(
    hookCommandEnv({ PATH: '/bin', AB_BUILD: 'b', AB_CONTEXT_DIR: 'x', AB_STORE: 's' }, 'notify'),
  ).toEqual({ PATH: '/bin', AB_STORE: 's', AB_HOOK: 'notify' })
})

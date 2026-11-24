import { expect, test } from 'bun:test'
import { withAccountSettings } from './account-env'
test('no account invokes directly without creating files', async () => {
  expect(
    await withAccountSettings(
      {},
      undefined,
      async (args) => {
        expect(args).toEqual([])
        return 'ok'
      },
      {
        mkdtemp: () => {
          throw new Error('unexpected file creation')
        },
        writeFile: () => {
          throw new Error('unexpected write')
        },
        rm: () => {
          throw new Error('unexpected removal')
        },
      },
    ),
  ).toBe('ok')
})

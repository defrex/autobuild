import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { tokensCss } from './tokens-css'

test('generated tokens.css matches tokens.ts', async () => {
  const committed = await Bun.file(join(import.meta.dir, 'generated/tokens.css')).text()
  expect(committed).toBe(tokensCss())
})

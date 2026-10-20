import { expect, test } from 'bun:test'
import { FakeForge } from '../ports/forge/fake'
import { publishExact } from './publication'

test('an older adapter without authoritative inspection is refused before any publication effect', async () => {
  const forge = new FakeForge()
  Object.defineProperty(forge, 'confirmPublication', { value: undefined })
  await expect(publishExact(forge, '/workspace', 'ab/example', 'a'.repeat(40))).rejects.toThrow(
    'lacks authoritative publication inspection',
  )
  expect(forge.pushes).toHaveLength(0)
})

test('a lost ordinary push acknowledgement is adopted exactly and never pushed twice', async () => {
  const forge = new FakeForge()
  const push = forge.pushBranch.bind(forge)
  forge.pushBranch = async (...args) => {
    await push(...args)
    throw new Error('lost transport acknowledgement')
  }
  await publishExact(forge, '/workspace', 'ab/example', 'a'.repeat(40))
  await publishExact(forge, '/workspace', 'ab/example', 'a'.repeat(40))
  expect(forge.pushes).toHaveLength(1)
})

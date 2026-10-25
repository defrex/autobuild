import { expect, test } from 'bun:test'
import { checkUnicodeFixtures, unicodeFixtures, utf16Units } from './protocol-unicode-fixtures'
test('JavaScript UTF16 and JSON oracle fixtures remain fresh', () => {
  checkUnicodeFixtures()
  const fixture = unicodeFixtures()
  expect(fixture.valid).toHaveLength(76)
  expect(fixture.invalid).toHaveLength(19)
  expect(fixture.utf8).toHaveLength(10)
  expect(utf16Units('💩')).toEqual([0xd83d, 0xdca9])
  expect(fixture.utf8.find((x) => x.name === 'surrogate')?.units).toEqual([65533, 65533, 65533])
})

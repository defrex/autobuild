import { expect, test } from 'bun:test'
import { rewriteDeclaredSpecifiers, registryVersionUrl } from './self-update'

test('rewriteDeclaredSpecifiers touches only the declared specifiers', () => {
  const text =
    '{\n\t"name": "x",\n\t"dependencies": {\n\t\t"a": "^1.0.0",\n\t\t"p": "^1.0.0"\n\t},\n\t"devDependencies": {\n\t\t"p": "1.0.0"\n\t}\n}\n'
  expect(rewriteDeclaredSpecifiers(text, 'p', '^2.0.0')).toBe(
    text.replace('"p": "^1.0.0"', '"p": "^2.0.0"').replace('"p": "1.0.0"', '"p": "^2.0.0"'),
  )
})

test('registry version URLs encode the scope separator and default to latest', () => {
  expect(registryVersionUrl('https://registry.npmjs.org', '@defrex/autobuild')).toBe(
    'https://registry.npmjs.org/@defrex%2fautobuild/latest',
  )
  expect(registryVersionUrl('https://registry.example.test', 'autobuild', '1.2.3')).toBe(
    'https://registry.example.test/autobuild/1.2.3',
  )
})

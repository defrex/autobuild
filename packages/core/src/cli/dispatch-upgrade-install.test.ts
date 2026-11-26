import { expect, test } from 'bun:test'
import { SOURCE_INSTALL_ARGUMENTS, validateUpgradeLockReceipt } from './dispatch-upgrade-install'

test('forge staging receipts match resolution and Bun tag across separately parsed metadata objects', () => {
  const text =
    '["@defrex/autobuild@github:fork-owner/repo-name#a1b2c3d", {}, "fork-owner-repo-name-a1b2c3d"]'
  const authoritative = Bun.JSONC.parse(text) as unknown[]
  const receipt = Bun.JSONC.parse(text) as unknown[]
  expect(authoritative[1]).not.toBe(receipt[1])
  expect(() => validateUpgradeLockReceipt(authoritative, receipt)).not.toThrow()
  expect(() =>
    validateUpgradeLockReceipt(authoritative, [
      receipt[0],
      { dependencies: { example: '1' } },
      receipt[2],
    ]),
  ).not.toThrow()
  expect(() =>
    validateUpgradeLockReceipt(authoritative, [
      '@defrex/autobuild@github:fork-owner/repo-name#b1b2c3d',
      receipt[1],
      receipt[2],
    ]),
  ).toThrow('installed package contradicts authoritative lock')
  expect(() =>
    validateUpgradeLockReceipt(authoritative, [
      receipt[0],
      receipt[1],
      'fork-owner-repo-name-b1b2c3d',
    ]),
  ).toThrow('installed forge identity contradicts authoritative lock')
  expect(() => validateUpgradeLockReceipt(authoritative, undefined)).toThrow(
    'installed package contradicts authoritative lock',
  )
})

test('registry staging receipts still validate URL and integrity values', () => {
  const authoritative = ['@defrex/autobuild@2.0.0', 'https://registry.example', {}, 'sha512-locked']
  const receipt = JSON.parse(JSON.stringify(authoritative)) as unknown[]
  expect(() => validateUpgradeLockReceipt(authoritative, receipt)).not.toThrow()
  expect(() =>
    validateUpgradeLockReceipt(authoritative, [
      receipt[0],
      'https://other.example',
      receipt[2],
      receipt[3],
    ]),
  ).toThrow('installed package contradicts authoritative lock')
  expect(() =>
    validateUpgradeLockReceipt(authoritative, [...receipt.slice(0, -1), 'sha512-different']),
  ).toThrow('installed integrity contradicts authoritative lock')
})

test('source upgrade installs only the root production closure from the frozen lock without scripts', () => {
  const args: readonly string[] = SOURCE_INSTALL_ARGUMENTS
  expect(args[0]).toBe('install')
  for (const flag of ['--frozen-lockfile', '--ignore-scripts', '--production'])
    expect(args).toContain(flag)
  expect(args[args.indexOf('--filter') + 1]).toBe('./')
})

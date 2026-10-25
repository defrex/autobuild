/** Read-only repository identity oracle from the unchanged CLI connection contract. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { normalizeConnectionRepository } from '../../../packages/core/src/connection'
const file = resolve(import.meta.dir, '../fixtures/connect-identities.json')
export function connectIdentityContract() {
  const inputs = [
    '',
    ' ',
    'owner/repo',
    'git@GitHub.com:Owner/Repo.git',
    'github.com:Owner/Repo.git',
    ' https://GitHub.com/Owner/Repo.git/ ',
    ...['https', 'http', 'ssh', 'git', 'git+ssh', 'file', 'ftp'].flatMap((scheme) =>
      [
        'github.com/Owner/Repo.git',
        'git@github.com/Owner/Repo',
        'user:password@github.com/a/b',
        'github.com/',
        'github.com/a%20b',
        'github.com/a?x',
        'github.com/a#x',
        'github.com:123/a/b',
      ].map((tail) => `${scheme}://${tail}`),
    ),
    'git:secret@github.com:a/b',
    'C:/repo',
    'github.com:/absolute',
    'https://github.com/Owner/Repo.GIT',
    'https://github.com/a//b///',
    'https://github.com/a/../b',
    'https://github.com/世界/仓库',
    'https://github.com/a\\b',
    'https://[::1]/a/b',
    'https://github.com:443/a/b',
  ]
  return {
    format: 1,
    sources: Object.fromEntries(
      ['connection.ts', 'kernel/origin.ts'].map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(import.meta.dir, '../../../packages/core/src', path)))
          .digest('hex'),
      ]),
    ),
    cases: inputs.map((input) => {
      try {
        return { input, output: normalizeConnectionRepository(input) }
      } catch {
        return { input, rejected: true }
      }
    }),
  }
}
export async function checkConnectIdentityContract() {
  if (!isDeepStrictEqual(await Bun.file(file).json(), connectIdentityContract()))
    throw Error('Connect identity oracle drifted; run tools/connect-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(file, `${JSON.stringify(connectIdentityContract(), null, 2)}\n`)
  else await checkConnectIdentityContract()
}

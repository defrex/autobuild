/** Signed-scope oracle: fake fixture keys only; no live credentials. */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import { root, experiment } from './fixture-core'
import {
  mintToken,
  verifyToken,
  type TokenScope,
} from '../../../packages/core/src/store/remote/token'
import { delegateCredentialBodySchema } from '../../../packages/core/src/store/remote/protocol'
export function tokenFixtures() {
  const secret = 'proa-delegation-fixture-secret-🔑'
  const now = Date.parse('2030-01-01T00:00:00.000Z')
  const base = {
    version: 2,
    delegation: {
      repo: 'https://github.com/proa/project',
      kind: 'build-runner',
      id: 'build-one',
      anchor: 1,
    },
  }
  const sign = (payload: string, key = secret) =>
    `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const cases: { id: string; secret: string; token: string; now: number; expected: unknown }[] = []
  function record(id: string, token: string, key = secret, at = now) {
    cases.push({ id, secret: key, token, now: at, expected: verifyToken(key, token, new Date(at)) })
  }
  function scope(id: string, value: unknown) {
    record(id, sign(encode(value)))
  }
  scope('base/build-runner', base)
  const unicode = { version: 2, delegation: { ...base.delegation, repo: '雪', id: '💩' } }
  scope('identity/unicode', unicode)
  record(
    'payload/unicode-standard-alphabet',
    sign(Buffer.from(JSON.stringify(unicode)).toString('base64')),
  )
  record('payload/unicode-ignored-nonascii', sign(`é${encode(base)}`))
  for (const [kind, session, execution] of [
    ['build-phase', 's1', undefined],
    ['harvest-runner', undefined, 'e1'],
    ['harvest-phase', 's1', 'e1'],
  ] as const)
    scope(`base/${kind}`, {
      version: 2,
      delegation: {
        ...base.delegation,
        kind,
        ...(session ? { session } : {}),
        ...(execution ? { execution } : {}),
        ...(kind === 'harvest-runner' ? { leaseHolder: 'h1' } : {}),
      },
    })
  for (const field of ['repo', 'id', 'session', 'execution', 'leaseHolder'] as const) {
    for (const value of ['', '*', ' ', 'x*y', null, 1]) {
      const claims = { ...base.delegation, [field]: value }
      scope(`identity/${field}/${JSON.stringify(value)}`, { version: 2, delegation: claims })
    }
  }
  for (const anchor of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    '1',
  ])
    scope(`anchor/${JSON.stringify(anchor)}`, {
      version: 2,
      delegation: { ...base.delegation, anchor },
    })
  for (const [id, value] of [
    ['extra-root', { ...base, extra: true }],
    ['extra-claim', { ...base, delegation: { ...base.delegation, extra: true } }],
    ['null', null],
    ['array', []],
    ['unknown-version', { ...base, version: 3 }],
    ['runner-with-session', { ...base, delegation: { ...base.delegation, session: 's' } }],
    ['phase-without-session', { ...base, delegation: { ...base.delegation, kind: 'build-phase' } }],
    ['build-with-execution', { ...base, delegation: { ...base.delegation, execution: 'e' } }],
    [
      'harvest-without-execution',
      { ...base, delegation: { ...base.delegation, kind: 'harvest-runner' } },
    ],
    ['build-with-leaseholder', { ...base, delegation: { ...base.delegation, leaseHolder: 'h' } }],
  ] as const)
    scope(`shape/${id}`, value)
  for (const exp of [now - 1, now, now + 1]) {
    scope(`admin/${exp}`, { version: 1, ownerAdmin: { user: '  owner  ' }, exp })
    scope(`internal/${exp}`, {
      version: 1,
      internalOperator: { user: '\u00a0operator\ufeff', repo: 'repo' },
      exp,
      via: { kind: 'mcp', client: 'fixture' },
    })
    scope(`legacy/${exp}`, { build: '*', session: 's', exp })
    scope(`resource/${exp}`, {
      resource: { kind: 'session', id: 'os_fixture' },
      session: 's',
      exp,
      via: { kind: 'session', id: 'os_via' },
    })
    scope(`operator/${exp}`, { operator: { user: '  user ' }, exp })
    scope(`deployment/${exp}`, { operator: true, session: 's', exp })
  }
  for (const value of [
    { version: 1, ownerAdmin: { user: ' ' }, exp: now + 1 },
    { version: 1, ownerAdmin: { user: 'u', extra: true }, exp: now + 1 },
    { version: 1, internalOperator: { user: 'u', repo: '*' }, exp: now + 1 },
    { operator: { user: 'u' }, exp: now + 1, via: { kind: 'mcp', client: 'x', extra: true } },
    { build: 'b', session: 's', exp: 1.5 },
    { resource: { kind: 'repo', id: 'r' }, session: 's', exp: now + 1, extra: true },
  ])
    scope(`legacy-invalid/${cases.length}`, value)
  const good = mintToken(secret, base as TokenScope),
    [payload, signature] = good.split('.') as [string, string]
  record('signature/padded', `${payload}.${signature}=`)
  record(
    'signature/standard-alphabet',
    `${payload}.${signature.replaceAll('-', '+').replaceAll('_', '/')}`,
  )
  record(
    'signature/ignored-whitespace',
    `${payload}. \t${signature.slice(0, 5)} \n${signature.slice(5)} `,
  )
  record('signature/ignored-punctuation', `${payload}.!${signature}?`)
  record('signature/after-padding-ignored', `${payload}.${signature}=garbage`)
  record('signature/modified', `${payload}.${signature.slice(0, -2)}AA`)
  record('signature/truncated', `${payload}.${signature.slice(0, -1)}`)
  record('signature/empty', `${payload}.`)
  record('signature/extra-dot', `${good}.x`)
  record('signature/wrong-key', good, 'other-key')
  for (const text of [
    `${payload}=`,
    `${payload}!`,
    `${payload.slice(0, 3)} \n!${payload.slice(3)}`,
    payload.replaceAll('-', '+').replaceAll('_', '/'),
  ])
    record(`payload/permissive-${cases.length}`, sign(text))
  for (const c of ['\u0141', '\u4e00', 'é', '💩', '\u212b'])
    record(`signature/unicode-${c}`, `${payload}.${signature.slice(0, 4)}${c}${signature.slice(4)}`)
  for (const key of ['', ' ', 'x'.repeat(200)])
    record(`secret/length-${key.length}`, mintToken(key, base as TokenScope), key)
  for (const raw of [
    '{',
    '[]',
    'null',
    '{"version":2,"delegation":{"repo":"repo","kind":"build-runner","id":"id","anchor":1e400}}',
    '{"version":2,"delegation":{"repo":"repo","kind":"build-runner","id":"id","anchor":1.0}}',
    '{"version":2,"delegation":{"repo":"repo","kind":"build-runner","id":"id","anchor":9007199254740993}}',
  ])
    record(`payload/raw-${cases.length}`, sign(Buffer.from(raw).toString('base64url')))
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"version":2,"delegation":{"repo":"repo","kind":"build-runner","id":"'),
    Buffer.from([255]),
    Buffer.from('","anchor":1}}'),
  ])
  record('payload/invalid-utf8-inside-string', sign(invalidUtf8.toString('base64url')))
  const mint = [
    base,
    {
      version: 2,
      delegation: {
        repo: 'repo',
        kind: 'harvest-phase',
        id: 'run',
        anchor: 9,
        execution: 'e',
        session: 's',
      },
    },
    {
      version: 2,
      delegation: {
        repo: 'repo',
        kind: 'build-phase',
        id: 'b',
        anchor: 1,
        session: 's',
        leaseHolder: 'allowed-extra-holder',
      },
    },
    { version: 2, delegation: { repo: ' snow/雪 ', kind: 'build-runner', id: 'b', anchor: 1 } },
  ].map((input) => ({ input, secret, token: mintToken(secret, input as TokenScope) }))
  const targets = [
    { kind: 'build-runner', id: 'b' },
    { kind: 'build-phase', id: 'b', session: 's' },
    { kind: 'harvest-runner', repo: 'r', id: 'h', execution: 'e', leaseHolder: 'holder' },
    { kind: 'harvest-phase', repo: 'r', id: 'h', session: 's' },
    { kind: 'build-runner', id: '*' },
    { kind: 'build-phase', id: 'b', session: '*' },
    { kind: 'build-runner', id: 'b', extra: true },
    { kind: 'harvest-phase', repo: 'r', id: 'h', session: 's', execution: 'e' },
    null,
  ].map((input) => {
    const parsed = delegateCredentialBodySchema.safeParse(input)
    return { input, accepted: parsed.success ? parsed.data : null }
  })
  const sources = Object.fromEntries(
    [
      'packages/core/src/store/remote/token.ts',
      'packages/core/src/store/remote/protocol.ts',
      'packages/core/src/events/envelope.ts',
      'packages/hosted-store-service/src/config.ts',
      'packages/hosted-store-service/src/machine-auth.ts',
      'packages/hosted-store-service/src/delegated-authority.ts',
    ].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  )
  return { sources, cases, mint, targets }
}
export const fixturePath = resolve(experiment, 'fixtures/protocol-tokens.json')
export function checkTokenFixtures() {
  if (!isDeepStrictEqual(tokenFixtures(), JSON.parse(readFileSync(fixturePath, 'utf8'))))
    throw new Error('Token fixtures stale; regenerate with --generate')
}
if (import.meta.main) {
  const fixture = tokenFixtures()
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', fixturePath],
      { stdin: Buffer.from(JSON.stringify(fixture)), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode) throw new Error('Cannot format token fixtures')
    await Bun.write(fixturePath, formatted.stdout)
  } else checkTokenFixtures()
  console.log(
    JSON.stringify({
      verify: fixture.cases.length,
      mint: fixture.mint.length,
      targets: fixture.targets.length,
    }),
  )
}

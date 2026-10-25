/** Independent source crypto/claims oracle for non-scalar JS identities. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  mintToken,
  verifyToken,
  type TokenScope,
} from '../../../packages/core/src/store/remote/token'
import { delegateCredentialBodySchema } from '../../../packages/core/src/store/remote/protocol'
import { root, experiment } from './fixture-core'
import { utf16Units } from './protocol-unicode-fixtures'
export function tokenUnicodeFixtures() {
  const secret = 'fake-unicode-token-oracle',
    now = Date.parse('2030-01-01T00:00:00Z')
  const verify: {
      name: string
      secret: string
      token: string
      now: number
      expectedUnits: number[]
    }[] = [],
    mint: { name: string; secret: string; input: string; token: string }[] = [],
    targets: { name: string; input: string; expectedUnits: number[] }[] = []
  const add = (name: string, input: unknown) => {
    const token = mintToken(secret, input as TokenScope)
    verify.push({
      name,
      secret,
      token,
      now,
      expectedUnits: utf16Units(JSON.stringify(verifyToken(secret, token, new Date(now)))),
    })
    mint.push({ name, secret, input: JSON.stringify(input), token })
  }
  for (const [tag, value] of [
    ['high', '\ud800'],
    ['low', '\udfff'],
    ['reversed', '\udfff\ud800'],
    ['replacement', '�'],
    ['pair', '💩'],
  ] as const) {
    for (const kind of [
      'build-runner',
      'build-phase',
      'harvest-runner',
      'harvest-phase',
    ] as const) {
      const claims = {
        repo: 'repo',
        kind,
        id: 'id',
        anchor: 1,
        ...(kind.endsWith('-phase') ? { session: 'session' } : {}),
        ...(kind.startsWith('harvest') ? { execution: 'execution' } : {}),
        leaseHolder: 'holder',
      }
      for (const field of Object.keys(claims).filter((k) => !['kind', 'anchor'].includes(k)))
        add(`${kind}/${field}/${tag}`, { version: 2, delegation: { ...claims, [field]: value } })
      const target = {
        kind,
        repo: value,
        id: value,
        ...(kind.endsWith('-phase') ? { session: value } : {}),
        ...(kind === 'harvest-runner' ? { execution: value, leaseHolder: value } : {}),
      }
      const parsed = delegateCredentialBodySchema.safeParse(target)
      targets.push({
        name: `${kind}/${tag}`,
        input: JSON.stringify(target),
        expectedUnits: utf16Units(JSON.stringify(parsed.success ? parsed.data : null)),
      })
    }
    add(`admin/${tag}`, {
      version: 1,
      ownerAdmin: { user: ` \t${value}\u00a0` },
      exp: now + 100000,
    })
    add(`internal/${tag}`, {
      version: 1,
      internalOperator: { user: ` ${value} `, repo: value },
      exp: now + 100000,
      via: { kind: 'session', id: value },
    })
    add(`internal-mcp/${tag}`, {
      version: 1,
      internalOperator: { user: value, repo: value },
      exp: now + 100000,
      via: { kind: 'mcp', client: value },
    })
    add(`retired/${tag}`, { build: value, session: value, exp: now + 100000 })
  }
  return { verify, mint, targets }
}
const path = resolve(experiment, 'fixtures/protocol-token-unicode.json')
export function checkTokenUnicodeFixtures() {
  if (!isDeepStrictEqual(tokenUnicodeFixtures(), JSON.parse(readFileSync(path, 'utf8'))))
    throw new Error('Token Unicode fixtures stale')
}
if (import.meta.main) {
  const fixture = tokenUnicodeFixtures()
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', path],
      { stdin: Buffer.from(JSON.stringify(fixture)), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode) throw new Error('Cannot format token Unicode fixtures')
    await Bun.write(path, formatted.stdout)
  } else checkTokenUnicodeFixtures()
  console.log(
    JSON.stringify({
      verify: fixture.verify.length,
      mint: fixture.mint.length,
      targets: fixture.targets.length,
    }),
  )
}

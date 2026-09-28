import { CryptoHasher } from 'bun'
import { expect, test } from 'bun:test'

import {
  AUTH_SCHEMA_CHECKSUM,
  AUTH_SCHEMA_V1_CHECKSUM,
  AUTH_SCHEMA_V1_DDL,
  AUTH_SCHEMA_V2_CHECKSUM,
  AUTH_SCHEMA_V2_DDL,
  AUTH_SCHEMA_VERSION,
} from './auth-schema'
import {
  SCHEMA_CHECKSUM,
  SCHEMA_V1_CHECKSUM,
  SCHEMA_V1_DDL,
  SCHEMA_V2_CHECKSUM,
  SCHEMA_V2_DDL,
  SCHEMA_V3_CHECKSUM,
  SCHEMA_V3_DDL,
  SCHEMA_V4_CHECKSUM,
  SCHEMA_V4_DDL,
  SCHEMA_V5_CHECKSUM,
  SCHEMA_V5_DDL,
  SCHEMA_V6_CHECKSUM,
  SCHEMA_V6_DDL,
  SCHEMA_V7_CHECKSUM,
  SCHEMA_V7_DDL,
  SCHEMA_VERSION,
  TICKET_SCHEMA_CHECKSUM,
  TICKET_SCHEMA_VERSION,
} from './schema'

interface FrozenSchema {
  ddl: string
  checksum: string
}

/** The frozen DDL of every schema family that has at least one historical
 * version, keyed by the version the DDL deployed. Built here — not exported
 * from `schema.ts` / `auth-schema.ts` — so the published package surface stays
 * untouched; the existing per-version exports already carry all the data.
 *
 * Exported for reuse by `migrate.test.ts`: importing this module runs these
 * pure tests inside that file's `postgres` verify invocation too (bun dedupes
 * the module instance, so nothing double-executes), and the general-property
 * migration tests look their predecessor up from the same maps, so a future
 * bump keeps them live without hand-editing the fixtures. */
export const FROZEN: Record<'build' | 'ticket' | 'auth', Map<number, FrozenSchema>> = {
  build: new Map([
    [1, { ddl: SCHEMA_V1_DDL, checksum: SCHEMA_V1_CHECKSUM }],
    [2, { ddl: SCHEMA_V2_DDL, checksum: SCHEMA_V2_CHECKSUM }],
    [3, { ddl: SCHEMA_V3_DDL, checksum: SCHEMA_V3_CHECKSUM }],
    [4, { ddl: SCHEMA_V4_DDL, checksum: SCHEMA_V4_CHECKSUM }],
    [5, { ddl: SCHEMA_V5_DDL, checksum: SCHEMA_V5_CHECKSUM }],
    [6, { ddl: SCHEMA_V6_DDL, checksum: SCHEMA_V6_CHECKSUM }],
    [7, { ddl: SCHEMA_V7_DDL, checksum: SCHEMA_V7_CHECKSUM }],
  ]),
  ticket: new Map(),
  auth: new Map([
    [1, { ddl: AUTH_SCHEMA_V1_DDL, checksum: AUTH_SCHEMA_V1_CHECKSUM }],
    [2, { ddl: AUTH_SCHEMA_V2_DDL, checksum: AUTH_SCHEMA_V2_CHECKSUM }],
  ]),
}

interface GuardedFamily {
  marker: string
  /** The frozen constants' naming prefix (`SCHEMA_V<N>_DDL`, …), so the guard
   * message can point at the constant to freeze. */
  ddlPrefix: string
  version: number
  checksum: string
  pin: { version: number; checksum: string }
  frozen: Map<number, FrozenSchema>
}

/** The committed pin. Literal values, deliberately not derived from the DDL:
 * a pin computed from the DDL would silently bless any edit. The pin is a
 * tripwire, not an enforced coupling: it fails any DDL or version edit that
 * leaves the pin untouched (the naive path, with the four-step rule in the
 * failure output), but it cannot mechanically force the version bump. An
 * author who edits the DDL and re-pins only the checksum — leaving the pinned
 * version and the exported version constants unchanged — passes this suite,
 * because the pin is the only committed record of the released checksum and
 * it is editable in the same commit as the DDL; deployed databases then carry
 * the pre-edit checksum and fail the next migration. That residual gap is
 * documented, not closed: no committed-state cross-check can distinguish a
 * deliberate checksum-only re-pin from a legitimate bump (see the README's
 * four-step paragraph). */
const PINNED: Record<'build' | 'ticket' | 'auth', { version: number; checksum: string }> = {
  build: {
    version: 8,
    checksum: '1961ddbc5f6dd2331246f9f0fde1c02a0bd479c745df54b087c82fea1ee8b4e1',
  },
  ticket: {
    version: 1,
    checksum: 'dcfc30e0c2dad7667862e4921c86c88ef9afcfc3aa781b136c0cd9f660326a48',
  },
  auth: {
    version: 3,
    checksum: '252e3c3ddae60e64c64b71ed8979f5bc78ec02491eb6879983f61b818903b174',
  },
}

const FAMILIES: GuardedFamily[] = [
  {
    marker: 'PostgreSQL BuildStore schema',
    ddlPrefix: 'SCHEMA',
    version: SCHEMA_VERSION,
    checksum: SCHEMA_CHECKSUM,
    pin: PINNED.build,
    frozen: FROZEN.build,
  },
  {
    marker: 'PostgreSQL ticket schema',
    ddlPrefix: 'TICKET_SCHEMA',
    version: TICKET_SCHEMA_VERSION,
    checksum: TICKET_SCHEMA_CHECKSUM,
    pin: PINNED.ticket,
    frozen: FROZEN.ticket,
  },
  {
    marker: 'PostgreSQL auth schema',
    ddlPrefix: 'AUTH_SCHEMA',
    version: AUTH_SCHEMA_VERSION,
    checksum: AUTH_SCHEMA_CHECKSUM,
    pin: PINNED.auth,
    frozen: FROZEN.auth,
  },
]

/** The rule the failure message must teach, phrased for the family that
 * tripped it. Thrown as a plain `Error` rather than asserted with `expect`,
 * so the failure output *is* the instruction. */
function guardMessage(family: GuardedFamily): string {
  // The freeze target is the version the pin currently records, in both
  // failure modes: an un-bumped DDL edit must be preserved under that
  // version's constant (its content is what every deployed database carries),
  // and a bumped-but-unfrozen edit must freeze the replaced DDL under the same
  // constant. `family.version - 1` would name an already-frozen constant in
  // the un-bumped mode — the exact incident this guard exists to teach.
  const steps =
    family.version > 1
      ? `freeze the DDL the pin currently records (${family.ddlPrefix}_V${family.pin.version}_DDL + its checksum) as that version's frozen constant, add its upgrade branch in migratePostgres, bump the schema version, and update the pinned version and checksum in schema-guard.test.ts`
      : `bump the schema version and update the pinned version and checksum in schema-guard.test.ts (no frozen predecessor exists yet; the freeze-and-branch steps apply from the first version bump on)`
  return (
    `${family.marker} DDL or version no longer matches the committed pin. The current DDL ` +
    `is immutable once a database has deployed it: ${steps}. Expected version ` +
    `${family.pin.version} with checksum ${family.pin.checksum}; found version ${family.version} with ` +
    `checksum ${family.checksum}. Bumping the version is not optional: updating only the pin's ` +
    `checksum silences this test while every deployed database still carries the pre-edit ` +
    `checksum, and the next migration then fails "marker is incompatible".`
  )
}

for (const family of FAMILIES) {
  test(`${family.marker} matches its committed pin`, () => {
    if (family.version !== family.pin.version || family.checksum !== family.pin.checksum) {
      throw new Error(guardMessage(family))
    }
  })
}

test('the guard failure message names the four-step rule and the checksum-only re-pin trap', () => {
  // The guard tests throw plain `Error`s whose text *is* the instruction, so
  // the wording is the deliverable; this meta-test pins it against silent
  // rewording. Both failure branches are exercised: a version-bearing family
  // (freeze-and-branch steps) and a v1 family (bump-and-pin steps).
  const bumped: GuardedFamily = {
    marker: 'PostgreSQL BuildStore schema',
    ddlPrefix: 'SCHEMA',
    version: 9,
    checksum: 'found-checksum',
    pin: { version: 8, checksum: 'pinned-checksum' },
    frozen: FROZEN.build,
  }
  const first: GuardedFamily = {
    ...bumped,
    marker: 'PostgreSQL ticket schema',
    ddlPrefix: 'TICKET_SCHEMA',
    version: 1,
    pin: { version: 1, checksum: 'pinned-checksum' },
  }
  for (const family of [bumped, first]) {
    const message = guardMessage(family)
    // The four-step rule, in both branches' phrasing.
    expect(message).toContain('no longer matches the committed pin')
    expect(message).toContain('is immutable once a database has deployed it')
    expect(message).toContain(
      `Expected version ${family.pin.version} with checksum pinned-checksum; found version ` +
        `${family.version} with checksum found-checksum`,
    )
    if (family.version > 1) {
      expect(message).toContain('freeze the DDL the pin currently records')
      expect(message).toContain('add its upgrade branch in migratePostgres')
    }
    expect(message).toContain('bump the schema version')
    expect(message).toContain('update the pinned version and checksum in schema-guard.test.ts')
    // The checksum-only re-pin trap: the failure output must teach that a
    // partial compliance (re-pin without bump) re-arms the pin over an edited
    // DDL and pushes the failure onto deployed databases.
    expect(message).toContain("updating only the pin's checksum silences this test")
    expect(message).toContain('the next migration then fails "marker is incompatible"')
  }
})

test('frozen DDL families are contiguous from v1 to the current version minus one', () => {
  for (const family of FAMILIES) {
    const expected: number[] = []
    for (let version = 1; version < family.version; version++) expected.push(version)
    const actual = [...family.frozen.keys()].sort((a, b) => a - b)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Frozen ${family.marker} DDL family is not contiguous: expected frozen DDL for every ` +
          `version 1..${family.version - 1}, found ${actual.length === 0 ? 'none' : actual.join(', ')}. ` +
          `Every schema change is a new version with the previous DDL frozen: add the missing ` +
          `${family.ddlPrefix}_V<N>_DDL constant (pre-trimmed) with its checksum and an upgrade ` +
          `branch in migratePostgres before bumping the version.`,
      )
    }
  }
})

test('every frozen checksum equals a fresh SHA-256 of its DDL', () => {
  for (const family of FAMILIES) {
    for (const [version, entry] of family.frozen) {
      const computed = new CryptoHasher('sha256').update(entry.ddl).digest('hex')
      if (computed !== entry.checksum) {
        throw new Error(
          `${family.marker} frozen v${version} checksum does not match its DDL: the frozen ` +
            `constant drifted from its committed checksum. A deployed marker's checksum is taken ` +
            `over the trimmed DDL, so fix the constant, never the checksum.`,
        )
      }
    }
  }
})

import { CryptoHasher } from 'bun'
import { test } from 'bun:test'

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
   * message can point at the constant that is missing. */
  ddlPrefix: string
  version: number
  checksum: string
  pin: { version: number; checksum: string }
  frozen: Map<number, FrozenSchema>
}

/** The committed pin. Literal values, deliberately not derived from the DDL:
 * a pin computed from the DDL would silently bless any edit. A checksum-only
 * pin would let an author edit the DDL, update the pin, and still forget the
 * version bump — the deployed shape that caused the 2026-09-16 outage — so
 * the version rides alongside the checksum and "bump the version and update
 * the pin" is one atomic committed pair. */
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
  const steps =
    family.version > 1
      ? `freeze the previous DDL (${family.ddlPrefix}_V${family.version - 1}_DDL + its checksum), add its upgrade branch in migratePostgres, bump the schema version, and update the pinned version and checksum in schema-guard.test.ts`
      : `bump the schema version and update the pinned version and checksum in schema-guard.test.ts (no frozen predecessor exists yet; the freeze-and-branch steps apply from the first version bump on)`
  return (
    `${family.marker} DDL or version no longer matches the committed pin. The current DDL ` +
    `is immutable once a database has deployed it: ${steps}. Expected version ` +
    `${family.pin.version} with checksum ${family.pin.checksum}; found version ${family.version} with ` +
    `checksum ${family.checksum}.`
  )
}

for (const family of FAMILIES) {
  test(`${family.marker} matches its committed pin`, () => {
    if (family.version !== family.pin.version || family.checksum !== family.pin.checksum) {
      throw new Error(guardMessage(family))
    }
  })
}

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

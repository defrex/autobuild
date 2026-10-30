import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'
import { expect, test } from 'bun:test'
import {
  clientSupportsIntegrationAuditPending,
  classifyClient,
  supportedClientRange,
  clientIdentityError,
  healthIdentity,
  releaseVersion,
  reducerValueForClient,
} from './compatibility'
import { repositoryReadFactsReducer } from '../../kernel/read-facts'
import { projectReducerValue } from '../reducer-value-validation'

test('audit capability follows its introduction line independently of admission', () => {
  for (const version of [
    '0.14.0',
    '0.14.999',
    '0.14.0-beta.0',
    '0.15.0',
    '1.0.0-beta.0',
    '1.0.0',
    AUTOBUILD_VERSION,
    '1.99.0',
    '2.0.0',
  ])
    expect(clientSupportsIntegrationAuditPending(version)).toBe(true)
  for (const version of [
    '0.0.0',
    '0.12.0',
    '0.13.999',
    null,
    undefined,
    '',
    'v1.0.0',
    '1.0',
    '1.0.0+build',
    '01.0.0',
    '1.0.0-01',
    ' 1.0.0',
  ])
    expect(clientSupportsIntegrationAuditPending(version)).toBe(false)
  expect(clientIdentityError('0.13.0', '3', '1.3.0', '6')).toContain('policy floor 1.2')
  expect(clientSupportsIntegrationAuditPending('0.13.0')).toBe(false)
})

test('bounded event protocol rejects peers without the new required operations', () => {
  expect(REMOTE_STORE_PROTOCOL_VERSION).toBe('7')
  expect(clientIdentityError(AUTOBUILD_VERSION, '4')).toContain('unsupported protocol identity')
  expect(clientIdentityError(AUTOBUILD_VERSION, '5')).toContain('unsupported protocol identity')
  expect(clientIdentityError(AUTOBUILD_VERSION, '6')).toBeUndefined()
  expect(clientIdentityError(AUTOBUILD_VERSION, '7')).toBeUndefined()
})

test('supported peer admission does not make advisory polling facts decisive', async () => {
  const { buildEventPolicy } = await import('../../events/policy')
  const { initialCompatibility, advanceCompatibility, decodeStoredEvent } = await import(
    '../../events/compatibility'
  )
  const { newerFact } = await import('../../testing/newer-writer')
  const { mixedVersionDeferred } = await import('../../kernel/mixed-version')
  expect(clientIdentityError('1.2.0', '6', '1.3.0', '6')).toBeUndefined()
  const classification = buildEventPolicy['node.poll-checked']
  expect(classification).toBe('advisory')
  const opaque = { ...newerFact(1, classification), type: 'old-reader-unknown.node.poll-checked' }
  expect(decodeStoredEvent(opaque)).toBeNull()
  const compatibility = initialCompatibility()
  advanceCompatibility(compatibility, [opaque])
  expect(mixedVersionDeferred({ compatibility })).toBe(false)
  advanceCompatibility(compatibility, [newerFact(2, 'decisive')])
  expect(mixedVersionDeferred({ compatibility })).toBe(true)
})

test('unrecorded clients receive the canonical answer', () => {
  const value = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  const answer = { version: repositoryReadFactsReducer.version, cursor: 7, value }
  for (const version of [null, 'constructor', '0.0.0-policy-excluded'])
    expect(reducerValueForClient({ version, projects: false }, 'repositoryReadFacts', answer)).toBe(
      answer,
    )
})

import {
  RELEASED_CLIENTS,
  supportedPublishedLines,
  validatePublications,
  type ReleasedClient,
} from './released-clients'
import { RELEASED_REDUCER_VALUES } from './released-reducer-values'
import { REDUCERS } from '../../kernel/reducer-registry'
import { REDUCER_VALUE_CONTRACT_IDENTITY } from '../reducer-value-validation'
const epoch = Date.parse('2026-10-29T00:00:00Z')
const day = 86400000
const record = (version: string, days: number): ReleasedClient => ({
  version,
  publishedAt: new Date(epoch + days * day).toISOString(),
  protocol: '6',
  contract: 'synthetic.json',
  provenance: { tag: `v${version}` },
})
const ledger = [record('1.2.0', 0), record('1.4.0', 1), record('2.0.0', 2)]

test('retirement needs both two newer publications and exactly 90 UTC days since successor', () => {
  for (const delta of [-1, 0, 1]) {
    const now = epoch + 91 * day + delta
    expect(supportedClientRange('2.0.0', now, ledger).minVersion).toBe(
      delta < 0 ? '1.2.0' : '1.4.0',
    )
    const error = clientIdentityError('1.2.99', '6', '2.0.0', '6', now, ledger)
    if (delta < 0) expect(error).toBeUndefined()
    else {
      expect(error).toContain('>=1.4.0 <2.1.0')
      expect(error).toContain('90 days')
      expect(error).toContain('policy floor 1.2')
    }
  }
  expect(supportedClientRange('1.4.0', epoch + 900 * day, ledger).minVersion).toBe('1.2.0')
  expect(supportedClientRange('1.2.0', epoch + 900 * day, ledger).minVersion).toBe('1.2.0')
  expect(supportedClientRange('2.0.0', epoch + 50 * day, ledger).minVersion).toBe('1.2.0')
  expect(
    supportedClientRange('2.0.0', epoch + 91 * day, [...ledger, record('2.1.0', 3)]).minVersion,
  ).toBe('1.4.0')
})

test('patches and prereleases never start or reset stable line clocks', () => {
  const extra = [...ledger, record('2.1.0-beta.1', 3), record('1.4.1', 50)]
  expect(supportedClientRange('2.0.0', epoch + 91 * day, extra).minVersion).toBe('1.4.0')
  expect(
    supportedPublishedLines('2.0.0', epoch + 91 * day, [
      ...ledger.slice(0, 2),
      record('2.0.0-beta.1', 2),
    ]),
  ).toEqual(['1.2.0', '1.4.0'])
})

test('floor, gaps, future lines and protocol identities fail closed', () => {
  for (const client of ['0.99.0', '1.0.0', '1.1.999', '1.1.0-beta.1'])
    expect(
      clientIdentityError(client, '6', '2.0.0', '6', epoch, [record('1.1.0', 0), ...ledger]),
    ).toContain('policy floor 1.2')
  expect(clientIdentityError('1.3.0', '6', '2.0.0', '6', epoch, ledger)).toContain(
    'unsupported protocol identity',
  )
  expect(clientIdentityError('2.1.0', '6', '2.0.0', '6', epoch, ledger)).toContain('service first')
  expect(clientIdentityError('1.2.0', '5', '2.0.0', '6', epoch, ledger)).toContain('90 days')
  expect(clientIdentityError('2.2.999-rc.1', '7', '2.2.0-rc.2', '7', epoch, ledger)).toBeUndefined()
  for (const value of [null, '', 'v1.2.0', '1.2', '1.2.0+build', '01.2.0', '1.2.0-01', ' 1.2.0']) {
    expect(releaseVersion(value)).toBeUndefined()
    expect(classifyClient(value, supportedClientRange())).toBe('invalid')
  }
})

test('retired identities and contracts can be removed without readmission', () => {
  const retired = ledger.map((entry, index) =>
    index
      ? entry
      : { version: entry.version, publishedAt: entry.publishedAt, provenance: entry.provenance },
  )
  expect(clientIdentityError('1.2.0', '6', '2.0.0', '6', epoch + 91 * day, retired)).toContain(
    'upgrade',
  )
  expect(clientIdentityError('1.4.0', '6', '2.0.0', '6', epoch + 91 * day, retired)).toBeUndefined()
})

test('publication evidence is ordered, unique, and timestamped', () => {
  expect(() => validatePublications(RELEASED_CLIENTS)).not.toThrow()
  expect(() => validatePublications([...ledger, ledger[0]!])).toThrow('ordered')
  expect(() => validatePublications([{ ...ledger[0]!, publishedAt: 'not a date' }])).toThrow(
    'timestamp',
  )
})

// A fixed clock makes coverage independent of the day CI happens to run.
const contractTestClock = Date.parse('2026-10-30T00:00:00Z')
const supportedReleases = RELEASED_CLIENTS.filter((entry) =>
  supportedPublishedLines(AUTOBUILD_VERSION, contractTestClock).includes(
    `${entry.version.split('.').slice(0, 2).join('.')}.0`,
  ),
)
// Model the first header-sending published line using an immutable old catalog.
const matrixReleases = [
  ...supportedReleases,
  {
    ...supportedReleases.at(-1)!,
    version: '1.4.0',
    projects: true,
    catalogIdentity: 'frozen-published-1.4-catalog',
  },
]
for (const release of matrixReleases) {
  test(`published ${release.version}: every named reducer fits its frozen acceptance contract`, () => {
    expect(release.protocol).toBeDefined()
    expect(release.contract).toBeDefined()
    const catalog = RELEASED_REDUCER_VALUES[release.contract!]!
    expect(catalog).toBeDefined()
    for (const [name, entry] of Object.entries(REDUCERS)) {
      if (!('scope' in entry.valueRead) || !Object.hasOwn(catalog.versions, name)) continue
      expect(catalog.roots[name], name).toBeDefined()
      expect(catalog.versions[name], name).toBeNumber()
      const value = entry.reducer.finish(entry.reducer.initial())
      const answer = { version: entry.reducer.version, cursor: 999, value }
      const before = JSON.stringify(answer)
      const adapted = reducerValueForClient(
        {
          version: release.version,
          projects: release.projects ?? false,
          catalogIdentity: release.catalogIdentity,
        },
        name,
        answer,
        matrixReleases,
      )
      expect(projectReducerValue(name, adapted.value, catalog), name).toEqual({
        value: adapted.value,
      })
      expect(adapted.version, name).toBe(catalog.versions[name]!)
      expect(adapted.cursor).toBe(999)
      expect(JSON.stringify(answer)).toBe(before)
    }
    const value = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
    const broken = { version: 99, cursor: 7, value: null }
    expect(
      reducerValueForClient(
        {
          version: release.version,
          projects: release.projects ?? false,
          catalogIdentity: release.catalogIdentity,
        },
        'repositoryReadFacts',
        broken,
        matrixReleases,
      ),
    ).toBe(broken)
    const unknown = { ...broken, value }
    expect(
      reducerValueForClient({ version: release.version, projects: false }, 'constructor', unknown),
    ).toBe(unknown)
  })
}

test('current catalog preserves full fidelity without weakening released projections', () => {
  const answer = { version: 99, cursor: 4, value: { future: 'field' } }
  expect(
    reducerValueForClient(
      {
        version: AUTOBUILD_VERSION,
        projects: true,
        catalogIdentity: REDUCER_VALUE_CONTRACT_IDENTITY,
      },
      'build',
      answer,
    ),
  ).toBe(answer)
})

test('unrecognized source catalogs preserve canonical fields and event facts', () => {
  const answer = {
    version: 99,
    cursor: 4,
    value: {
      value: 'abc',
      addedAfter130: 'required by the source client',
      seenTypes: ['future.event'],
      lastEvent: { type: 'future.event' },
    },
  }
  expect(
    reducerValueForClient(
      { version: '1.3.0', projects: true, catalogIdentity: 'fingerprint-of-newer-main' },
      'recordedBaseShaValue',
      answer,
    ),
  ).toBe(answer)
})

import { MemoryBuildStore } from '../memory'
import { KERNEL } from '../../events/envelope'

for (const release of matrixReleases)
  test(`published ${release.version}: new latest-event discriminants are omitted only from optional display fields, including nested state`, async () => {
    const catalog = RELEASED_REDUCER_VALUES[release.contract!]!
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'released-new-event', repo: 'repo' })
    await store.append('released-new-event', {
      actor: KERNEL,
      type: 'node.restack-availability-observed',
      payload: {
        version: 1,
        fingerprint: 'fp',
        branch: 'node',
        parentBranch: 'main',
        head: 'head',
        parent: 'parent',
        base: 'base',
        available: ['head'],
      },
    })
    for (const reducer of ['build', 'buildReadFacts', 'buildStreamSeed']) {
      const answer = await store.getReducerValue(
        { kind: 'build', slug: 'released-new-event' },
        { reducer },
      )
      const before = JSON.stringify(answer)
      function futureEvents(input: unknown): unknown {
        if (Array.isArray(input)) return input.map(futureEvents)
        if (!input || typeof input !== 'object') return input
        return Object.fromEntries(
          Object.entries(input).map(([key, value]) => [
            key,
            key === 'lastEvent' && value && typeof value === 'object'
              ? { ...value, type: 'future.released-reader-unknown' }
              : key === 'seenTypes' && Array.isArray(value)
                ? [...value, 'future.released-reader-unknown']
                : futureEvents(value),
          ]),
        )
      }
      const input = { ...answer, value: futureEvents(answer.value) }
      const projected = reducerValueForClient(
        {
          version: release.version,
          projects: release.projects ?? false,
          catalogIdentity: release.catalogIdentity,
        },
        reducer,
        input,
        matrixReleases,
      )
      expect(projectReducerValue(reducer, projected.value, catalog)).toEqual({
        value: projected.value,
      })
      expect(projected.cursor).toBe(answer.cursor)
      function assertDisplay(input: unknown) {
        if (!input || typeof input !== 'object') return
        expect(input).not.toHaveProperty('lastEvent')
        for (const nested of Object.values(input))
          if (nested && typeof nested === 'object') assertDisplay(nested)
      }
      assertDisplay(projected.value)
      expect(JSON.stringify(answer)).toBe(before)
    }
    const { buildReducer } = await import('../../kernel/reducer')
    const state = buildReducer.finish(buildReducer.initial())
    const malformed = { ...state, lastEvent: { type: 'build.created' } }
    const broken = { version: 99, value: malformed }
    expect(
      reducerValueForClient(
        {
          version: release.version,
          projects: release.projects ?? false,
          catalogIdentity: release.catalogIdentity,
        },
        'build',
        broken,
        matrixReleases,
      ),
    ).toBe(broken)
  })

test('default and next-minor services admit only recorded historical protocols', () => {
  for (const service of ['1.3.0', '1.4.0']) {
    for (const client of ['1.2.0', '1.2.999', '1.3.0', '1.3.999'])
      expect(clientIdentityError(client, '6', service, '7')).toBeUndefined()
    expect(clientIdentityError('1.2.0', '7', service, '7')).toContain('unsupported protocol')
    expect(clientIdentityError(service, '7', service, '7')).toBeUndefined()
  }
})

test('health echoes only admitted same-line protocols with a published public default', () => {
  for (const [client, protocol, expected] of [
    [null, null, '6'],
    ['1.3.0', '6', '6'],
    ['1.3.0', '7', '7'],
    ['1.3.999', '7', '7'],
    ['1.2.0', '6', '6'],
    ['invalid', '7', '6'],
    ['1.3.0', 'invented', '6'],
    ['1.4.0', '7', '6'],
  ])
    expect(healthIdentity(client!, protocol!, '1.3.0', '7').protocolVersion).toBe(expected!)
  expect(healthIdentity(null, null, '1.4.0', '7').protocolVersion).toBe('7')
})

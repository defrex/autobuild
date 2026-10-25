import { describe, expect, test } from 'bun:test'
import { operatorInventory } from './operator-fixtures'
import {
  operatorCoverageManifest,
  operatorCoverageReport,
  operatorRoute,
  requireCompleteOperatorCoverage,
  checkOperatorCoverage,
  type OperatorOperationWitness,
  type OperatorInventory,
  documentedOperatorRoutes,
  requireCurrentOperatorInventory,
  operatorSourceClosureHash,
} from './operator-coverage'

const minimal: OperatorInventory = {
  routes: ['POST builds/:slug/control'],
  buildActions: ['pause'],
  answers: [],
  tools: [],
}
const positive: OperatorOperationWitness = {
  suite: 'controls',
  id: 'pause-running',
  method: 'POST',
  path: 'builds/seeded/control',
  requestBody: { action: 'pause' },
  status: 200,
  responseBody: { kind: 'command', command: 'pause' },
}
describe('native operator coverage completion gate', () => {
  test('real oracle fixtures cover actions and every answer without promoting the partial foundation to full parity', async () => {
    const manifest = await operatorCoverageManifest()
    const report = operatorCoverageReport(manifest.fixtures)
    expect(report.missingBuildActions).toEqual([])
    expect(report.missingAnswers).toEqual([])
    expect(report.missingTools).not.toContain('repository.settings')
    // These routes/tools require the actual helper HTTP traces, rather than
    // a schema entry, an unknown-build response, or a hardcoded inventory list.
    expect(report.missingRoutes).toContain('GET builds/:slug/artifacts/:kind')
    expect(report.missingRoutes).toContain('GET sessions/:sid/turns/:turn/stream')
    expect(report.missingRoutes).toContain('POST tickets')
    expect(report.missingTools).toContain('builds.artifact')
    expect(report.missingTools).toContain('tickets.tree')
    expect(() => requireCompleteOperatorCoverage(report)).toThrow('coverage incomplete')
    expect(manifest.required.control!.length).toBeGreaterThan(150)
    expect(manifest.required['registry-schemas']!.length).toBeGreaterThan(200)
  })
  test('auth, schema, unknown resource and internal outcomes cannot claim an operation', () => {
    const witnesses: OperatorOperationWitness[] = [
      {
        ...positive,
        id: 'invalid-body',
        status: 400,
        responseBody: { kind: 'validation', error: 'unknown field' },
      },
      {
        ...positive,
        id: 'no-authority',
        status: 403,
        responseBody: { kind: 'auth', error: 'wrong project' },
      },
      {
        ...positive,
        id: 'missing-build',
        status: 404,
        responseBody: { kind: 'not-found', error: 'unknown build' },
      },
      {
        ...positive,
        id: 'unavailable',
        status: 500,
        responseBody: { kind: 'internal', error: 'unavailable' },
      },
      {
        ...positive,
        id: 'identity-window',
        status: 409,
        responseBody: { kind: 'conflict', error: 'remote store version mismatch: client' },
      },
    ]
    const report = operatorCoverageReport(witnesses, { inventory: minimal })
    expect(report.counts.qualifiedWitnesses).toBe(0)
    expect(report.missingBuildActions).toEqual(['pause'])
    expect(report.missingRoutes).toEqual(minimal.routes)
  })
  test('an applicable policy refusal counts while an inventory or schema string never does', () => {
    const report = operatorCoverageReport(
      [
        {
          ...positive,
          status: 409,
          responseBody: { kind: 'refusal', code: 'inactive', error: 'pause already pending' },
        },
      ],
      { inventory: minimal },
    )
    expect(requireCompleteOperatorCoverage(report).missingRoutes).toEqual([])
    const empty = operatorCoverageReport([], { inventory: minimal })
    expect(empty.counts.qualifiedWitnesses).toBe(0)
  })
  test('oracle results require matching completed native case IDs and all required suites', () => {
    const skipped = operatorCoverageReport([positive], {
      inventory: minimal,
      executed: { controls: [] },
      required: { controls: ['pause-running'] },
    })
    expect(skipped.missingCases.controls).toEqual(['pause-running'])
    expect(skipped.missingBuildActions).toEqual(['pause'])
    expect(() => requireCompleteOperatorCoverage(skipped)).toThrow('coverage incomplete')
    const complete = operatorCoverageReport([positive], {
      inventory: minimal,
      executed: { controls: ['pause-running'] },
      required: { controls: ['pause-running'] },
    })
    expect(requireCompleteOperatorCoverage(complete).counts.qualifiedWitnesses).toBe(1)
  })
  test('a skipped refusal/schema case blocks completion even when every operation already has a positive witness', () => {
    const report = operatorCoverageReport([positive], {
      inventory: minimal,
      executed: { controls: ['pause-running'] },
      required: { controls: ['pause-running', 'strict-unknown-field'] },
    })
    expect(report.missingRoutes).toEqual([])
    expect(report.missingBuildActions).toEqual([])
    expect(() => requireCompleteOperatorCoverage(report)).toThrow('strict-unknown-field')
  })
  test('documented routes and canonical action/answer schemas cannot drift behind the inventory', () => {
    const inventory = operatorInventory()
    expect(documentedOperatorRoutes().length).toBeGreaterThan(25)
    expect(requireCurrentOperatorInventory()).toEqual(inventory)
    expect(() =>
      requireCurrentOperatorInventory({
        ...inventory,
        routes: inventory.routes.filter((route) => route !== 'GET dashboard'),
      }),
    ).toThrow('GET dashboard')
  })
  test('path classification preserves literal routes and finds the canonical tool name', () => {
    expect(operatorRoute('GET', 'tickets/states')).toBe('GET tickets/states')
    expect(operatorRoute('GET', 'tickets/ENG-1')).toBe('GET tickets/:id')
    expect(
      operatorRoute(
        'GET',
        'http://proof/operator/v1/repos/acme%2Fapp/builds/one/artifacts/spec?rev=0',
      ),
    ).toBe('GET builds/:slug/artifacts/:kind')
    expect(operatorRoute('POST', 'tools/repository.settings')).toBe('POST tools/:tool')
    const report = operatorCoverageReport([
      {
        ...positive,
        path: 'tools/repository.setting',
        requestBody: { repo: 'r', setting: 'intake' },
        responseBody: { enabled: false },
      },
    ])
    expect(report.missingTools).toContain('repository.settings')
    expect(report.counts.tools).toBe(operatorInventory().tools.length)
  })
  test('stale run evidence is refused before any fixture can claim completion', async () => {
    await expect(
      checkOperatorCoverage({
        format: 1,
        sourceClosureSha256: 'stale',
        proofSourcesSha256: 'stale',
        suites: {},
      }),
    ).rejects.toThrow('stale TypeScript oracle')
    await expect(
      checkOperatorCoverage({
        format: 1,
        sourceClosureSha256: operatorSourceClosureHash(),
        proofSourcesSha256: 'stale',
        suites: {},
      }),
    ).rejects.toThrow('stale native/proof/fixture')
  })
})

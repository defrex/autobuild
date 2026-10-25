/** Completion gate for native operator parity. A route inventory, an accepted
 * schema or an auth/validation failure cannot stand in for an executed domain
 * operation. Fixture witnesses count only when the native replay recorded the
 * same case; helper-only probes supply their asserted runtime request/result. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { sources, experiment, root } from './fixture-core'
import {
  buildControlRequestSchema,
  answerRequestSchema,
} from '../../../packages/core/src/operator/protocol'
import {
  operatorInventory,
  checkOperatorCorpus,
  operatorRepo,
  type OperatorCorpus,
} from './operator-fixtures'
import { checkControlCorpus } from './control-fixtures'
import { checkApiReadCorpus } from './api-read-fixtures'
import { checkAdvancedCorpus } from './advanced-control-fixtures'
import { checkRegistryContract } from './registry-fixtures'
import { registryDomainScenarios } from './registry-domain-integration'
import { repositoryControlCaseIds } from './repository-control-integration'
import { answerFailureCaseIds } from './answer-failure-integration'
import { delegationSeamScenarios } from './delegation-integration'
import { sessionConfigCases } from './session-config-integration'
import { ticketHttpScenarios } from './ticket-integration'
import type { OperatorCoverageEvidence, OperatorOperationWitness } from './operator-coverage-types'
export type { OperatorCoverageEvidence, OperatorOperationWitness } from './operator-coverage-types'

export const operatorReadCaseIds = [
  'builds:active',
  'builds:queued',
  'builds:all',
  'builds:invalid-scope',
  'artifacts:binary-revisions',
  'sessions:open-closed-stream',
] as const
export type OperatorInventory = ReturnType<typeof operatorInventory>
export interface OperatorCoverageReport {
  format: 1
  counts: {
    routes: number
    actions: number
    answers: number
    tools: number
    qualifiedWitnesses: number
  }
  missingRoutes: string[]
  missingBuildActions: string[]
  missingAnswers: string[]
  missingTools: string[]
  missingCases: Record<string, string[]>
  witnesses: {
    routes: Record<string, string[]>
    actions: Record<string, string[]>
    answers: Record<string, string[]>
    tools: Record<string, string[]>
  }
  rejected: { suite: string; id: string; reason: string }[]
  suites: Record<string, { expected: number; executed: number }>
}
export function documentedOperatorRoutes() {
  const document = readFileSync(resolve(root, 'docs/operator-api.md'), 'utf8')
  return [
    ...new Set(
      [...document.matchAll(/`(GET|POST|PUT|PATCH|DELETE) …\/([^`]+)`/g)].map(
        (match) => `${match[1]} ${match[2]!.split('?')[0]!.replaceAll(/\{([^}]+)\}/g, ':$1')}`,
      ),
    ),
  ].sort()
}
export function requireCurrentOperatorInventory(
  inventory: OperatorInventory = operatorInventory(),
) {
  const missing = documentedOperatorRoutes().filter((route) => !inventory.routes.includes(route))
  const actions = buildControlRequestSchema.options
    .map((option) => option.shape.action.value)
    .sort()
  const answers = answerRequestSchema.options
    .map((option) => {
      const shape = option.shape
      return shape.resolution.value === 'revise-spec' && 'origin' in shape
        ? `revise-spec:${shape.origin.value}`
        : shape.resolution.value
    })
    .sort()
  if (
    missing.length ||
    JSON.stringify(actions) !== JSON.stringify([...inventory.buildActions].sort()) ||
    JSON.stringify(answers) !== JSON.stringify([...inventory.answers].sort())
  )
    throw new Error(
      `Operator inventory drift: ${JSON.stringify({ missingDocumentedRoutes: missing, actions, answers })}`,
    )
  return inventory
}
export function operatorSourceClosureHash() {
  return createHash('sha256').update(JSON.stringify(sources())).digest('hex')
}
function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name), pattern)
      : pattern.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  )
}
export function operatorProofSourceHash() {
  const paths = [
    ...files(resolve(experiment, 'src'), /\.rs$/),
    ...files(resolve(experiment, 'tools'), /\.(?:ts|json)$/),
    ...files(resolve(experiment, 'fixtures'), /\.json$/),
    ...['Cargo.toml', 'Cargo.lock', 'build.rs'].map((name) => resolve(experiment, name)),
  ].sort()
  return createHash('sha256')
    .update(
      JSON.stringify(
        paths.map((path) => [
          relative(experiment, path),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]),
      ),
    )
    .digest('hex')
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function operationRefusal(witness: OperatorOperationWitness): boolean {
  const body = object(witness.responseBody)
  if (witness.status >= 200 && witness.status < 300)
    return !['auth', 'validation', 'internal', 'not-found'].includes(String(body.kind))
  if (witness.status !== 409 || !['refusal', 'conflict'].includes(String(body.kind))) return false
  return !(
    typeof body.error === 'string' && body.error.startsWith('remote store version mismatch:')
  )
}
export function operatorRoute(
  method: string,
  path: string,
  inventory: OperatorInventory = operatorInventory(),
): string | undefined {
  let segments: string[]
  try {
    const raw =
      path.startsWith('http:') || path.startsWith('https:')
        ? new URL(path).pathname
        : path.split('?')[0]!
    segments = raw.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
  if (segments[0] === 'operator' && segments[1] === 'v1' && segments[2] === 'repos')
    segments = segments.slice(4)
  return [...inventory.routes]
    .sort(
      (a, b) =>
        b.split('/').filter((s) => !s.startsWith(':')).length -
        a.split('/').filter((s) => !s.startsWith(':')).length,
    )
    .find((route) => {
      const separator = route.indexOf(' ')
      if (route.slice(0, separator) !== method.toUpperCase()) return false
      const pattern = route.slice(separator + 1).split('/')
      return (
        pattern.length === segments.length &&
        pattern.every((part, index) =>
          part.startsWith(':') ? !!segments[index] : part === segments[index],
        )
      )
    })
}
/** Pure aggregation used by the gate and its adversarial coverage tests. */
export function operatorCoverageReport(
  witnesses: readonly OperatorOperationWitness[],
  options: {
    inventory?: OperatorInventory
    executed?: Record<string, readonly string[]>
    required?: Record<string, readonly string[]>
  } = {},
): OperatorCoverageReport {
  const inventory = options.inventory ?? operatorInventory()
  const maps = {
    routes: {} as Record<string, string[]>,
    actions: {} as Record<string, string[]>,
    answers: {} as Record<string, string[]>,
    tools: {} as Record<string, string[]>,
  }
  const rejected: OperatorCoverageReport['rejected'] = []
  let qualified = 0
  const add = (map: Record<string, string[]>, key: string, label: string) => {
    map[key] ??= []
    map[key].push(label)
  }
  for (const witness of witnesses) {
    const label = `${witness.suite}/${witness.id}`
    if (options.executed && !options.executed[witness.suite]?.includes(witness.id)) {
      rejected.push({
        suite: witness.suite,
        id: witness.id,
        reason: 'not replayed by native HTTP proof',
      })
      continue
    }
    if (!operationRefusal(witness)) {
      rejected.push({
        suite: witness.suite,
        id: witness.id,
        reason: 'admission, validation, unknown-resource or internal outcome',
      })
      continue
    }
    const route = operatorRoute(witness.method, witness.path, inventory)
    if (!route) {
      rejected.push({
        suite: witness.suite,
        id: witness.id,
        reason: 'outside documented operator inventory',
      })
      continue
    }
    qualified++
    add(maps.routes, route, label)
    const body = object(witness.requestBody)
    const segments = witness.path.split('?')[0]!.split('/').filter(Boolean)
    const tool = route === 'POST tools/:tool' ? decodeURIComponent(segments.at(-1)!) : undefined
    if (tool && inventory.tools.some((name) => name === tool)) add(maps.tools, tool, label)
    if (route === 'POST builds/:slug/control' || tool === 'builds.control') {
      if (typeof body.action === 'string' && inventory.buildActions.includes(body.action))
        add(maps.actions, body.action, label)
    }
    if (route === 'POST builds/:slug/answer' || tool === 'builds.answer') {
      const answer =
        body.resolution === 'revise-spec' ? `revise-spec:${body.origin}` : body.resolution
      if (typeof answer === 'string' && inventory.answers.includes(answer))
        add(maps.answers, answer, label)
    }
  }
  const missingCases: Record<string, string[]> = {}
  const suites: OperatorCoverageReport['suites'] = {}
  for (const [suite, required] of Object.entries(options.required ?? {})) {
    const executed = new Set(options.executed?.[suite] ?? [])
    const missing = required.filter((id) => !executed.has(id))
    if (missing.length) missingCases[suite] = [...missing]
    suites[suite] = {
      expected: new Set(required).size,
      executed: [...new Set(required)].filter((id) => executed.has(id)).length,
    }
  }
  return {
    format: 1,
    counts: {
      routes: inventory.routes.length,
      actions: inventory.buildActions.length,
      answers: inventory.answers.length,
      tools: inventory.tools.length,
      qualifiedWitnesses: qualified,
    },
    missingRoutes: inventory.routes.filter((v) => !maps.routes[v]),
    missingBuildActions: inventory.buildActions.filter((v) => !maps.actions[v]),
    missingAnswers: inventory.answers.filter((v) => !maps.answers[v]),
    missingTools: inventory.tools.filter((v) => !maps.tools[v]),
    missingCases,
    witnesses: maps,
    rejected,
    suites,
  }
}
export function requireCompleteOperatorCoverage(report: OperatorCoverageReport) {
  if (
    report.missingRoutes.length ||
    report.missingBuildActions.length ||
    report.missingAnswers.length ||
    report.missingTools.length ||
    Object.keys(report.missingCases).length
  )
    throw new Error(
      `Native operator coverage incomplete: ${JSON.stringify({ routes: report.missingRoutes, actions: report.missingBuildActions, answers: report.missingAnswers, tools: report.missingTools, cases: report.missingCases })}`,
    )
  return report
}
export async function operatorCoverageManifest() {
  requireCurrentOperatorInventory()
  const foundation: OperatorCorpus = JSON.parse(
    readFileSync(resolve(experiment, 'fixtures/operator-corpus.json'), 'utf8'),
  )
  await checkOperatorCorpus(foundation)
  const [controls, reads, advanced, registry] = await Promise.all([
    checkControlCorpus(),
    checkApiReadCorpus(),
    checkAdvancedCorpus(),
    checkRegistryContract(),
  ])
  const fixtures: OperatorOperationWitness[] = []
  const sessions = foundation.fixtures.filter((f) => f.scenario.route.includes('sessions'))
  for (const fixture of sessions)
    for (const result of fixture.observations)
      fixtures.push({
        suite: 'operator-sessions',
        id: fixture.scenario.id,
        method: result.request.method,
        path: result.request.path,
        requestBody: result.request.body,
        status: result.status,
        responseBody: result.body,
      })
  for (const fixture of controls.fixtures)
    fixtures.push({
      suite: 'control',
      id: fixture.scenario.id,
      method: fixture.scenario.method ?? 'POST',
      path: fixture.scenario.path,
      requestBody: fixture.scenario.body,
      status: fixture.status,
      responseBody: fixture.body,
    })
  for (const fixture of reads.fixtures)
    fixtures.push({
      suite: 'api-reads',
      id: fixture.scenario.id,
      method: 'GET',
      path: fixture.scenario.path,
      status: fixture.status,
      responseBody: fixture.body,
    })
  for (const fixture of advanced.fixtures)
    fixtures.push({
      suite: 'advanced',
      id: fixture.id,
      method: 'POST',
      path: fixture.request.path,
      requestBody: fixture.request.body,
      status: fixture.status,
      responseBody: fixture.body,
    })
  for (const [index, result] of registry.outcomes.entries())
    fixtures.push({
      suite: 'registry',
      id: `${result.name}:${index}`,
      method: 'POST',
      path: `tools/${result.name}`,
      requestBody: result.input,
      status:
        'error' in result
          ? ({
              validation: 400,
              auth: 403,
              'not-found': 404,
              conflict: 409,
              refusal: 409,
              internal: 500,
            }[result.error?.kind ?? 'internal'] ?? 500)
          : 200,
      responseBody: 'error' in result ? result.error : result.result,
    })
  const registrySchemas = registry.cases.flatMap((entry, index) =>
    'error' in entry &&
    entry.input &&
    typeof entry.input === 'object' &&
    'repo' in entry.input &&
    entry.input.repo === operatorRepo
      ? [`${entry.name}:${index}`]
      : [],
  )
  const required: Record<string, readonly string[]> = {
    'operator-sessions': sessions.map((f) => f.scenario.id),
    control: controls.fixtures.map((f) => f.scenario.id),
    'api-reads': reads.fixtures.map((f) => f.scenario.id),
    advanced: advanced.fixtures.map((f) => f.id),
    registry: registry.outcomes.map((f, index) => `${f.name}:${index}`),
    'registry-schemas': registrySchemas,
    'registry-domains': registryDomainScenarios().map((f) => f.id),
    'repository-controls': repositoryControlCaseIds,
    'answer-failures': answerFailureCaseIds,
    delegation: [
      ...delegationSeamScenarios().map((f) => f.id),
      'unconfigured-issuance-unavailable',
    ],
    'session-config': sessionConfigCases,
    'operator-reads': operatorReadCaseIds,
    'ticket-http': ticketHttpScenarios().map((probe) => probe.id),
  }
  return { fixtures, required, registrySchemas }
}
export async function checkOperatorCoverage(evidence: OperatorCoverageEvidence) {
  if (evidence.format !== 1 || evidence.sourceClosureSha256 !== operatorSourceClosureHash())
    throw new Error('Native operator coverage evidence uses stale TypeScript oracle sources')
  if (evidence.proofSourcesSha256 !== operatorProofSourceHash())
    throw new Error(
      'Native operator coverage evidence uses stale native/proof/fixture sources; rerun native proofs',
    )
  const manifest = await operatorCoverageManifest()
  for (const witness of evidence.operationWitnesses ?? []) {
    if (!manifest.required[witness.suite]?.includes(witness.id))
      throw new Error(
        `Unknown operator coverage witness ${witness.suite}/${witness.id}; only executable suite manifest cases may cover operations`,
      )
  }
  const witnesses = [...manifest.fixtures, ...(evidence.operationWitnesses ?? [])]
  return requireCompleteOperatorCoverage(
    operatorCoverageReport(witnesses, { executed: evidence.suites, required: manifest.required }),
  )
}
if (import.meta.main) {
  const index = process.argv.indexOf('--evidence')
  const path = index < 0 ? undefined : process.argv[index + 1]
  if (!path)
    throw new Error(
      'operator-coverage requires --evidence <completed-native-proof.json>; inventories and schemas alone cannot complete coverage',
    )
  const report = await checkOperatorCoverage(
    JSON.parse(readFileSync(path, 'utf8')) as OperatorCoverageEvidence,
  )
  console.log(JSON.stringify(report))
}

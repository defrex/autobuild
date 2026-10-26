/** TypeScript HTTP oracle for native build/repository control parity. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import type { EventWrite } from '../../../packages/core/src/events/catalog'
import { KERNEL, DISPATCHER, agentActor } from '../../../packages/core/src/events/envelope'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { sources, experiment } from './fixture-core'
import { operatorClock, operatorRepo } from './operator-fixtures'

const clock = () => new Date(operatorClock)
const secret = 'offline-operator-fixture-secret'
const corpusPath = resolve(experiment, 'fixtures/control-corpus.json')
const slug = 'control-build'
type Seed =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'blocked'
  | 'paused-blocked'
  | 'aborting'
  | 'done'
  | 'landing'
  | 'finding'
  | 'review-limit'
interface ControlScenario {
  id: string
  seed: Seed
  path: string
  body?: unknown
  rawBody?: string
  method?: string
}
export function controlScenarios(): ControlScenario[] {
  const controls = ['pause', 'cancel-pause', 'resume', 'abort', 'discard', 'land', 'hold']
  const scenarios: ControlScenario[] = controls.flatMap((action) =>
    (['queued', 'running', 'pausing', 'paused', 'blocked', 'done'] as Seed[]).map((seed) => ({
      id: `${action}-${seed}`,
      seed,
      path: `builds/${slug}/control`,
      body: { action },
    })),
  )
  scenarios.push(
    { id: 'land-ready', seed: 'landing', path: `builds/${slug}/control`, body: { action: 'land' } },
    {
      id: 'resume-paused-blocked',
      seed: 'paused-blocked',
      path: `builds/${slug}/control`,
      body: { action: 'resume' },
    },
    { id: 'restack-leaf', seed: 'running', path: `builds/${slug}/restack` },
  )
  for (const resolution of [
    'guidance',
    'retry',
    'dismiss',
    'review-round-ceiling',
    'revise-spec',
  ]) {
    for (const seed of ['blocked', 'paused-blocked', 'running', 'aborting'] as Seed[]) {
      const body =
        resolution === 'guidance'
          ? { resolution, text: 'Continue with care' }
          : resolution === 'review-round-ceiling'
            ? { resolution, ceiling: 4 }
            : resolution === 'revise-spec'
              ? { resolution, origin: 'body', body: 'missing sections' }
              : { resolution }
      scenarios.push({
        id: `answer-${resolution}-${seed}`,
        seed,
        path: `builds/${slug}/answer`,
        body,
      })
    }
  }
  scenarios.push(
    {
      id: 'answer-dismiss-finding',
      seed: 'finding',
      path: `builds/${slug}/answer`,
      body: { resolution: 'dismiss' },
    },
    {
      id: 'answer-review-limit-json-number',
      seed: 'review-limit',
      path: `builds/${slug}/answer`,
      body: { resolution: 'review-round-ceiling', ceiling: 5 },
      rawBody: '{"resolution":"review-round-ceiling","ceiling":5.0}',
    },
    {
      id: 'answer-review-limit',
      seed: 'review-limit',
      path: `builds/${slug}/answer`,
      body: { resolution: 'review-round-ceiling', ceiling: 5 },
    },
    {
      id: 'answer-revise-valid',
      seed: 'blocked',
      path: `builds/${slug}/answer`,
      body: {
        resolution: 'revise-spec',
        origin: 'body',
        body: '## Acceptance criteria\n- Replacement works\n## Out of scope\nNone',
      },
    },
    {
      id: 'intake-set',
      seed: 'running',
      method: 'PUT',
      path: 'settings/intake',
      body: { enabled: false },
    },
    { id: 'intake-toggle', seed: 'running', path: 'settings/intake/toggle' },
    { id: 'intake-retired-toggle', seed: 'running', path: 'settings/auto-merge-default/toggle' },
    {
      id: 'intake-retired',
      seed: 'running',
      method: 'PUT',
      path: 'settings/auto-merge-default',
      body: { enabled: false },
    },
    {
      id: 'harvest-toggle',
      seed: 'running',
      path: 'harvest/control',
      body: { action: 'toggle-gate' },
    },
    {
      id: 'harvest-stale',
      seed: 'running',
      path: 'harvest/control',
      body: { action: 'run', run: 'gone' },
    },
    { id: 'bulk-pause', seed: 'running', path: 'bulk-control', body: { action: 'pause' } },
    { id: 'bulk-resume', seed: 'paused', path: 'bulk-control', body: { action: 'resume' } },
    {
      id: 'bulk-preserve-pausing',
      seed: 'pausing',
      path: 'bulk-control',
      body: { action: 'pause' },
    },
    {
      id: 'bulk-preserve-blocker',
      seed: 'paused-blocked',
      path: 'bulk-control',
      body: { action: 'resume' },
    },
  )
  const toolScenarios = scenarios
    .filter((s) => s.rawBody === undefined)
    .map((scenario): ControlScenario => {
      const body = { ...(scenario.body as Record<string, unknown> | undefined), repo: operatorRepo }
      let name: string
      if (scenario.path.startsWith('builds/')) {
        name = `builds.${scenario.path.split('/')[2]}`
        Object.assign(body, { slug })
      } else if (scenario.path.startsWith('settings/')) {
        name = 'repository.settings'
        Object.assign(body, { setting: scenario.path.split('/')[1] })
      } else if (scenario.path === 'bulk-control') name = 'repository.bulk_control'
      else name = 'harvest.control'
      return { ...scenario, id: `tool-${scenario.id}`, method: 'POST', path: `tools/${name}`, body }
    })
  const mergeScenarios = toolScenarios
    .filter((s) => (s.body as { action?: string }).action === 'land')
    .map((s) => ({
      ...s,
      id: s.id.replace('tool-land-', 'tool-merge-'),
      body: { ...(s.body as object), action: 'merge' },
    }))
  return [...scenarios, ...toolScenarios, ...mergeScenarios]
}
export async function replayControlScenario(scenario: ControlScenario) {
  const store = new MemoryBuildStore({ clock })
  const created = buildCreatedWrite()
  created.payload.repo = operatorRepo
  await store.createBuild({ slug, repo: operatorRepo, created })
  await store.ensureRepo(operatorRepo)
  const append = (write: EventWrite) => store.append(slug, write)
  if (scenario.seed !== 'queued')
    await append({
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'test-runner', host: 'test-host', resumedFromSeq: 0 },
    })
  if (['pausing', 'paused', 'paused-blocked'].includes(scenario.seed))
    await append({
      actor: { kind: 'human', user: 'earlier-operator' },
      type: 'build.pause-requested',
      payload: {},
    })
  if (['paused', 'paused-blocked'].includes(scenario.seed))
    await append({ actor: KERNEL, type: 'build.paused', payload: {} })
  if (['blocked', 'paused-blocked', 'aborting'].includes(scenario.seed))
    await append({
      actor: agentActor('implement', 'session-test'),
      type: 'escalation.raised',
      payload: {
        id: 'esc-control',
        phase: 'implement',
        round: 1,
        source: 'agent',
        question: 'What next?',
      },
    })
  if (scenario.seed === 'finding') {
    await append({
      actor: agentActor('code-review', 'review-test'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [{ id: 'f_real', severity: 'blocking', summary: 'real issue', persists: [] }],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    await append({
      actor: agentActor('implement', 'session-test'),
      type: 'escalation.raised',
      payload: {
        id: 'esc-finding',
        phase: 'implement',
        round: 1,
        source: 'stall',
        question: 'Dismiss?',
        refs: ['f_real'],
      },
    })
  }
  if (scenario.seed === 'review-limit')
    await append({
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc-rounds',
        phase: 'plan-review',
        round: 4,
        source: 'policy',
        policyCause: 'review-round-limit',
        question: 'round limit',
      },
    })
  if (scenario.seed === 'aborting')
    await append({
      actor: { kind: 'human', user: 'earlier-operator' },
      type: 'build.abort-requested',
      payload: {},
    })
  if (scenario.seed === 'done')
    await append({ actor: DISPATCHER, type: 'build.completed', payload: { outcome: 'merged' } })
  if (scenario.seed === 'landing') {
    await append({
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
    })
    await append({
      actor: DISPATCHER,
      type: 'landing.decided',
      payload: {
        candidate: { head: 'head', parent: 'base', cycle: '1' },
        from: 'leaf',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
      },
    })
  }
  const snapshot = async () => {
    const events = await store.getEvents(slug)
    return {
      record: await store.getBuild(slug),
      events,
      state: encodeReducerValue(reduceBuild(events)),
      repository: await store.getRepoEvents(operatorRepo),
    }
  }
  const before = await snapshot()
  const server = createOperatorServer({
    store,
    projects: testProjects([operatorRepo]),
    secret,
    clock,
  })
  const headers = {
    authorization: `Bearer ${mintToken(secret, { version: 1, internalOperator: { user: 'operator@example.com', repo: operatorRepo }, exp: clock().getTime() + 60_000 })}`,
    'x-autobuild-version': AUTOBUILD_VERSION,
    'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
    'content-type': 'application/json',
  }
  const response = await server.fetch(
    new Request(
      `https://fixture.invalid/operator/v1/repos/${encodeURIComponent(operatorRepo)}/${scenario.path}`,
      {
        method: scenario.method ?? 'POST',
        headers,
        ...(scenario.rawBody !== undefined
          ? { body: scenario.rawBody }
          : scenario.body === undefined
            ? {}
            : { body: JSON.stringify(scenario.body) }),
      },
    ),
  )
  return {
    scenario,
    seed: before,
    status: response.status,
    body: (await response.json()) as unknown,
    after: await snapshot(),
  }
}
export async function generateControlCorpus() {
  return {
    format: 1,
    clock: operatorClock,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(sources()))
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    fixtures: await Promise.all(controlScenarios().map(replayControlScenario)),
  }
}
export async function checkControlCorpus() {
  const generated = await generateControlCorpus()
  if (!isDeepStrictEqual(generated, JSON.parse(readFileSync(corpusPath, 'utf8'))))
    throw new Error('Control oracle corpus is stale; regenerate control-fixtures.ts')
  return generated
}
if (import.meta.main) {
  if (!process.argv.includes('--write')) await checkControlCorpus()
  else writeFileSync(corpusPath, `${JSON.stringify(await generateControlCorpus(), null, 2)}\n`)
}

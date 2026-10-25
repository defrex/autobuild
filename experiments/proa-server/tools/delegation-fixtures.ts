/** Exact delegation issuance oracle from the TypeScript handler. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { createDelegationHandler } from '../../../packages/hosted-store-service/src/delegated-authority'
import type { MachinePrincipal } from '../../../packages/hosted-store-service/src/machine-auth'
import type { DelegatedTokenScope } from '../../../packages/core/src/store/remote/token'
import { sources, experiment } from './fixture-core'
import { operatorClock, operatorRepo } from './operator-fixtures'
const corpusPath = resolve(experiment, 'fixtures/delegation-corpus.json')
const secret = 'delegation-native-oracle'
const clock = () => new Date(operatorClock)
export async function generateDelegationCorpus() {
  const admin: MachinePrincipal = { kind: 'admin', user: 'owner' }
  const internal: MachinePrincipal = { kind: 'internal', user: 'operator', repo: operatorRepo }
  const delegated = (
    kind: DelegatedTokenScope['delegation']['kind'],
    anchor: number,
  ): MachinePrincipal => ({
    kind: 'delegated',
    repo: operatorRepo,
    user: 'delegated',
    delegation: {
      repo: operatorRepo,
      kind,
      id: kind.startsWith('build') ? 'build' : 'run',
      anchor,
      ...(kind.startsWith('harvest') ? { execution: 'execution', leaseHolder: 'dispatcher' } : {}),
    },
  })
  const buildRunner = { kind: 'build-runner', id: 'build' }
  const buildPhase = { kind: 'build-phase', id: 'build', session: 'phase' }
  const harvestRunner = {
    kind: 'harvest-runner',
    id: 'run',
    repo: operatorRepo,
    execution: 'execution',
    leaseHolder: 'dispatcher',
  }
  const harvestPhase = {
    kind: 'harvest-phase',
    id: 'run',
    repo: operatorRepo,
    session: 'harvest-phase',
  }
  const scenarios = [
    { id: 'admin-build-runner', principal: admin, target: buildRunner },
    { id: 'admin-build-phase', principal: admin, target: buildPhase },
    { id: 'internal-refused', principal: internal, target: buildRunner },
    {
      id: 'foreign-project',
      principal: { ...internal, repo: 'foreign/repo' },
      target: buildRunner,
    },
    { id: 'runner-narrows', principal: delegated('build-runner', 2), target: buildPhase },
    { id: 'runner-cannot-widen', principal: delegated('build-runner', 2), target: buildRunner },
    { id: 'phase-cannot-delegate', principal: delegated('build-phase', 3), target: buildPhase },
    { id: 'session-predates', principal: delegated('build-runner', 4), target: buildPhase },
    { id: 'missing-session', principal: admin, target: { ...buildPhase, session: 'missing' } },
    { id: 'terminal-build', principal: admin, target: buildRunner, ended: true },
    { id: 'admin-harvest-runner', principal: admin, target: harvestRunner },
    {
      id: 'harvest-wrong-holder',
      principal: admin,
      target: { ...harvestRunner, leaseHolder: 'wrong' },
    },
    { id: 'harvest-phase-without-execution', principal: admin, target: harvestPhase },
    {
      id: 'harvest-runner-narrows',
      principal: delegated('harvest-runner', 2),
      target: harvestPhase,
    },
    {
      id: 'harvest-suspended',
      principal: delegated('harvest-runner', 2),
      target: harvestPhase,
      suspended: true,
    },
    {
      id: 'harvest-stale-authorization',
      principal: admin,
      target: { ...harvestRunner, execution: 'old' },
    },
  ]
  const fixtures = await Promise.all(
    scenarios.map(async (scenario) => {
      const store = new MemoryBuildStore({ clock })
      const created = buildCreatedWrite()
      created.payload.repo = operatorRepo
      await store.createBuild({ slug: 'build', repo: operatorRepo, created })
      await store.append('build', {
        actor: { kind: 'kernel' },
        type: 'runner.attached',
        payload: { instance: 'runner', host: 'host', resumedFromSeq: 0 },
      })
      await store.append('build', {
        actor: { kind: 'kernel' },
        type: 'session.started',
        payload: {
          session: 'phase',
          role: 'implement',
          runner: 'fake',
          phase: 'implement',
          round: 1,
        },
      })
      await store.ensureRepo(operatorRepo)
      await store.claimRepoLease(operatorRepo, 'dispatcher', 60_000)
      await store.appendRepo(operatorRepo, {
        actor: { kind: 'kernel' },
        type: 'harvest.started',
        payload: {
          run: 'run',
          observations: [{ build: 'build', seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 0 },
        },
      })
      await store.appendRepo(operatorRepo, {
        actor: { kind: 'dispatcher' },
        type: 'harvest.execution.authorized',
        payload: {
          execution: 'execution',
          run: 'run',
          launch: 'started',
          leaseHolder: 'dispatcher',
        },
      })
      await store.appendRepo(operatorRepo, {
        actor: { kind: 'kernel' },
        type: 'harvest.session.started',
        payload: {
          run: 'run',
          session: 'harvest-phase',
          role: 'harvest',
          runner: 'fake',
          args: [],
          step: 'synthesize',
          round: 1,
        },
      })
      if (scenario.ended)
        await store.append('build', {
          actor: { kind: 'kernel' },
          type: 'build.aborted',
          payload: {},
        })
      if (scenario.suspended)
        await store.appendRepo(operatorRepo, {
          actor: { kind: 'kernel' },
          type: 'harvest.session.suspended',
          payload: {
            run: 'run',
            session: 'harvest-phase',
            cause: 'shutdown',
            transcript: { kind: 'transcript', rev: 0 },
          },
        })
      const now = scenario.ended ? new Date(clock().getTime() + 60_000) : clock()
      const handler = createDelegationHandler({
        store,
        secret,
        clock: () => now,
        auth: { authenticate: async () => scenario.principal },
      })
      const response = await handler(
        new Request('https://fixture.invalid/credentials/delegate', {
          method: 'POST',
          body: JSON.stringify(scenario.target),
        }),
      )
      const build = scenario.target.kind.startsWith('build')
      const facts = await store.getReducerValue(
        build ? { kind: 'build', slug: 'build' } : { kind: 'repo', repo: operatorRepo },
        { reducer: build ? 'buildDelegation' : 'harvestDelegation' },
      )
      return {
        scenario,
        secret,
        now: now.toISOString(),
        repo: operatorRepo,
        leaseHolder: 'dispatcher',
        facts: encodeReducerValue(facts.value),
        status: response.status,
        body: (await response.json()) as unknown,
      }
    }),
  )
  return {
    format: 1,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(sources()))
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    fixtures,
  }
}
export async function checkDelegationCorpus() {
  const generated = await generateDelegationCorpus()
  if (!isDeepStrictEqual(generated, JSON.parse(readFileSync(corpusPath, 'utf8'))))
    throw new Error('Delegation oracle corpus is stale')
  return generated
}
if (import.meta.main) {
  if (!process.argv.includes('--write')) await checkDelegationCorpus()
  else writeFileSync(corpusPath, `${JSON.stringify(await generateDelegationCorpus(), null, 2)}\n`)
}

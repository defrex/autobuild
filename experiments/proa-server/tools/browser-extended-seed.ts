/** Isolated seeds for every extra browser form. The read-only TS producers are
 * the oracle; each operation gets its own project so bulk writes cannot leak
 * into a neighbouring proof or screenshot. */
import type { SQL } from 'bun'
import type { Actor } from '../../../packages/core/src/events/envelope'
import { resolve } from 'node:path'
import { validateEventWrite, type EventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import type { ApiReadCorpus } from './api-read-fixtures'
import type { checkControlCorpus } from './control-fixtures'
import type { checkAdvancedCorpus } from './advanced-control-fixtures'
import { advancedLifecycle } from './advanced-control-fixtures'
import { operatorRepo } from './operator-fixtures'

export const extendedBrowserActions = [
  'intake',
  'pause-all',
  'resume-all',
  'harvest',
  'harvest-resume',
  'harvest-acknowledge',
  'review-round-ceiling',
  'revise-body',
  'revise-ticket',
] as const
export type ExtendedBrowserAction = (typeof extendedBrowserActions)[number]
export interface ExtendedBrowserFixture {
  mode: 'js' | 'nojs'
  action: ExtendedBrowserAction
  project: string
  slug: string
  build: string
  button: string
  text?: string
  ceiling?: string
  expectedBuildTypes: string[]
  expectedBuildActors: Actor[]
  expectedRepositoryTypes: string[]
}
function remap<T>(value: T, replacements: [string, string][]): T {
  let serialized = JSON.stringify(value)
  for (const [from, to] of replacements) serialized = serialized.replaceAll(from, to)
  return JSON.parse(serialized) as T
}
export async function seedExtendedBrowserControls(
  sql: SQL,
  store: BuildStore,
): Promise<ExtendedBrowserFixture[]> {
  const directory = resolve(import.meta.dir, '../fixtures')
  const api = (await Bun.file(resolve(directory, 'api-read-corpus.json')).json()) as ApiReadCorpus
  const control = (await Bun.file(resolve(directory, 'control-corpus.json')).json()) as Awaited<
    ReturnType<typeof checkControlCorpus>
  >
  const advanced = (await Bun.file(
    resolve(directory, 'advanced-control-corpus.json'),
  ).json()) as Awaited<ReturnType<typeof checkAdvancedCorpus>>
  const registry = new PostgresProjectRegistry(sql)
  const result: ExtendedBrowserFixture[] = []
  for (const mode of ['js', 'nojs'] as const)
    for (const action of extendedBrowserActions) {
      const { repo } = await registry.add(`https://github.com/browser/${mode}-${action}`, 'capture')
      const slug = `extended-${mode}-${action}`
      const fixture: ExtendedBrowserFixture = {
        mode,
        action,
        project: repo,
        build: slug,
        slug: ['review-round-ceiling', 'revise-body', 'revise-ticket'].includes(action) ? slug : '',
        button: action.startsWith('harvest-') ? 'harvest-run' : action,
        expectedBuildTypes: [],
        expectedBuildActors: [],
        expectedRepositoryTypes: [],
      }
      const repositorySeed = api.fixtures.find(
        (f) =>
          f.scenario.seed ===
          (action === 'harvest-resume'
            ? 'harvest-failed'
            : action === 'harvest-acknowledge'
              ? 'harvest-exhausted'
              : 'configured'),
      )!.seed.repository
      const repository = remap(repositorySeed, [
        ['api-read/repository', repo],
        ['api-read-build', slug],
      ])
      await store.ensureRepo(repo)
      for (const artifact of repository.artifacts)
        await store.putRepoArtifact(repo, {
          kind: artifact.meta.kind,
          content: Buffer.from(artifact.base64, 'base64'),
          metadata: artifact.meta.metadata,
        })
      for (const event of repository.events)
        await store.appendRepo(repo, validateRepositoryEventWrite(event))
      if (action === 'revise-body' || action === 'revise-ticket') {
        const original = advanced.fixtures.find(
          (f) =>
            f.id ===
            (action === 'revise-ticket'
              ? 'revise-hosted-empty'
              : 'revise-supplied-preserves-assets'),
        )!
        const source = remap(original, [
          [operatorRepo, repo],
          ['advanced-build', slug],
        ])
        const [registration] =
          await sql`SELECT seq FROM project_journal WHERE repo=${repo} AND action='added' ORDER BY seq DESC LIMIT 1`
        await sql`INSERT INTO project_ticket_policy(repo,registration,policy,writer,updated_at) VALUES(${repo},${registration.seq},${{ tickets: source.config.tickets }},'capture',${new Date()})`
        const tickets = new PostgresTicketSource(
          sql,
          { repo, teamKey: 'ENG', lifecycle: advancedLifecycle },
          advancedLifecycle,
        )
        for (const ticket of source.tickets) {
          await tickets.create(
            {
              kind: ticket.kind,
              target: ticket.target,
              title: ticket.title,
              body: ticket.body,
              labels: ticket.labels,
            },
            { requestedId: ticket.ref.id },
          )
          await tickets.transition(ticket.ref.id, ticket.state!)
        }
        for (const input of source.inputs) {
          await store.createBuild(input)
          const build = source.seed.builds.find((b) => b.record!.slug === input.slug)!
          for (const event of build.events.slice(1))
            await store.append(input.slug, validateEventWrite(event))
          for (const artifact of build.artifacts)
            await store.putArtifact(input.slug, {
              kind: artifact.meta.kind,
              content: Buffer.from(artifact.base64, 'base64'),
              metadata: artifact.meta.metadata,
            })
        }
        for (const asset of source.assetSeeds) {
          await store.putTicketAsset(repo, asset.ticketId, {
            kind: asset.kind,
            name: asset.name,
            layout: asset.layout,
            entries: asset.entries.map((entry) =>
              entry.type === 'dir'
                ? entry
                : { type: 'file', path: entry.path, content: Buffer.from(entry.base64, 'base64') },
            ),
          })
          if (asset.removed)
            await store.removeTicketAsset(repo, asset.ticketId, asset.kind, asset.name)
        }
        fixture.text = (source.request.body as { body: string }).body
        fixture.expectedBuildTypes = ['escalation.answered', 'spec.revised']
        const seeded = source.seed.builds.find((build) => build.record!.slug === slug)!
        fixture.expectedBuildActors = source.after.builds
          .find((build) => build.record!.slug === slug)!
          .events.slice(seeded.events.length)
          .map((event) => event.actor)
      } else {
        const scenario =
          action === 'review-round-ceiling'
            ? 'answer-review-limit'
            : action === 'resume-all'
              ? 'resume-paused'
              : 'pause-running'
        const source = remap(control.fixtures.find((f) => f.scenario.id === scenario)!.seed, [
          [operatorRepo, repo],
          ['control-build', slug],
        ])
        const first = validateEventWrite(source.events[0]!)
        if (first.type !== 'build.created')
          throw Error('Browser seed must begin with build.created')
        await store.createBuild({
          slug,
          repo,
          ticket: source.record!.ticket,
          created: first as EventWrite<'build.created'>,
        })
        for (const event of source.events.slice(1))
          await store.append(slug, validateEventWrite(event))
        if (action === 'review-round-ceiling') {
          fixture.ceiling = '5'
          fixture.expectedBuildTypes = ['escalation.answered']
        } else if (action === 'pause-all') {
          fixture.expectedBuildTypes = ['build.pause-requested']
          fixture.expectedRepositoryTypes = ['dispatcher.pause-set', 'dispatcher.intake-set']
        } else if (action === 'resume-all') {
          fixture.expectedBuildTypes = ['build.resume-requested']
          fixture.expectedRepositoryTypes = ['dispatcher.pause-set', 'dispatcher.intake-set']
        } else if (action === 'intake') fixture.expectedRepositoryTypes = ['dispatcher.intake-set']
        else
          fixture.expectedRepositoryTypes = [
            action === 'harvest' ? 'harvest.pause-requested' : 'harvest.resume-requested',
          ]
      }
      if (!fixture.expectedBuildActors.length)
        fixture.expectedBuildActors = fixture.expectedBuildTypes.map(() => ({
          kind: 'human',
          user: 'operator@example.com',
        }))
      result.push(fixture)
    }
  return result
}

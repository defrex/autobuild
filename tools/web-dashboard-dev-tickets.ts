/**
 * Hosted ticket fixtures for `tools/web-dashboard-dev.ts`: every lifecycle
 * state the web app's tabs show, with ids that match the replayed builds so a
 * build page can show its ticket.
 */
import type { HostedTicketPolicy } from '../packages/core/src/ports/tickets/remote-protocol'

export const DEV_TICKET_POLICY = (teamKey: string): HostedTicketPolicy => ({
  version: 1,
  tickets: {
    source: 'hosted',
    teamKey,
    triageState: 'triage',
    readyState: 'ready',
    claimedState: 'doing',
    doneState: 'done',
    createState: 'triage',
    proposalState: 'triage',
  },
})

export interface DevTicket {
  id: string
  state: 'triage' | 'ready' | 'doing' | 'done' | 'icebox'
  title: string
  body: string
  labels?: string[]
  blockedBy?: string[]
  kind?: 'work' | 'node'
  comments?: { body: string }[]
}

/** The mixed scenario's symbolic ticket ids, renumbered for hosted ids. */
export const MIXED_TICKET_IDS: Record<string, string> = {
  'CAP-PLAN': 'CAP-41',
  'CAP-IMPLEMENT': 'CAP-42',
  'CAP-COMPLETE': 'CAP-43',
  'CAP-QUEUED': 'CAP-44',
}

const spec = (summary: string, criteria: string[], notes?: string) =>
  [
    summary,
    '',
    '## Acceptance criteria',
    '',
    ...criteria.map((line) => `- ${line}`),
    ...(notes ? ['', '## Notes', '', notes] : []),
  ].join('\n')

export const HAPPY_TICKETS: DevTicket[] = [
  {
    id: 'AUT-120',
    state: 'done',
    title: 'Retry transient forge errors',
    body: spec('Retry 502 and 503 responses from the forge with backoff before failing a build.', [
      'Three attempts with exponential backoff starting at 500 ms.',
      'A retried request records one `forge.retry` observation.',
    ]),
  },
  {
    id: 'AUT-121',
    state: 'done',
    title: 'Show elapsed time on finished steps',
    body: spec('Finished steps keep their final duration instead of dropping it.', [
      'The row shows `[x] plan(1m12s)` after the step ends.',
    ]),
  },
  {
    id: 'AUT-122',
    state: 'done',
    title: 'Label harvest proposals',
    labels: ['harvest'],
    body: spec('Proposals filed by harvest carry a `proposal` label so triage can filter them.', [
      'Every harvested ticket has the label.',
      'Existing proposals are not relabelled.',
    ]),
  },
  {
    id: 'AUT-129',
    state: 'doing',
    title: 'Parallel verify steps',
    body: spec(
      'Run independent `verify:*` steps concurrently instead of one after another. A repository with unit, lint and e2e steps currently waits for the sum of their durations.',
      [
        'Steps without a declared dependency start together.',
        'A failing step cancels the others and reports which step failed first.',
        'The dashboard shows every running verify step as current.',
      ],
      'Keep the step order in the pipeline line stable even when completion order differs.',
    ),
  },
  {
    id: 'AUT-131',
    state: 'doing',
    title: 'Cache warm on deploy',
    body: spec(
      'Warm the dependency cache when a new runtime is deployed, so the first build after a deploy is not the slow one.',
      [
        'Deploy triggers one warm-up run per configured runner.',
        'A warm-up failure raises attention but never blocks dispatch.',
      ],
    ),
  },
  {
    id: 'AUT-133',
    state: 'doing',
    title: 'Ticket source adapters',
    body: [
      'Split ticket-source plumbing into adapters so a new tracker is one file.',
      '',
      '## Scope',
      '',
      '1. Extract the shared listing and claim logic.',
      '2. Move the file and hosted sources onto it.',
      '3. Document the adapter contract.',
      '',
      '## Acceptance criteria',
      '',
      '- Existing sources pass the shared contract suite unchanged.',
      '- An adapter implements `listReady`, `claim`, `transition` and `get`:',
      '',
      '```ts',
      'export interface TicketAdapter {',
      '  listReady(criteria: Criteria): Promise<TicketListing>',
      '  claim(id: string): Promise<boolean>',
      '}',
      '```',
    ].join('\n'),
  },
  {
    id: 'AUT-134',
    state: 'doing',
    title: 'Dashboard key legend',
    body: spec(
      'Explain the step marks under the build list so a first-time reader knows what `[~]` means.',
      [
        'The legend lists every mark with its plain-language meaning.',
        'Colors match the marks in the rows on both grounds.',
      ],
    ),
  },
  {
    id: 'AUT-136',
    state: 'doing',
    title: 'Harvest dedup window',
    body: spec(
      'Skip an observation that repeats one already harvested within the last seven days.',
      [
        'The window is configurable as `[harvest].dedupDays`.',
        'A skipped observation is still visible in the store.',
      ],
    ),
  },
  {
    id: 'AUT-137',
    state: 'ready',
    title: 'Show PR review state on build rows',
    body: spec(
      'Rows show whether the pull request has an approving review, a change request, or none.',
      ['The review state appears beside the PR state.', 'Draft PRs show no review state.'],
    ),
  },
  {
    id: 'AUT-138',
    state: 'ready',
    title: 'Rate-limit forge calls per repository',
    blockedBy: ['AUT-133'],
    body: spec(
      'Cap forge API calls per repository so one busy project cannot exhaust the shared token.',
      [
        'Calls beyond the cap wait, they are never dropped.',
        'The cap is reported in repository status.',
      ],
    ),
  },
  {
    id: 'AUT-139',
    state: 'ready',
    title: 'Copy the build slug from the build page',
    labels: ['small'],
    body: 'Add a copy control beside the slug on the build page.',
  },
  {
    id: 'AUT-140',
    state: 'triage',
    title: 'Flaky snapshot test in the reducer suite',
    labels: ['proposal'],
    body: [
      'Harvested from 3 observations across 2 builds.',
      '',
      '> `reducer.test.ts` failed once and passed on retry in AUT-129 and AUT-131.',
      '',
      'The snapshot includes a wall-clock timestamp. Freeze the clock in the test.',
    ].join('\n'),
  },
  {
    id: 'AUT-141',
    state: 'triage',
    title: 'Retry budget for verify steps',
    body: 'Verify steps retry forever on infrastructure errors. Give them a budget and escalate when it runs out.',
  },
  {
    id: 'AUT-142',
    state: 'triage',
    title: 'Document webhook retry behaviour',
    labels: ['docs', 'proposal'],
    body: 'Users ask what happens when a webhook delivery fails. Write it down in the forge docs.',
  },
]

export const MIXED_TICKETS: DevTicket[] = [
  {
    id: 'CAP-40',
    state: 'done',
    title: 'Seed the capture repository',
    body: 'Create the repository the capture scenarios run against.',
  },
  {
    id: 'CAP-41',
    state: 'doing',
    title: 'Plan blocked dashboard',
    body: spec('Exercise a build that stops in plan and asks a person for an answer.', [
      'The row shows BLOCKED with the question in red.',
      'The build page shows the full question and the answer form.',
    ]),
  },
  {
    id: 'CAP-42',
    state: 'doing',
    title: 'Implement blocked dashboard',
    body: spec('Exercise a build that stops in implement.', [
      'The escalation names the implement phase.',
    ]),
  },
  {
    id: 'CAP-43',
    state: 'doing',
    title: 'Complete dashboard evidence',
    body: spec('Exercise a build that finished every phase and waits for merge consent.', [
      'The row shows the merge consent sign-off.',
    ]),
  },
  {
    id: 'CAP-44',
    state: 'doing',
    title: 'Queued dashboard evidence',
    body: 'Exercise a held build that stays queued after a dispatch failure.',
  },
  {
    id: 'CAP-45',
    state: 'triage',
    title: 'Capture the empty ready queue',
    body: 'This project has nothing ready, so the Queue tab shows its empty state.',
  },
]

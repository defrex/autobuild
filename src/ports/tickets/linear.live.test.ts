import { describe } from 'bun:test'
import { describeTicketSourceContract, type TicketSourceContractHarness } from './contract'
import { LINEAR_API_URL, LinearTicketSource } from './linear'

interface LinearErrorShape {
  message?: string
}

interface WorkflowState {
  id: string
  name: string
  type: string
}

interface ScratchLinearConfig {
  apiKey: string
  teamKey: string
  projectId: string
  readyState: string
  claimedState: string
  completedState: string
  editableLabel: string
}

function nonblank(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!nonblank(value)) {
    throw new Error(
      `Linear live TicketSource contract requires ${name} once ` +
        'AB_RUN_LIVE_PORT_CONTRACTS=1 and LINEAR_API_KEY are set',
    )
  }
  return value.trim()
}

async function linearRequest<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`Linear contract fixture: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as {
    data?: T | null
    errors?: LinearErrorShape[]
  }
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Linear contract fixture: GraphQL errors — ${payload.errors
        .map((error) => error.message ?? JSON.stringify(error))
        .join('; ')}`,
    )
  }
  if (payload.data === undefined || payload.data === null) {
    throw new Error('Linear contract fixture: response has no data')
  }
  return payload.data
}

let scratchConfig: Promise<ScratchLinearConfig> | undefined

function loadScratchConfig(): Promise<ScratchLinearConfig> {
  scratchConfig ??= (async () => {
    const apiKey = requiredEnv('LINEAR_API_KEY')
    const teamKey = requiredEnv('AB_LINEAR_CONTRACT_TEAM_KEY')
    const projectId = requiredEnv('AB_LINEAR_CONTRACT_PROJECT_ID')
    const data = await linearRequest<{
      teams: {
        nodes: Array<{
          id: string
          key: string
          states: { nodes: WorkflowState[] }
          labels: { nodes: Array<{ name: string }> }
        }>
      }
      project: { id: string; name: string } | null
    }>(
      apiKey,
      `query PortContractSetup($teamKey: String!, $projectId: String!) {
        teams(filter: { key: { eq: $teamKey } }) {
          nodes {
            id key
            states { nodes { id name type } }
            labels { nodes { name } }
          }
        }
        project(id: $projectId) { id name }
      }`,
      { teamKey, projectId },
    )
    const team = data.teams.nodes[0]
    if (!team) {
      throw new Error(
        `Linear live TicketSource contract found no team with key ${JSON.stringify(teamKey)}`,
      )
    }
    if (!data.project || data.project.id !== projectId) {
      throw new Error(
        `Linear live TicketSource contract cannot access scratch project ${JSON.stringify(projectId)}`,
      )
    }

    const findState = (purpose: string, types: readonly string[]): WorkflowState => {
      const state = types
        .map((type) => team.states.nodes.find((candidate) => candidate.type === type))
        .find((candidate) => candidate !== undefined)
      if (!state) {
        throw new Error(
          `Linear scratch team ${teamKey} needs a ${purpose} workflow state ` +
            `(type ${types.join(' or ')}); found ${
              team.states.nodes
                .map((candidate) => `${candidate.name}:${candidate.type}`)
                .join(', ') || 'none'
            }`,
        )
      }
      return state
    }

    const editableLabel = team.labels.nodes[0]?.name
    if (editableLabel === undefined) {
      throw new Error(
        `Linear scratch team ${teamKey} needs at least one issue label for ` +
          'TicketSource update contract coverage',
      )
    }

    return {
      apiKey,
      teamKey,
      projectId,
      readyState: findState('claimable', ['unstarted', 'backlog']).name,
      claimedState: findState('claimed', ['started']).name,
      completedState: findState('completed', ['completed', 'canceled']).name,
      editableLabel,
    }
  })()
  return scratchConfig
}

async function linearHarness(): Promise<TicketSourceContractHarness> {
  const config = await loadScratchConfig()
  const reservedIds = new Set<string>()

  return {
    source: new LinearTicketSource({
      apiKey: config.apiKey,
      teamKey: config.teamKey,
      claimedState: config.claimedState,
    }),
    states: {
      ready: config.readyState,
      claimed: config.claimedState,
      completed: config.completedState,
    },
    editableLabel: config.editableLabel,
    beforeCreate: (idempotencyKey) => {
      reservedIds.add(idempotencyKey)
    },
    afterCreate: async (_ticket, idempotencyKey) => {
      const result = await linearRequest<{
        issueUpdate: { success: boolean }
      }>(
        config.apiKey,
        `mutation AttachPortContractIssue($id: String!, $projectId: String!) {
          issueUpdate(id: $id, input: { projectId: $projectId }) { success }
        }`,
        { id: idempotencyKey, projectId: config.projectId },
      )
      if (!result.issueUpdate.success) {
        throw new Error(
          `Linear contract fixture could not attach issue ${idempotencyKey} ` +
            `to scratch project ${config.projectId}`,
        )
      }
    },
    cleanup: async () => {
      const failures: unknown[] = []
      for (const id of reservedIds) {
        try {
          const result = await linearRequest<{
            issueArchive: { success: boolean }
          }>(
            config.apiKey,
            `mutation ArchivePortContractIssue($id: String!) {
              issueArchive(id: $id) { success }
            }`,
            { id },
          )
          if (!result.issueArchive.success) {
            failures.push(new Error(`Linear cleanup did not archive issue ${id}`))
          }
        } catch (error) {
          // A reservation recorded before a failed create may never have
          // become an issue. That is already clean; all other cleanup errors
          // remain actionable.
          if (
            !(error instanceof Error) ||
            !/entity not found|could not find referenced issue/i.test(error.message)
          ) {
            failures.push(error)
          }
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Linear contract cleanup failed')
      }
    },
  }
}

const runLiveLinear =
  process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1' && nonblank(process.env.LINEAR_API_KEY)

describe.skipIf(!runLiveLinear)('Linear live port contracts (opt-in)', () => {
  describeTicketSourceContract('LinearTicketSource (live)', linearHarness)
})

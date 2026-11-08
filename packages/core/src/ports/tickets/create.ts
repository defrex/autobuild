import { compatibleTicketSource } from './tree'
import { configuredStore } from '../../cli/configured-store'
import { projectToken } from '../../cli/project-credentials'
import { resolveRepoOrigin } from '../../cli/repo-state'
import { spawnExec } from '../workspace/git-worktree'
/**
 * TicketSource factory (SPEC §3.2, §13): construct the builtin or plugin source
 * named by [tickets]. Plugin credentials, like LINEAR_API_KEY, come only from
 * the environment. This remains the single boundary for file-directory
 * defaulting and for registry-aware source selection.
 */
import { resolve } from 'node:path'
import type { TicketsConfig } from '../../config/schema'
import { createPluginRegistry, type PluginRegistry } from '../../plugins/registry'
import type { PluginFactoryContext } from '../../plugins/manifest'
import type { TicketSource } from '../types'
import { DEFAULT_TICKETS_DIR, FileTicketSource } from './file'
import { LinearTicketSource } from './linear'
import { GitHubTicketSource } from './github'
import { FileGitHubValidatorStore } from './github-validators'
import {
  createGitHubFetchTransport,
  githubTokenSource,
  resolveGitHubToken,
} from '../forge/github-transport'
import { parseRepoCoordinates } from '../forge/github'
import { normalizeGitRemoteUrl } from '../../kernel/origin'
import { HostedTicketSource, hostedTicketPolicy } from './remote'
import { ticketLifecycle } from './lifecycle'
import { normalizeServiceURL } from '../../connection'
import { assertReadyAssigneeSupported } from '../../config/ready-assignee'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function rawTicketSource(
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  /** A relative [tickets].dir is relative to the repo, not this process's cwd. */
  targetRepo: string,
  /** Selected local state root. Remote stores pass the repo-local default. */
  localStateRoot?: string,
  /** Registry loaded from this repository's configured plugins. */
  plugins: PluginRegistry = createPluginRegistry(),
): Promise<TicketSource> {
  if (config.source === 'hosted') {
    const buildUrl = env.AB_STORE?.trim() || configuredStore(targetRepo)
    const rawUrl = config.url ?? buildUrl
    if (!rawUrl) {
      throw new Error(
        'Hosted tickets require [tickets] url when builds are local; alternatively set [store] url or AB_STORE to a service',
      )
    }
    let serviceUrl: URL
    try {
      serviceUrl = new URL(normalizeServiceURL(rawUrl, 'tickets.url'))
    } catch {
      throw new Error(
        'Hosted tickets require [tickets] url when [store] url / AB_STORE selects local builds',
      )
    }
    const ticketSession = env.AB_TICKET_TOKEN !== undefined || env.AB_TICKET_URL !== undefined
    if (
      ticketSession &&
      (!env.AB_TICKET_TOKEN ||
        !env.AB_TICKET_URL ||
        normalizeServiceURL(env.AB_TICKET_URL) !== normalizeServiceURL(rawUrl))
    )
      throw new Error('Ticket session credential does not match the selected ticket service')
    const token = ticketSession
      ? env.AB_TICKET_TOKEN
      : projectToken(
          rawUrl,
          (await resolveRepoOrigin(targetRepo, spawnExec)) ?? targetRepo,
          config.url &&
            (!buildUrl ||
              !/^https?:/.test(buildUrl) ||
              normalizeServiceURL(config.url) !== normalizeServiceURL(buildUrl))
            ? { ...env, AB_TOKEN: undefined }
            : env,
        )
    if (!token) {
      throw new Error(
        'No project credential; run ab connect (or set AB_TOKEN) — a project credential is required when [tickets].source = "hosted"',
      )
    }
    if (config.teamKey === undefined) {
      throw new Error('[tickets].source = "hosted" requires teamKey')
    }
    const source = new HostedTicketSource({
      url: serviceUrl.toString(),
      token,
      teamKey: config.teamKey,
      ...(config.claimedState !== undefined ? { claimedState: config.claimedState } : {}),
      ...(config.createState !== undefined ? { createState: config.createState } : {}),
    })
    // Delegated sessions may read policy, but never redefine project authority.
    if (!ticketSession && !env.AB_HARVEST && !env.AB_PHASE) {
      await source.synchronizePolicy(hostedTicketPolicy(config))
    }
    // The source leaves with a settled targeting decision, so no observation
    // pass ever runs on undecided support; the policy sync usually settled it.
    await source.negotiateTargeting()
    return source
  }

  if (config.source === 'linear') {
    const apiKey = env.LINEAR_API_KEY
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'LINEAR_API_KEY is not set — expected a Linear personal API key; ' +
          'required when [tickets].source = "linear". Set it in the ' +
          'environment or a local .env file.',
      )
    }
    // teamKey presence is cross-validated at config parse; re-checked here
    // because plugin configurations can carry the same optional field.
    if (config.teamKey === undefined) {
      throw new Error(
        '[tickets].source = "linear" requires teamKey — the Linear team key (e.g. "ENG")',
      )
    }
    return new LinearTicketSource({
      apiKey,
      teamKey: config.teamKey,
      ...(config.claimedState !== undefined ? { claimedState: config.claimedState } : {}),
      ...(config.createState !== undefined ? { createState: config.createState } : {}),
    })
  }

  if (config.source === 'github') {
    const origin = env.AB_REPOSITORY?.trim() || (await resolveRepoOrigin(targetRepo, spawnExec))
    if (origin === undefined || origin === '')
      throw new Error(
        '[tickets].source = "github" needs the repository\'s origin remote on github.com; set the checkout\'s origin or export AB_REPOSITORY',
      )
    const coordinates = githubCoordinates(origin)
    if (coordinates === null)
      throw new Error(
        `[tickets].source = "github" needs an origin on github.com; origin is ${origin}`,
      )
    return new GitHubTicketSource({
      transport: createGitHubFetchTransport({ token: githubTokenSource(env) }),
      repository: coordinates,
      lifecycle: ticketLifecycle(config),
      readyLabels: config.readyLabels ?? ['autobuild'],
      ...(localStateRoot !== undefined
        ? {
            validators: new FileGitHubValidatorStore(
              resolve(
                localStateRoot,
                'github-tickets',
                coordinates.owner,
                coordinates.name,
                'validators',
              ),
            ),
          }
        : {}),
      credentialMiss: async () => {
        const credential = await resolveGitHubToken(env)
        return 'reason' in credential ? credential.reason : undefined
      },
    })
  }

  if (config.source === 'file') {
    return new FileTicketSource({
      dir:
        config.dir === undefined && localStateRoot !== undefined
          ? resolve(localStateRoot, 'tickets')
          : resolve(targetRepo, config.dir ?? DEFAULT_TICKETS_DIR),
      // Only the DEFAULTED backlog hides itself from git. An explicit dir is
      // user-owned and may intentionally be tracked.
      selfIgnore: config.dir === undefined,
      ...(config.createState !== undefined ? { createState: config.createState } : {}),
    })
  }

  const registration = plugins.ticketSources.get(config.source)
  if (registration === undefined || registration.factory === undefined) {
    const available = [...plugins.ticketSources.keys()].sort().join(', ')
    throw new Error(
      `unknown ticket source "${config.source}"; available ticket sources: ${available}`,
    )
  }

  const missing = (registration.requiredEnv ?? []).filter((name) => {
    const value = env[name]
    return value === undefined || value === ''
  })
  if (missing.length > 0) {
    throw new Error(
      `ticket source "${config.source}" from plugin "${registration.owner.name}" ` +
        `requires environment ${missing.map((name) => `variable "${name}"`).join(', ')}; ` +
        'set the missing credentials in the environment or a local .env file',
    )
  }

  const context: PluginFactoryContext = {
    config: config as unknown as Record<string, unknown>,
    env,
    repoRoot: resolve(targetRepo),
  }
  try {
    return await registration.factory(context)
  } catch (error) {
    throw new Error(
      `ticket source "${config.source}" from plugin "${registration.owner.name}" ` +
        `failed during construction: ${reason(error)}`,
      { cause: error },
    )
  }
}

export async function createTicketSource(
  ...args: Parameters<typeof rawTicketSource>
): Promise<TicketSource> {
  const [config, , , , plugins] = args
  const source = await rawTicketSource(...args)
  // Plugins load after config parse, so the capability is checked here, on
  // the constructed source, rather than in the schema.
  const owner = plugins?.ticketSources.get(config.source)?.owner
  assertReadyAssigneeSupported(config, source, owner?.kind === 'plugin' ? owner.name : undefined)
  return compatibleTicketSource(source)
}

/** Owner and name of a github.com origin: an `owner/name` slug, or a URL or
 * SSH spelling whose host is github.com. Anything else is null. */
export function githubCoordinates(origin: string): { owner: string; name: string } | null {
  const normalized = normalizeGitRemoteUrl(origin)
  let host: string | undefined
  try {
    host = new URL(normalized).hostname
  } catch {
    host = undefined
  }
  if (host !== undefined && host !== '' && host.toLowerCase() !== 'github.com') return null
  return parseRepoCoordinates(normalized)
}

/**
 * GitHubForge (SPEC §3.2): the Forge adapter for GitHub, shelling out to
 * `git` and `gh` through an injectable exec seam. All remote access is
 * kernel-side plumbing (SPEC §8.6 [D7]) — agents never touch the remote,
 * so forge credentials never enter the sandbox.
 *
 * Body delivery: the exec seam is argv + cwd only (no stdin channel), so PR
 * and comment bodies are written to a temp file and passed with
 * `--body-file <path>` — a file survives arbitrary quoting and newlines in
 * the body. The temp-file writer is itself a seam so tests assert exact
 * argv arrays and the delivered content.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  classifyAutoMergeEnable,
  mergeStateStatuses,
  type MergeGatePresence,
} from '../../kernel/auto-merge'
import type { AutoMergeResult, PrAttachmentHosting, Forge, PrRef, PrState } from '../types'
import { GitHubPrAttachmentHosting, type PrAttachmentTempFileWriter } from './github-pr-attachments'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Same seam shape as the workspace module: argv array, cwd, no shell. */
export type Exec = (
  cmd: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<ExecResult>

export const bunExec: Exec = async (cmd, opts) => {
  if (opts.signal?.aborted === true) {
    throw new Error(`forge command aborted before launch: ${cmd.join(' ')}`)
  }
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const abort = (): void => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // A process that exited concurrently is already cancelled sufficiently.
    }
  }
  opts.signal?.addEventListener('abort', abort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    opts.signal?.removeEventListener('abort', abort)
  }
}

/** Writes `content` somewhere on disk and returns the path. */
export type TempFileWriter = (content: string) => Promise<string>

export const defaultTempFileWriter: TempFileWriter = async (content) => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-forge-'))
  const path = join(dir, 'body.md')
  await writeFile(path, content, 'utf8')
  return path
}

// `gh --json` returns exactly the requested fields, so shapes are closed.
const prViewJson = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().min(1),
  headRefOid: z.string().min(1),
})

const prStateJson = z.strictObject({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeCommit: z.strictObject({ oid: z.string().min(1) }).nullable(),
})

// Disabling needs only native desired state. Keep this schema separate from
// enable-only routing facts so a future mergeStateStatus cannot prevent an
// operator from revoking consent.
const nativeAutoMergeJson = z.strictObject({
  autoMergeRequest: z.object({}).passthrough().nullable(),
})

// Enabling additionally needs the two independent routing facts. `gh --json`
// returns exactly these requested fields, so an unknown merge-state enum or a
// missing head/base is a hard parse failure rather than fallback eligibility.
const autoMergeJson = z.strictObject({
  ...nativeAutoMergeJson.shape,
  mergeStateStatus: z.enum(mergeStateStatuses),
  headRefOid: z.string().min(1),
  baseRefName: z.string().min(1),
})

const repoIdentityJson = z.strictObject({
  nameWithOwner: z.string().min(3),
})

const classicProtectionJson = z.strictObject({
  data: z.strictObject({
    repository: z
      .strictObject({
        ref: z
          .strictObject({
            branchProtectionRule: z
              .strictObject({
                requiresStatusChecks: z.boolean(),
                requiresApprovingReviews: z.boolean(),
                requiredApprovingReviewCount: z.number().int().nonnegative(),
                requiresCodeOwnerReviews: z.boolean(),
                requireLastPushApproval: z.boolean(),
                requiresConversationResolution: z.boolean(),
                requiresDeployments: z.boolean(),
                requiresCommitSignatures: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .nullable(),
  }),
})

const rulesetRulesJson = z.array(
  z
    .object({
      type: z.string().min(1),
      parameters: z.unknown().optional(),
    })
    .passthrough(),
)

const pullRequestRuleParameters = z
  .object({
    required_approving_review_count: z.number().int().nonnegative(),
    require_code_owner_review: z.boolean(),
    require_last_push_approval: z.boolean(),
    required_review_thread_resolution: z.boolean(),
  })
  .passthrough()

const requiredStatusRuleParameters = z
  .object({ required_status_checks: z.array(z.unknown()) })
  .passthrough()
const requiredDeploymentsRuleParameters = z
  .object({ required_deployment_environments: z.array(z.string()) })
  .passthrough()
const requiredWorkflowsRuleParameters = z.object({ workflows: z.array(z.unknown()) }).passthrough()
const requiredCodeScanningRuleParameters = z
  .object({
    code_scanning_tools: z.array(z.unknown()).optional(),
    required_code_scanning_tools: z.array(z.unknown()).optional(),
  })
  .refine(
    (value) =>
      value.code_scanning_tools !== undefined || value.required_code_scanning_tools !== undefined,
    { message: 'a code-scanning tools array is required' },
  )
  .passthrough()
const mergeQueueRuleParameters = z.object({}).passthrough()

/** Exact-ref classic protection query. A rule may exist yet contain only
 * structural restrictions; only requirements that can block landing count as
 * a merge gate. */
const CLASSIC_PROTECTION_QUERY = [
  'query($owner:String!,$name:String!,$qualifiedRef:String!){',
  'repository(owner:$owner,name:$name){',
  'ref(qualifiedName:$qualifiedRef){',
  'branchProtectionRule{',
  'requiresStatusChecks requiresApprovingReviews requiredApprovingReviewCount',
  'requiresCodeOwnerReviews requireLastPushApproval',
  'requiresConversationResolution requiresDeployments requiresCommitSignatures',
  '}',
  '}',
  '}',
  '}',
].join(' ')

const STRUCTURAL_RULE_TYPES = new Set([
  'creation',
  'update',
  'deletion',
  'required_linear_history',
  'non_fast_forward',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'branch_name_pattern',
  'tag_name_pattern',
  'file_path_restriction',
  'max_file_path_length',
  'file_extension_restriction',
  'max_file_size',
])

function parseRuleParameters<S extends z.ZodType>(
  schema: S,
  parameters: unknown,
  type: string,
): z.infer<S> {
  const parsed = schema.safeParse(parameters)
  if (!parsed.success) {
    throw new Error(`unexpected parameters for active GitHub ruleset rule ${type}: ${parsed.error}`)
  }
  return parsed.data
}

/** Whether any active repository/organization rule matching one branch
 * carries a real merge-blocking requirement. Unknown future types fail closed. */
export function rulesetsHaveMergeGate(rules: z.infer<typeof rulesetRulesJson>): boolean {
  let present = false
  for (const rule of rules) {
    switch (rule.type) {
      case 'merge_queue':
        parseRuleParameters(mergeQueueRuleParameters, rule.parameters, rule.type)
        present = true
        break
      case 'required_signatures':
        present = true
        break
      case 'required_status_checks': {
        const parameters = parseRuleParameters(
          requiredStatusRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.required_status_checks.length > 0 || present
        break
      }
      case 'required_deployments': {
        const parameters = parseRuleParameters(
          requiredDeploymentsRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.required_deployment_environments.length > 0 || present
        break
      }
      case 'workflows':
      case 'required_workflows': {
        const parameters = parseRuleParameters(
          requiredWorkflowsRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.workflows.length > 0 || present
        break
      }
      case 'required_code_scanning':
      case 'code_scanning': {
        const parameters = parseRuleParameters(
          requiredCodeScanningRuleParameters,
          rule.parameters,
          rule.type,
        )
        const tools =
          parameters.code_scanning_tools ?? parameters.required_code_scanning_tools ?? []
        present = tools.length > 0 || present
        break
      }
      case 'pull_request': {
        const parameters = parseRuleParameters(
          pullRequestRuleParameters,
          rule.parameters,
          rule.type,
        )
        present =
          parameters.required_approving_review_count > 0 ||
          parameters.require_code_owner_review ||
          parameters.require_last_push_approval ||
          parameters.required_review_thread_resolution ||
          present
        break
      }
      default:
        if (!STRUCTURAL_RULE_TYPES.has(rule.type)) {
          throw new Error(
            `unknown active GitHub ruleset rule type ${JSON.stringify(rule.type)}; ` +
              'cannot prove the branch has no merge-blocking gate',
          )
        }
    }
  }
  return present
}

/** §15.7: mergeable false is what makes the janitor emit `pr.conflicted`. */
const MERGEABLE_MAP = {
  MERGEABLE: true,
  CONFLICTING: false,
  UNKNOWN: null,
} as const

export class GitHubForge implements Forge {
  readonly name = 'github'
  readonly prAttachments: PrAttachmentHosting

  private readonly exec: Exec
  private readonly writeTempFile: TempFileWriter

  constructor(
    opts: {
      exec?: Exec
      writeTempFile?: TempFileWriter
      writePrAttachmentTempFile?: PrAttachmentTempFileWriter
      prAttachmentTimeoutMs?: number
    } = {},
  ) {
    this.exec = opts.exec ?? bunExec
    this.writeTempFile = opts.writeTempFile ?? defaultTempFileWriter
    this.prAttachments = new GitHubPrAttachmentHosting({
      exec: this.exec,
      ...(opts.writePrAttachmentTempFile !== undefined
        ? { writeTempFile: opts.writePrAttachmentTempFile }
        : {}),
      ...(opts.prAttachmentTimeoutMs !== undefined
        ? { commandTimeoutMs: opts.prAttachmentTimeoutMs }
        : {}),
    })
  }

  private async run(cmd: string[], cwd: string): Promise<string> {
    const result = await this.exec(cmd, { cwd })
    if (result.exitCode !== 0) {
      throw new Error(
        `forge command failed (exit ${result.exitCode}): ${cmd.join(' ')}\n${result.stderr.trim()}`,
      )
    }
    return result.stdout
  }

  private parseJson<S extends z.ZodType>(schema: S, stdout: string, cmd: string[]): z.infer<S> {
    try {
      return schema.parse(JSON.parse(stdout))
    } catch (error) {
      throw new Error(`unexpected output from \`${cmd.join(' ')}\`: ${String(error)}`)
    }
  }

  /** Probe both GitHub gate systems for the PR's exact base branch. Only two
   * successful negative probes prove absence; command/schema/auth failures
   * throw and therefore can never authorize a direct merge. */
  private async mergeGatePresence(
    workspacePath: string,
    baseRefName: string,
  ): Promise<MergeGatePresence> {
    const repoCmd = ['gh', 'repo', 'view', '--json', 'nameWithOwner']
    const identity = this.parseJson(
      repoIdentityJson,
      await this.run(repoCmd, workspacePath),
      repoCmd,
    )
    const parts = identity.nameWithOwner.split('/')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(
        `unexpected GitHub repository identity ${JSON.stringify(identity.nameWithOwner)}`,
      )
    }
    const [owner, name] = parts as [string, string]

    const classicCmd = [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${CLASSIC_PROTECTION_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `qualifiedRef=refs/heads/${baseRefName}`,
    ]
    const classic = this.parseJson(
      classicProtectionJson,
      await this.run(classicCmd, workspacePath),
      classicCmd,
    )
    if (classic.data.repository === null) {
      throw new Error(`GitHub gate probe could not resolve repository ${identity.nameWithOwner}`)
    }
    if (classic.data.repository.ref === null) {
      throw new Error(
        `GitHub gate probe could not resolve base branch ${JSON.stringify(baseRefName)}`,
      )
    }
    const protection = classic.data.repository.ref.branchProtectionRule
    const classicGate =
      protection !== null &&
      (protection.requiresStatusChecks ||
        protection.requiresApprovingReviews ||
        protection.requiredApprovingReviewCount > 0 ||
        protection.requiresCodeOwnerReviews ||
        protection.requireLastPushApproval ||
        protection.requiresConversationResolution ||
        protection.requiresDeployments ||
        protection.requiresCommitSignatures)

    const rulesCmd = [
      'gh',
      'api',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rules/branches/${encodeURIComponent(baseRefName)}`,
    ]
    const rules = this.parseJson(
      rulesetRulesJson,
      await this.run(rulesCmd, workspacePath),
      rulesCmd,
    )
    const rulesetGate = rulesetsHaveMergeGate(rules)
    return classicGate || rulesetGate ? 'present' : 'absent'
  }

  /** [D1]: rebase is banned and branches are never rewritten — never force. */
  async pushBranch(workspacePath: string, branch: string): Promise<void> {
    await this.run(['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`], workspacePath)
  }

  async openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PrRef> {
    // Idempotent by head branch (SPEC §8.7 crash paths): finalize's `ab done`
    // opens the PR BEFORE appending finalize.completed, so a crash or store
    // failure between the two makes the retry call openPr again. `gh pr
    // create` errors on an existing PR for the head branch; adopting the open
    // PR instead makes the re-run a harmless retry — the same rationale that
    // makes push-before-event safe for implement.
    const listCmd = [
      'gh',
      'pr',
      'list',
      '--head',
      opts.head,
      '--state',
      'open',
      '--json',
      'number,url,headRefOid',
    ]
    const listed = this.parseJson(
      z.array(prViewJson),
      await this.run(listCmd, opts.workspacePath),
      listCmd,
    )
    const existing = listed[0]
    if (existing !== undefined) {
      return {
        number: existing.number,
        url: existing.url,
        headSha: existing.headRefOid,
      }
    }
    const bodyPath = await this.writeTempFile(opts.body)
    await this.run(
      [
        'gh',
        'pr',
        'create',
        '--head',
        opts.head,
        '--base',
        opts.base,
        '--title',
        opts.title,
        '--body-file',
        bodyPath,
      ],
      opts.workspacePath,
    )
    // The number is unknown until the PR exists, so the follow-up view
    // selects by head branch — gh resolves an open PR from its head ref.
    const viewCmd = ['gh', 'pr', 'view', opts.head, '--json', 'number,url,headRefOid']
    const stdout = await this.run(viewCmd, opts.workspacePath)
    const view = this.parseJson(prViewJson, stdout, viewCmd)
    return { number: view.number, url: view.url, headSha: view.headRefOid }
  }

  /** Janitor poll (SPEC §15.7): merged / closed / mergeability for one PR. */
  async getPrState(workspacePath: string, number: number): Promise<PrState> {
    const cmd = ['gh', 'pr', 'view', String(number), '--json', 'state,mergeable,mergeCommit']
    const stdout = await this.run(cmd, workspacePath)
    const view = this.parseJson(prStateJson, stdout, cmd)
    switch (view.state) {
      case 'MERGED': {
        // §15.7 [D1]: pr.merged records the squash commit as the landing
        // point — a merged PR without one is unusable, not mappable.
        if (!view.mergeCommit) {
          throw new Error(`gh reports PR #${number} merged with no mergeCommit`)
        }
        return { state: 'merged', sha: view.mergeCommit.oid }
      }
      case 'CLOSED':
        return { state: 'closed' }
      case 'OPEN':
        return { state: 'open', mergeable: MERGEABLE_MAP[view.mergeable] }
    }
  }

  /** Read the provider's projected native desired state. Mutations are not
   * acknowledgements: only this independent follow-up observation can make an
   * `applied` result durable. */
  private async nativeAutoMergeEnabled(workspacePath: string, number: number): Promise<boolean> {
    const cmd = ['gh', 'pr', 'view', String(number), '--json', 'autoMergeRequest']
    const view = this.parseJson(nativeAutoMergeJson, await this.run(cmd, workspacePath), cmd)
    return view.autoMergeRequest !== null
  }

  /**
   * Reconcile native auto-merge state. A native idempotent hit is acknowledged
   * immediately. Otherwise enabling is classified from authoritative gate
   * existence plus the complete current merge-state enum; only a proved
   * ungated stable PR is returned as a direct candidate. A successful mutation
   * is confirmed with a second native-state read before returning `applied`.
   */
  async setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<AutoMergeResult> {
    // Cancellation must remain usable when GitHub adds a merge-state enum:
    // inspect only the one field disabling actually needs.
    if (!enabled) {
      if (!(await this.nativeAutoMergeEnabled(workspacePath, number))) {
        return { kind: 'applied' }
      }
      await this.run(['gh', 'pr', 'merge', String(number), '--disable-auto'], workspacePath)
      return (await this.nativeAutoMergeEnabled(workspacePath, number))
        ? { kind: 'deferred' }
        : { kind: 'applied' }
    }

    const viewCmd = [
      'gh',
      'pr',
      'view',
      String(number),
      '--json',
      'autoMergeRequest,mergeStateStatus,headRefOid,baseRefName',
    ]
    const view = this.parseJson(autoMergeJson, await this.run(viewCmd, workspacePath), viewCmd)
    if (view.autoMergeRequest !== null) return { kind: 'applied' }

    const gate = await this.mergeGatePresence(workspacePath, view.baseRefName)
    const disposition = classifyAutoMergeEnable(view.mergeStateStatus, gate)
    switch (disposition.kind) {
      case 'native':
        await this.run(['gh', 'pr', 'merge', String(number), '--auto', '--squash'], workspacePath)
        return (await this.nativeAutoMergeEnabled(workspacePath, number))
          ? { kind: 'applied' }
          : { kind: 'deferred' }
      case 'direct':
        return { kind: 'ungated', headSha: view.headRefOid }
      case 'deferred':
        return { kind: 'deferred' }
      case 'error':
        throw new Error(disposition.reason)
    }
  }

  /** Normal guarded squash — no admin, force, rebase, or native-auto flag. */
  async squashMerge(workspacePath: string, number: number, expectedHeadSha: string): Promise<void> {
    await this.run(
      ['gh', 'pr', 'merge', String(number), '--squash', '--match-head-commit', expectedHeadSha],
      workspacePath,
    )
  }

  /** The build's summary comment (SPEC §7.5) — links into the store. */
  async commentOnPr(workspacePath: string, number: number, body: string): Promise<void> {
    const bodyPath = await this.writeTempFile(body)
    await this.run(['gh', 'pr', 'comment', String(number), '--body-file', bodyPath], workspacePath)
  }
}

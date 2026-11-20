import type { Exec } from '../ports/workspace/git-worktree'
import { KERNEL } from '../events/envelope'
import type { BuildStore } from '../store/types'
import { buildTrailers } from './build-identity'
import { history } from './node-restack'
import type { BuildState } from './reducer'

export type IntegrationStackRule =
  | 'not-fast-forward'
  | 'merge-commit'
  | 'non-linear'
  | 'ambiguous-identity'
  | 'duplicate-identity'
  | 'unowned-commit'
  | 'empty-range'

/** A structural refusal: retrying the same verified head cannot succeed.
 * Transient git failures stay plain errors so the janitor retries them. */
export class IntegrationStackViolation extends Error {
  constructor(
    readonly rule: IntegrationStackRule,
    readonly parent: string,
    readonly head: string,
    message: string,
    readonly sha?: string,
  ) {
    super(message)
    this.name = 'IntegrationStackViolation'
  }
}

export interface IntegrationStack {
  /** Contributing build identities, in landing order. */
  builds: string[]
  /** Verified node-owned commits that carry no build identity. */
  handPushed: string[]
}

/** A node has no wrapper identity: every commit retains its contributing
 * build, except node-owned hand-pushed commits, which land as pushed. Node
 * verification records the same first-parent `contributionBase..head` set as
 * `handPushedCommits`, so only the exact verified head's tweaks are owned. */
export async function inspectIntegrationStack(
  exec: Exec,
  cwd: string,
  parent: string,
  head: string,
  ownership: { contributionBase?: string },
): Promise<IntegrationStack> {
  const violation = (rule: IntegrationStackRule, message: string, sha?: string) =>
    new IntegrationStackViolation(rule, parent, head, message, sha)
  const ancestry = await exec(['git', 'merge-base', '--is-ancestor', parent, head], { cwd })
  if (ancestry.exitCode === 1)
    throw violation(
      'not-fast-forward',
      `integration stack parent ${parent} is not an ancestor of head ${head}`,
    )
  if (ancestry.exitCode !== 0) throw new Error('cannot inspect integration stack ancestry')
  const git = { exec, workspacePath: cwd }
  const owned = new Set(
    ownership.contributionBase === undefined
      ? []
      : (await history(git, [`${ownership.contributionBase}..${head}`], ['--first-parent']))
          .filter((commit) => buildTrailers(commit.message).length === 0)
          .map((commit) => commit.sha),
  )
  const builds: string[] = []
  const handPushed: string[] = []
  let previous = parent
  const range = await history(git, [`${parent}..${head}`], ['--reverse'])
  // Name a merge before the side-branch commit it introduces breaks linearity.
  const merge = range.find((commit) => commit.parents.length > 1)
  if (merge)
    throw violation(
      'merge-commit',
      `integration stack commit ${merge.sha} is a merge commit`,
      merge.sha,
    )
  for (const commit of range) {
    const { sha, parents } = commit
    if (parents[0] !== previous)
      throw violation(
        'non-linear',
        `integration stack commit ${sha} does not extend ${previous}`,
        sha,
      )
    const identities = buildTrailers(commit.message)
    if (identities.length > 1)
      throw violation(
        'ambiguous-identity',
        `integration stack commit ${sha} carries several build identities (${identities.join(', ')})`,
        sha,
      )
    if (identities.length === 0) {
      if (!owned.has(sha))
        throw violation(
          'unowned-commit',
          `integration stack commit ${sha} has no Autobuild-Build trailer and is not a verified node-owned hand-pushed commit`,
          sha,
        )
      handPushed.push(sha)
    } else if (builds.includes(identities[0]!)) {
      throw violation(
        'duplicate-identity',
        `integration stack commit ${sha} repeats build identity ${identities[0]}`,
        sha,
      )
    } else builds.push(identities[0]!)
    previous = sha
  }
  if (previous === parent)
    throw violation('empty-range', `integration stack range ${parent}..${head} is empty`)
  if (previous !== head)
    throw violation('non-linear', `integration stack does not end at head ${head}`, previous)
  return { builds, handPushed }
}

/** One open attention per refused head; a bare retry answer re-enables one
 * further attempt, which lands or raises the next occurrence. */
export async function raiseIntegrationStackAttention(
  store: BuildStore,
  slug: string,
  state: Pick<BuildState, 'openEscalations' | 'answeredEscalations'>,
  violation: IntegrationStackViolation,
): Promise<void> {
  const prefix = `integration-stack:${violation.head}:`
  if (state.openEscalations.some((item) => item.id.startsWith(prefix))) return
  const n = 1 + state.answeredEscalations.filter((item) => item.id.startsWith(prefix)).length
  await store.append(slug, {
    actor: KERNEL,
    type: 'escalation.raised',
    payload: {
      id: `${prefix}${n}`,
      phase: 'verify:integration',
      source: 'agent',
      question: `Node landing refused: ${violation.message}. Verified parent ${violation.parent}, head ${violation.head}. Autobuild will not retry this head. Make the node branch linear and give every commit one unique Autobuild-Build identity or keep it a node-owned hand-pushed commit (a new head re-verifies), then run \`ab answer ${slug}\` for a bare retry to attempt this head again.`,
    },
  })
}

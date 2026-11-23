import { z } from 'zod'
import type { Forge } from '../types'

/** Every check a `dispatcher.forge-readiness-failed` fact may name, including
 * `archive-refs`, which historical facts recorded while it was required. */
export const readinessFailureKeys = [
  'squash',
  'rebase',
  'build-refs',
  'node-refs',
  'archive-refs',
] as const
/** Checks whose failure stops publication. */
export const hardReadinessKeys = ['squash', 'rebase', 'build-refs', 'node-refs'] as const
export const readinessKeySchema = z.enum([
  'squash',
  'rebase',
  'build-refs',
  'node-refs',
  'archive-refs',
  'linear-history',
  'root-freshness',
])
export type ReadinessKey = z.infer<typeof readinessKeySchema>
export const forgeReadinessCheckSchema = z.object({
  check: readinessKeySchema,
  requirement: z.enum(['hard', 'recommendation']),
  status: z.enum(['pass', 'fail', 'unknown']),
  detail: z.string().min(1),
  remediation: z.string().min(1),
})
export type ForgeReadinessCheck = z.infer<typeof forgeReadinessCheckSchema>
export interface ForgeReadinessInput {
  rootBranch: string
}

const inventory: readonly [ReadinessKey, string][] = [
  ['squash', 'Enable Settings → General → Allow squash merging.'],
  ['rebase', 'Enable Settings → General → Allow rebase merging.'],
  [
    'build-refs',
    'Allow Contents:write and direct force pushes throughout refs/heads/ab/ in branch protection and rulesets.',
  ],
  [
    'node-refs',
    'Allow Contents:write and direct force pushes throughout refs/heads/ab-node/ in branch protection and rulesets.',
  ],
  [
    'archive-refs',
    'Optional: allow immutable refs/autobuild/archive/ refs as forge-side backup of displaced leaf history. Where refused, leaf restacks and reconciles keep a BuildStore copy or warn and proceed. Node restack and landing still publish archive refs.',
  ],
  ['linear-history', 'Enable Require linear history on protected root and node target branches.'],
  [
    'root-freshness',
    'Require branches to be up to date before merging on the root, with nonempty required checks enforced for all actors; otherwise root merge is best-effort rather than fenced.',
  ],
]
export function readinessChecks(
  status: ForgeReadinessCheck['status'],
  detail: string,
): ForgeReadinessCheck[] {
  return inventory.map(([check, remediation]) => ({
    check,
    requirement: (hardReadinessKeys as readonly string[]).includes(check)
      ? 'hard'
      : 'recommendation',
    status,
    detail,
    remediation,
  }))
}
export async function inspectForgeReadiness(
  forge: Forge,
  input: ForgeReadinessInput,
): Promise<ForgeReadinessCheck[]> {
  if (!forge.inspectReadiness)
    return readinessChecks(
      'unknown',
      'Forge adapter does not implement readiness inspection; upgrade the adapter.',
    )
  try {
    const checks = z.array(forgeReadinessCheckSchema).parse(await forge.inspectReadiness(input))
    const defaults = readinessChecks('unknown', 'Adapter omitted this check; upgrade the adapter.')
    return defaults.map((fallback) => {
      const matches = checks.filter((item) => item.check === fallback.check)
      return matches.length === 1 ? { ...matches[0]!, requirement: fallback.requirement } : fallback
    })
  } catch {
    return readinessChecks(
      'unknown',
      'Forge inspection unavailable. Grant Metadata:read and Administration:read (classic private repositories: repo scope), then revalidate. Contents:write is separately required for publication.',
    )
  }
}
export function readinessLabel(check: ForgeReadinessCheck): string {
  return check.status === 'unknown'
    ? 'UNKNOWN'
    : check.status === 'fail' && check.requirement === 'recommendation'
      ? 'WARN'
      : check.status.toUpperCase()
}
export function formatReadinessFailure(check: {
  check: string
  detail: string
  remediation: string
}): string {
  return `Forge ${check.check}: ${check.detail} ${check.remediation}`
}
export function formatForgeReadiness(check: ForgeReadinessCheck): string {
  return `${readinessLabel(check)} ${formatReadinessFailure(check)}`
}

/** Startup warning when the adapter cannot prove a build branch is free on the
 * remote: slugs then dedupe against this store only (AUT-1106). */
export function branchGuardWarnings(forge: Pick<Forge, 'name' | 'remoteBranchExists'>): string[] {
  return forge.remoteBranchExists === undefined
    ? [
        `forge ${forge.name}: cross-store branch collision protection is unavailable — the adapter lacks remoteBranchExists, so build slugs are deduplicated against this store only and a target node built by another store is recognized only by its claimed ticket. Upgrade the adapter, and run every dispatcher on one shared store (ab connect).`,
      ]
    : []
}

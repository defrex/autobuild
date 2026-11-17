import { createHash } from 'node:crypto'
import type { LandingRule } from '../config/schema'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** A stable identity of the evaluated `[[merge]]` rules, independent of key
 * order: a recorded landing deferral holds only while the policy is unchanged.
 * Kept out of `landing-policy.ts`, which the web dashboard bundles. */
export function landingPolicyIdentity(rules: readonly LandingRule[]): string {
  return `sha256:${createHash('sha256').update(canonical(rules)).digest('hex')}`
}

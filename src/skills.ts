/** Repo-installed Autobuild skills share one harness-neutral namespace. */
export const SKILL_NAMESPACE = 'ab-'

/** Add the namespace once, accepting explicit namespaced config values too. */
export function installedSkillName(name: string): string {
  return name.startsWith(SKILL_NAMESPACE) ? name : `${SKILL_NAMESPACE}${name}`
}

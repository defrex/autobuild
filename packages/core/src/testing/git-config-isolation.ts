/** The variables through which the shared test runner (`tools/test-temp-leaks.ts`)
 * isolates every suite child from the developer's global, XDG and system git
 * config. */
export const GIT_CONFIG_ISOLATION_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
] as const

/**
 * The defined git config isolation variables in `env`. A test that spawns a
 * subprocess with a hand-picked environment forwarding the real `HOME` must
 * spread this next to it, or the child rediscovers the developer's
 * `~/.gitconfig` and `~/.config/git/config` (rerere, signing, …).
 */
export function inheritedGitConfigIsolation(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of GIT_CONFIG_ISOLATION_KEYS) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

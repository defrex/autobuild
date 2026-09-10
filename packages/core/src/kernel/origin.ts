/**
 * Dependency-free repository-origin helpers.
 *
 * Repository identity in the BuildStore, dispatcher, `ab builds`,
 * `ab repository status`, and the web app is the repository's normalized
 * origin URL, not a checkout path — a path-based identity makes two hosts
 * disagree about which repository they operate. These helpers live in the
 * kernel layer so ports code (the GitHub REST forge) and the hosted store
 * service can share them without importing the CLI layer.
 */

/**
 * Location-independent form of a git remote URL, for comparing a recorded
 * repository origin with the origin of the current checkout. Trims; maps
 * scp-like `git@host:path` (and bare `host:path`) remotes and explicit
 * `ssh://`/`git://` URLs to their `https://` spelling; drops credentials;
 * lowercases the host; strips a trailing `.git` and trailing slashes.
 * Anything unparseable — notably a local-path remote — is returned trimmed
 * as-is, so such remotes only ever compare equal to themselves.
 */
export function normalizeGitRemoteUrl(raw: string): string {
  const trimmed = raw.trim()
  // scp-like syntax: `[user@]host:relative/path`. A colon followed by an
  // absolute path (or a Windows drive letter) is not scp-like — leave it for
  // URL parsing, which fails and falls through to the trimmed passthrough.
  const scp =
    trimmed.includes('://') || /^[A-Za-z]:/.test(trimmed)
      ? null
      : /^(?:[^@/]+@)?([^/:]+):([^/].*)$/.exec(trimmed)
  const candidate = scp !== null ? `https://${scp[1]}/${scp[2]}` : trimmed
  try {
    const url = new URL(candidate)
    // Only network URLs carry a host; a Windows drive or relative path parses
    // as a scheme-only URL and passes through untouched.
    if (url.hostname === '') return trimmed
    const path = url.pathname.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
    // ssh and git URLs name the same repository as their https spelling, so
    // an ssh-origin host checkout and the sandbox guest's pinned https origin
    // must normalize to one form (the scp-like branch already does).
    const protocol =
      url.protocol === 'ssh:' || url.protocol === 'git:' || url.protocol === 'git+ssh:'
        ? 'https:'
        : url.protocol
    return `${protocol}//${url.host.toLowerCase()}${path}`
  } catch {
    return trimmed
  }
}

/**
 * Whether `ref` is a valid exact Git branch name, by git-check-ref-format(1)'s
 * rules: no leading `-`, no `..`, none of `~^:?*[\` anywhere, no ASCII
 * control characters or space, no `@{`, not bare `@`, no trailing `.lock`
 * or `.`, and no empty slash-delimited components. The REST forge uses this
 * to reject a branch name before interpolating it into a ref endpoint,
 * replacing the host `git check-ref-format` subprocess.
 */
export function isValidGitBranchName(branch: string): boolean {
  if (branch === '' || branch.startsWith('-')) return false
  if (branch.endsWith('.lock') || branch.endsWith('.')) return false
  if (branch.includes('..') || branch.includes('@{') || branch === '@') return false
  for (const char of branch) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return false
    if ('~^:?*[\\ '.includes(char)) return false
  }
  // No empty slash-delimited component (`a//b`, leading/trailing slash).
  return branch.split('/').every((component) => component !== '')
}

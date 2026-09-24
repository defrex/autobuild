/**
 * The registration-time policy for DCR-supplied OAuth client names (AUT-399).
 *
 * A dynamically registered client's `client_name` is an untrusted,
 * attacker-chosen *label* that the consent page renders on a
 * security-decision surface. These rules bound what that label can contain;
 * they do NOT authenticate the client — a name is not an identity, and the
 * consent page keeps the raw `client_id` visible precisely for that reason.
 * In particular, impersonation-by-wording ("Acme Official") is explicitly not
 * prevented; the goal is bounding a hostile label's content, not judging
 * intent.
 *
 * Four rules, deliberately modest:
 * 1. The trimmed name must be non-empty (an unnamed client is legal — the
 *    consent page then falls back to the raw client_id — but a name that is
 *    only whitespace is not).
 * 2. The trimmed name is at most CLIENT_NAME_MAX_LENGTH code points (Unicode
 *    characters — an emoji counts as one).
 * 3. No C0/C1 control characters (U+0000–U+001F, U+007F–U+009F).
 * 4. No invisible or bidi formatting characters (U+200B–U+200F,
 *    U+202A–U+202E, U+2066–U+2069, U+FEFF) — these exist to make rendered
 *    text lie about its content.
 *
 * Everything else is allowed: any Unicode letters, digits, spaces,
 * punctuation, emoji. HTML/JS injection is out of scope for these rules
 * because the consent page is a React text interpolation, which escapes.
 */

/** The longest trimmed client name registration accepts. */
export const CLIENT_NAME_MAX_LENGTH = 64

/** Control characters and invisible/bidi formatting characters, per the
 * module docstring. Checked against the trimmed name. */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/** Return a short human-readable reason the name violates the policy, or
 * null when the name conforms. Both the registration hook and the consent
 * page's name lookup call this, so the page never renders a name that
 * violates the rules — including rows registered before the policy existed. */
export function clientNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'client_name must not be empty'
  const codePointCount = [...trimmed].length
  if (codePointCount > CLIENT_NAME_MAX_LENGTH) {
    return `client_name must be at most ${CLIENT_NAME_MAX_LENGTH} characters`
  }
  const found = [...trimmed].find((character) => FORBIDDEN.test(character))
  if (found) {
    const codePoint = found.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    return `client_name must not contain control or invisible formatting characters (found U+${codePoint})`
  }
  return null
}

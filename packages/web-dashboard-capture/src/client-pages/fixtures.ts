/**
 * Browser-safe constants shared by the client-load harness modules (bundled
 * into Chromium) and `client-load.ts` (which serves the matching fixture
 * responses). Nothing here may import Bun-only code.
 */
export const FIXTURE_REPO = 'example/repository'
export const ALTERNATE_FIXTURE_REPO = 'example/alternate'
export const FIXTURE_IDENTITY = 'operator@example.com'
/** A build the capture's `mixed` model carries, so its page renders a real row there. */
export const FIXTURE_BUILD_SLUG = 'implement-blocked-dashboard'
/** The ticket the fixture build was claimed from; its detail is always served. */
export const FIXTURE_TICKET_ID = 'CAP-IMPLEMENT'
export const FIXTURE_ORGANIZATION = 'acme'
export const FIXTURE_CONSENT_CODE = 'capture-consent-code'
export const FIXTURE_REPOSITORIES = [FIXTURE_REPO, ALTERNATE_FIXTURE_REPO] as const

/** The props every operator page derives from the signed-in session. */
export const OPERATOR_SESSION = {
  identity: FIXTURE_IDENTITY,
  isOwner: true,
  isSuperUser: true,
} as const

/** The dashboard pages' shared `operatorPage` props. */
export const OPERATOR_PAGE = {
  ...OPERATOR_SESSION,
  initialSelection: FIXTURE_REPO,
  repositories: FIXTURE_REPOSITORIES,
} as const

export const OPERATOR_QUERY = `repo=${encodeURIComponent(FIXTURE_REPO)}`

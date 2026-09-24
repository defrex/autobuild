import type { ClientNameLookup } from './client-name'
import { registeredClientName } from './client-name'
import { ConsentForm } from './ConsentForm'

export interface ConsentQuery {
  consent_code?: string
  client_id?: string
  scope?: string
}

/** The consent request sentence, held once so the named and unnamed render
 * paths cannot silently diverge on copy. Parameterized by the registered
 * client label; a null name renders the unnamed-client wording. */
function ConsentRequestCopy({
  clientName,
  clientId,
}: {
  clientName: string | null
  clientId: string
}) {
  return (
    <p>
      {clientName ? (
        <>
          <strong>{clientName}</strong> (registered as <code>{clientId}</code>)
        </>
      ) : (
        <>
          A client registered as <code>{clientId}</code>
        </>
      )}{' '}
      requests operator access to this deployment's Autobuild tools, acting under your signed-in
      identity.
    </p>
  )
}

/** The OAuth consent view the MCP plugin's authorize flow redirects to when a
 * client sends `prompt=consent`. Markup reuses the sign-in page's existing
 * classes (frame signin, masthead, card, btn) under DESIGN.md's rules. The
 * `lookupClientName` prop is a test seam placed on this ordinary component —
 * not on the route module's exported page — because Next.js's strict
 * page-props guard rejects any prop the framework does not supply. A
 * rejecting lookup degrades to the raw client_id, never an error. */
export async function Consent({
  query,
  lookupClientName = registeredClientName,
}: {
  query: ConsentQuery
  lookupClientName?: ClientNameLookup
}) {
  let clientName: string | null = null
  if (query.client_id) {
    try {
      clientName = await lookupClientName(query.client_id)
    } catch {
      clientName = null
    }
  }
  return (
    <main className="frame signin">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span>Autobuild operator</span>
        </h1>
      </header>
      <div className="signin-centre">
        <section className="card" aria-labelledby="consent-title">
          <h2 id="consent-title">Authorize client</h2>
          {query.client_id ? (
            <ConsentRequestCopy clientName={clientName} clientId={query.client_id} />
          ) : (
            <p>A client requests operator access to this deployment's Autobuild tools.</p>
          )}
          {query.scope && <p>Requested scopes: {query.scope}</p>}
          {query.consent_code ? (
            <ConsentForm consentCode={query.consent_code} />
          ) : (
            <p className="warn notice">This consent request is missing its authorization code.</p>
          )}
        </section>
      </div>
    </main>
  )
}

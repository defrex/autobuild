import { registeredClientName, type ClientNameLookup } from './client-name'
import { ConsentForm } from './ConsentForm'

export const dynamic = 'force-dynamic'

/** The OAuth consent page the MCP plugin's authorize flow redirects to when a
 * client sends `prompt=consent`. Markup reuses the sign-in page's existing
 * classes (frame signin, masthead, card, btn) under DESIGN.md's rules. The
 * `lookupClientName` second argument is a test seam — Next.js never supplies
 * it — and a rejecting lookup degrades to the raw client_id, never an error. */
export default async function ConsentPage({
  searchParams,
  lookupClientName = registeredClientName,
}: {
  searchParams: Promise<{ consent_code?: string; client_id?: string; scope?: string }>
  lookupClientName?: ClientNameLookup
}) {
  const query = await searchParams
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
            clientName ? (
              <p>
                <strong>{clientName}</strong> (registered as <code>{query.client_id}</code>)
                requests operator access to this deployment's Autobuild tools, acting under your
                signed-in identity.
              </p>
            ) : (
              <p>
                A client registered as <code>{query.client_id}</code> requests operator access to
                this deployment's Autobuild tools, acting under your signed-in identity.
              </p>
            )
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

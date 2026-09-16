import { ConsentForm } from './ConsentForm'

export const dynamic = 'force-dynamic'

/** The OAuth consent page the MCP plugin's authorize flow redirects to when a
 * client sends `prompt=consent`. Markup reuses the sign-in page's existing
 * classes (frame signin, masthead, card, btn) under DESIGN.md's rules. */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ consent_code?: string; client_id?: string; scope?: string }>
}) {
  const query = await searchParams
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
            <p>
              A client registered as <code>{query.client_id}</code> requests operator access to this
              deployment's Autobuild tools, acting under your signed-in identity.
            </p>
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

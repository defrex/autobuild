'use client'

import { useState } from 'react'

const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub' }

export function SignIn({ providers, error }: { providers: readonly string[]; error?: string }) {
  const [pending, setPending] = useState(false)
  async function signIn(provider: string) {
    setPending(true)
    const response = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider,
        callbackURL: '/',
        errorCallbackURL: '/sign-in?error=access_denied',
      }),
    })
    if (!response.ok) {
      setPending(false)
      return
    }
    const body = (await response.json()) as { url?: string }
    if (body.url) window.location.assign(body.url)
    else setPending(false)
  }
  return (
    <main className="frame signin">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span>Autobuild operator</span>
        </h1>
        <p className="masthead-copy imperative" data-tone={error ? 'alert' : undefined}>
          {error && <span>REFUSED</span>}
        </p>
        <span className="clock" aria-hidden />
      </header>
      <div className="signin-centre">
        <section className="card" aria-labelledby="signin-title">
          <h2 id="signin-title">Sign in</h2>
          <p>Use an identity allowed by this deployment's operator.</p>
          {error && (
            <p className="alert notice" role="alert">
              Access was refused. Ask the deployment operator to check the allowlist.
            </p>
          )}
          <div className="providers">
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => signIn(provider)}
              >
                <span>
                  {pending
                    ? 'Redirecting...'
                    : `Continue with ${PROVIDER_NAMES[provider] ?? provider}`}
                </span>
              </button>
            ))}
            {providers.length === 0 && (
              <p className="warn notice">No sign-in provider is configured for this deployment.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

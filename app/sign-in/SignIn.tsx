'use client'

import { useState } from 'react'

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
    <main className="signin">
      <section className="card" aria-labelledby="signin-title">
        <p className="eyebrow">Autobuild operator</p>
        <h1 id="signin-title">Sign in</h1>
        <p>Use an identity allowed by this deployment’s operator.</p>
        {error && (
          <p className="error" role="alert">
            Access was refused. Ask the deployment operator to check the allowlist.
          </p>
        )}
        {providers.map((provider) => (
          <button key={provider} type="button" disabled={pending} onClick={() => signIn(provider)}>
            {pending
              ? 'Redirecting…'
              : `Continue with ${provider === 'github' ? 'GitHub' : provider}`}
          </button>
        ))}
      </section>
    </main>
  )
}

'use client'

import { useState } from 'react'

export function ConsentForm({ consentCode }: { consentCode: string }) {
  const [pending, setPending] = useState(false)
  async function accept() {
    setPending(true)
    const response = await fetch('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    })
    if (!response.ok) {
      setPending(false)
      return
    }
    const body = (await response.json()) as { redirectURI?: string }
    if (body.redirectURI) window.location.assign(body.redirectURI)
    else setPending(false)
  }
  return (
    <div className="providers">
      <button type="button" className="btn" disabled={pending} onClick={() => accept()}>
        <span>{pending ? 'Authorizing...' : 'Authorize client'}</span>
      </button>
    </div>
  )
}

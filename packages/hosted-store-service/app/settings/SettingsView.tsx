'use client'

import { useState } from 'react'
import { SECRET_NAME_EXPLANATION, validateSecretName } from '@defrex/autobuild/secret-name'
import type { ProjectSettings } from '../../src/web/project-secrets'
import { ConfirmDialog } from '../dashboard/ConfirmDialog'

export interface SettingsViewProps {
  data?: ProjectSettings
  pending?: string
  error?: string
  removing?: string
  onSet: (name: string, value: string) => Promise<boolean>
  onRemove: (name?: string) => void
  onConfirm: () => void
}
function SecretForm({
  name,
  pendingName,
  onSet,
}: {
  name?: string
  pendingName?: string
  onSet: SettingsViewProps['onSet']
}) {
  const [entry, setEntry] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const pending = pendingName !== undefined
  const saving = pendingName !== undefined && pendingName === (name ?? entry)
  return (
    <form
      className="secret-form"
      onSubmit={async (event) => {
        event.preventDefault()
        try {
          validateSecretName(name ?? entry)
        } catch {
          setError(SECRET_NAME_EXPLANATION)
          return
        }
        setError('')
        if (await onSet(name ?? entry, value)) {
          setValue('')
          setEntry('')
        }
      }}
    >
      {!name && (
        <label>
          Name
          <input
            required
            autoComplete="off"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            disabled={pending}
          />
        </label>
      )}
      <label>
        {name ? 'Replacement value' : 'Value'}
        <input
          required
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
        />
      </label>
      <button className="btn primary" type="submit" disabled={pending}>
        {saving ? 'Saving…' : name ? 'Replace' : 'Add secret'}
      </button>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
export function SettingsView({
  data,
  pending,
  error,
  removing,
  onSet,
  onRemove,
  onConfirm,
}: SettingsViewProps) {
  return (
    <section className="settings-page">
      <h2>Settings</h2>
      <p>
        Project secrets are shared by this project. Values are write-only and are never shown again.
      </p>
      {error && removing === undefined && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <section className="section">
        <h3>Secrets</h3>
        {!data ? (
          <p className="slack">Loading project secrets.</p>
        ) : (
          <>
            {!data.secrets.length && <p className="slack">No project secrets have been set.</p>}
            <ul className="secret-rows">
              {data.secrets.map((secret) => (
                <li key={secret.name}>
                  <div className="secret-heading">
                    <strong>{secret.name}</strong>
                    <code>{secret.kind}</code>
                    <span
                      className={
                        secret.status === 'failed'
                          ? 'alert'
                          : secret.status === 'refreshing'
                            ? 'warn'
                            : 'ok'
                      }
                    >
                      {secret.status}
                      {secret.failureCode && ` · ${secret.failureCode}`}
                    </span>
                  </div>
                  <dl className="secret-facts">
                    <div>
                      <dt>Owner</dt>
                      <dd>{secret.owner}</dd>
                    </div>
                    <div>
                      <dt>Set</dt>
                      <dd>{secret.setAt}</dd>
                    </div>
                    <div>
                      <dt>Fingerprint</dt>
                      <dd>{secret.fingerprint}</dd>
                    </div>
                    <div>
                      <dt>Last supplied</dt>
                      <dd>{secret.lastSuppliedAt ?? 'never supplied'}</dd>
                    </div>
                  </dl>
                  {secret.warnings?.includes('refresh-window-too-short') && (
                    <p className="warn">
                      The refresh window is shorter than the dispatch interval.
                    </p>
                  )}
                  {secret.kind === 'static' ? (
                    <SecretForm name={secret.name} pendingName={pending} onSet={onSet} />
                  ) : (
                    <div>
                      <p>Sign in again from the CLI to renew this credential.</p>
                      {data.accounts.filter((a) => a.credentialEnv === secret.name).length ? (
                        data.accounts
                          .filter((a) => a.credentialEnv === secret.name)
                          .map((a) => (
                            <p key={a.name}>
                              <code>ab accounts login {shellAccount(a.name)} --project</code>
                            </p>
                          ))
                      ) : (
                        <>
                          <p>
                            Find the account name in project configuration. Replace the placeholder
                            below:
                          </p>
                          <p>
                            <code>ab accounts login &lt;account&gt; --project</code>
                          </p>
                        </>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn ghost danger"
                    disabled={pending !== undefined}
                    onClick={() => onRemove(secret.name)}
                  >
                    Remove {secret.name}
                  </button>
                </li>
              ))}
            </ul>
            <h3>Add a secret</h3>
            <SecretForm pendingName={pending} onSet={onSet} />
          </>
        )}
      </section>
      <section className="section">
        <h3>Account credentials</h3>
        {!data ? (
          <p className="slack">Loading account configuration.</p>
        ) : data.configuration !== 'available' ? (
          <p className="slack">
            {data.configuration === 'no-dispatcher'
              ? 'No dispatcher run is recorded yet. Account configuration is not available.'
              : 'Recorded account configuration is unavailable. Secret management is still available.'}
          </p>
        ) : !data.accounts.length ? (
          <p className="slack">No accounts are declared in the effective configuration.</p>
        ) : (
          <ul className="secret-rows">
            {data.accounts.map((account) => (
              <li key={account.name}>
                <div className="secret-heading">
                  <strong>{account.name}</strong>
                  <code>{account.kind}</code>
                  <code>{account.credentialEnv}</code>
                  <span className={account.ready ? 'ok' : 'alert'}>
                    {account.ready
                      ? 'ready'
                      : data.secrets.some((s) => s.name === account.credentialEnv)
                        ? 'unavailable'
                        : 'missing'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removing ?? 'secret'}?`}
        confirmLabel={pending ? 'Removing…' : 'Remove secret'}
        pending={pending !== undefined}
        onConfirm={onConfirm}
        onCancel={() => onRemove()}
      >
        <p>Builds using {removing} lose that credential at the next observation.</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </section>
  )
}
function shellAccount(name: string) {
  return /^[a-zA-Z0-9_-]+$/.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`
}

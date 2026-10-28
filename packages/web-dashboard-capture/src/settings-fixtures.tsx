import { SettingsView } from '../../hosted-store-service/app/settings/SettingsView'
import { OperatorShell } from '../../hosted-store-service/app/dashboard/Shell'
import { ViewTabs } from '../../hosted-store-service/app/dashboard/tickets'
import type { ProjectSettings } from '../../hosted-store-service/src/web/project-secrets'
export const SETTINGS_SCENARIOS = [
  'empty',
  'credentials',
  'no-dispatcher',
  'pending',
  'refused',
  'remove',
] as const
export function settingsFixture(id: string) {
  if (!id.startsWith('settings-')) return undefined
  const state = id.slice(9).replace(/-(wide|narrow)$/, '')
  const data: ProjectSettings = {
    configuration: state === 'no-dispatcher' ? 'no-dispatcher' : 'available',
    accounts:
      state === 'empty' || state === 'no-dispatcher'
        ? []
        : [
            {
              name: 'personal-chatgpt',
              kind: 'chatgpt-subscription',
              credentialEnv: 'CHATGPT_ACCESS_TOKEN',
              ready: false,
            },
            {
              name: 'claude',
              kind: 'claude-subscription',
              credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
              ready: false,
            },
          ],
    secrets:
      state === 'empty'
        ? []
        : [
            {
              name: 'KIMI_API_KEY',
              kind: 'static',
              owner: 'operator-with-a-long-email@example.com',
              setAt: '2026-10-27T12:00:00.000Z',
              fingerprint: '0123456789abcdef',
              status: 'ready',
              failureCode: null,
              lastSuppliedAt: null,
            },
            {
              name: 'CHATGPT_ACCESS_TOKEN',
              kind: 'chatgpt-subscription',
              owner: 'operator@example.com',
              setAt: '2026-10-27T12:00:00.000Z',
              fingerprint: 'abcdef0123456789',
              status: 'refreshing',
              failureCode: null,
              lastSuppliedAt: '2026-10-27T13:00:00.000Z',
              warnings: ['refresh-window-too-short'],
            },
            {
              name: 'OTHER_CHATGPT_TOKEN',
              kind: 'chatgpt-subscription',
              owner: 'operator@example.com',
              setAt: '2026-10-27T12:00:00.000Z',
              fingerprint: 'abcdef0123456789',
              status: 'failed',
              failureCode: 'refresh-failed',
              lastSuppliedAt: null,
            },
          ],
  }
  return (
    <OperatorShell
      repo="example/repository"
      repositories={['example/repository']}
      identity="operator@example.com"
      onRepo={() => {}}
      onSignOut={() => {}}
      tabs={
        <ViewTabs
          repo="example/repository"
          current="settings"
          page
          counts={{ triage: 3, queue: 2, active: '4/8' }}
        />
      }
      controls={null}
    >
      <SettingsView
        data={data}
        pending={state === 'pending' ? '' : undefined}
        error={
          state === 'refused'
            ? 'The service’s project-secret encryption key is not configured or usable. An administrator must fix it.'
            : undefined
        }
        removing={state === 'remove' ? 'KIMI_API_KEY' : undefined}
        onSet={async () => false}
        onRemove={() => {}}
        onConfirm={() => {}}
      />
    </OperatorShell>
  )
}

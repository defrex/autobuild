import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsView } from './SettingsView'
import type { ProjectSettings } from '../../src/web/project-secrets'
const data: ProjectSettings = {
  configuration: 'available',
  accounts: [
    {
      name: 'personal',
      kind: 'chatgpt-subscription',
      credentialEnv: 'CHATGPT_TOKEN',
      ready: false,
    },
  ],
  secrets: [
    {
      name: 'CHATGPT_TOKEN',
      kind: 'chatgpt-subscription',
      owner: 'member@example.com',
      setAt: '2026-10-27T00:00:00Z',
      fingerprint: '0123456789abcdef',
      status: 'failed',
      failureCode: 'refresh-failed',
      lastSuppliedAt: null,
    },
  ],
}
function render(extra = {}) {
  return renderToStaticMarkup(
    <SettingsView
      data={data}
      onSet={async () => false}
      onRemove={() => {}}
      onConfirm={() => {}}
      {...extra}
    />,
  )
}
test('refreshing kinds show CLI guidance, safe metadata and no replacement field', () => {
  const html = render()
  expect(html).toContain('ab accounts login personal --project')
  expect(html).not.toContain('Replacement value')
  expect(html).toContain('never supplied')
  expect(html).toContain('refresh-failed')
  expect(html).toContain('unavailable')
  expect(html.match(/type="password"/g)).toHaveLength(1) // Only the add form.
  expect(html).toContain('autoComplete="off"')
  expect(html).not.toContain('<dialog open')
})
test('pending controls, removal confirmation and no-dispatcher presentation', () => {
  const html = render({ pending: 'CHATGPT_TOKEN', removing: 'CHATGPT_TOKEN' })
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('Saving…')
  expect(html).toContain('Remove CHATGPT_TOKEN?')
  expect(html).toContain('next observation')
  const noRun = render({ data: { ...data, configuration: 'no-dispatcher' } })
  expect(noRun).toContain('No dispatcher run is recorded')
  expect(noRun).toContain('CHATGPT_TOKEN')
})

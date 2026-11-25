import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsView } from './SettingsView'
import { copyToClipboard } from './McpConnector'
import type { ProjectSettings } from '@defrex/autobuild-hosted-store-service/operator-api'
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
const MCP_URL = 'https://operator.example/mcp/github.com/owner/repo'
function render(extra = {}) {
  return renderToStaticMarkup(
    <SettingsView
      mcpUrl={MCP_URL}
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
test('the MCP connector shows the URL in a well with a word copy control and no glyph', () => {
  const html = render()
  expect(html).toContain('<h3>MCP connector</h3>')
  expect(html).toMatch(new RegExp(`class="m mcp-url"[^>]*>${MCP_URL}</div>`))
  expect(html).toContain('connect it as this project&#x27;s operator')
  expect(html).toContain('asks you to sign in')
  expect(html).toMatch(/data-state="idle"[^>]*>.*<span aria-hidden="true" data-shown="">COPY</)
  expect(html).not.toContain('<svg')
  expect(html).not.toMatch(/\p{Extended_Pictographic}/u)
  expect(render({ mcpCopyState: 'copied' })).toMatch(/data-shown="">COPIED</)
  expect(render({ mcpCopyState: 'refused' })).toMatch(/data-shown="">REFUSED</)
})
test('copying reports a refusal for a rejected or missing clipboard', async () => {
  const written: string[] = []
  expect(await copyToClipboard({ writeText: async (text) => void written.push(text) }, 'u')).toBe(
    'copied',
  )
  expect(written).toEqual(['u'])
  expect(
    await copyToClipboard(
      {
        writeText: async () => {
          throw new Error('denied')
        },
      },
      'u',
    ),
  ).toBe('refused')
  expect(await copyToClipboard(undefined, 'u')).toBe('refused')
})

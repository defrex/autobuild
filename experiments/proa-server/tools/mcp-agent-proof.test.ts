import { expect, test } from 'bun:test'
import { proofArguments, proofEnvironment, redact, transcriptCalls } from './mcp-agent-proof'
test('child receives only MCP authority and isolated CLI settings', () => {
  expect(proofArguments('/private/config')).toEqual([
    'claude',
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '/private/config',
    '--tools',
    '',
    '--allowedTools',
    'mcp__proa__*',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
  ])
  expect(
    proofEnvironment({
      AB_BUILD: 'build',
      AB_SESSION: 'session',
      PROA_DEV_AUTH_CAPABILITY: 'capability',
      DATABASE_URL: 'database',
      GITHUB_TOKEN: 'git',
      OTHER_SERVICE_KEY: 'remove',
      MCP_TOKEN: 'remove',
      ANTHROPIC_API_KEY: 'provider',
      PATH: '/bin',
    }),
  ).toEqual({ ANTHROPIC_API_KEY: 'provider', PATH: '/bin' })
})
test('redaction covers nested headers, known opaque values and bearer strings', () => {
  expect(
    redact(
      {
        headers: { Authorization: 'Bearer private' },
        cookie: 'session',
        code_verifier: 'verifier',
        text: 'opaque Bearer private',
      },
      ['opaque'],
    ),
  ).toEqual({
    headers: { Authorization: '[REDACTED]' },
    cookie: '[REDACTED]',
    code_verifier: '[REDACTED]',
    text: '[REDACTED] Bearer [REDACTED]',
  })
})
test('prose and successful exit cannot substitute for real successful calls', () => {
  expect(() =>
    transcriptCalls([
      { type: 'system', subtype: 'init', tools: ['Bash'] },
      { type: 'result', subtype: 'success' },
    ]),
  ).toThrow('unexpected child tools')
  expect(() =>
    transcriptCalls([
      { type: 'system', subtype: 'init', tools: ['mcp__proa__builds_list'] },
      { type: 'result', subtype: 'success' },
    ]),
  ).toThrow('missing successful real builds.list')
})

test('bounded child closes stdin and terminates an unresponsive process', async () => {
  const { runBoundedAgent } = await import('./mcp-agent-proof')
  const completed = await runBoundedAgent(
    ['bun', '-e', 'process.stdout.write(await new Response(Bun.stdin.stream()).text())'],
    process.cwd(),
    proofEnvironment(process.env),
    'closed-input',
    5000,
  )
  expect(completed.stdout).toBe('closed-input')
  expect(completed.exit).toBe(0)
  expect(completed.timedOut).toBe(false)
  const stalled = await runBoundedAgent(
    ['bun', '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    process.cwd(),
    proofEnvironment(process.env),
    '',
    100,
  )
  expect(stalled.timedOut).toBe(true)
  expect(stalled.exit).not.toBe(0)
})

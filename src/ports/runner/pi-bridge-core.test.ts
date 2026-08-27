import { describe, expect, test } from 'bun:test'
import {
  installAutobuildBridge,
  type BridgeApi,
  type BridgeBashToolFactory,
  type BridgeCommandContext,
  type BridgeTool,
} from './pi-bridge-core'

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function harness(tools: BridgeTool[]): {
  active: string[][]
  commands: Map<string, (args: string, context: BridgeCommandContext) => Promise<void>>
  sessionStart: () => void
  spawnEnvironment: () => Record<string, string>
} {
  const active: string[][] = []
  const commands = new Map<string, (args: string, context: BridgeCommandContext) => Promise<void>>()
  let sessionStart: ((event: unknown, context: { cwd: string }) => void) | undefined
  let spawnHook:
    | ((input: { env?: Record<string, string> }) => { env: Record<string, string> })
    | undefined
  const pi: BridgeApi = {
    getAllTools: () => tools,
    setActiveTools: (names) => active.push(names),
    registerTool: () => {},
    on: (_event, handler) => {
      sessionStart = handler
    },
    registerCommand: (name, command) => {
      commands.set(name, command.handler)
    },
  }
  const createBashTool: BridgeBashToolFactory = (_cwd, options) => {
    spawnHook = options.spawnHook
    return { name: 'bash' }
  }
  installAutobuildBridge(pi, createBashTool)
  return {
    active,
    commands,
    sessionStart: () => sessionStart?.({}, { cwd: '/repo' }),
    spawnEnvironment: () => {
      if (spawnHook === undefined) throw new Error('bash tool was not installed')
      return spawnHook({ env: { HOME: '/home/operator', AB_PHASE: 'stale' } }).env
    },
  }
}

const context: BridgeCommandContext = {
  modelRegistry: { getAll: () => [], getAvailable: () => [] },
  ui: { notify: () => {} },
}

const tools: BridgeTool[] = [
  { name: 'read', sourceInfo: { source: 'builtin' } },
  { name: 'bash', sourceInfo: { source: 'builtin' } },
  {
    name: 'delegate',
    sourceInfo: { origin: 'package', source: 'npm:@Acme/SubAgents@2.0.0' },
  },
  {
    name: 'web_search',
    sourceInfo: { origin: 'package', source: 'npm:web-access@1.0.0' },
  },
  { name: 'untrusted_top_level', sourceInfo: { origin: 'top-level', source: '/tmp/tool.ts' } },
]

describe('Autobuild Pi bridge', () => {
  test('a hermetic role activates only its requested builtins', async () => {
    const bridge = harness(tools)
    bridge.sessionStart()
    await bridge.commands.get('autobuild-configure')!(
      encoded({ tools: ['read', 'bash'], extensions: [], environment: {} }),
      context,
    )
    expect(bridge.active.at(-1)).toEqual(['read', 'bash'])
  })

  test('a package allowlist is case-insensitive and activates no unrelated tools', async () => {
    const bridge = harness(tools)
    bridge.sessionStart()
    await bridge.commands.get('autobuild-configure')!(
      encoded({
        tools: ['read', 'bash'],
        extensions: ['subAGENTS'],
        environment: { AB_PHASE: 'implement@2', AB_SESSION: 's_2', PATH: '/managed:/bin' },
      }),
      context,
    )
    expect(bridge.active.at(-1)).toEqual(['read', 'bash', 'delegate'])
    expect(bridge.spawnEnvironment()).toEqual({
      HOME: '/home/operator',
      AB_PHASE: 'implement@2',
      AB_SESSION: 's_2',
      PATH: '/managed:/bin',
    })
  })
})

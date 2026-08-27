export interface BridgeToolSourceInfo {
  origin?: string
  source?: string
}

export interface BridgeTool {
  name: string
  sourceInfo?: BridgeToolSourceInfo
}

export interface BridgeApi {
  getAllTools(): BridgeTool[]
  setActiveTools(names: string[]): void
  registerTool(tool: unknown): void
  on(event: 'session_start', handler: (event: unknown, context: { cwd: string }) => void): void
  registerCommand(
    name: string,
    command: {
      description: string
      handler: (args: string, context: BridgeCommandContext) => Promise<void>
    },
  ): void
}

export interface BridgeCommandContext {
  modelRegistry: {
    getAll(): Array<{ provider: string; id: string }>
    getAvailable(): Array<{ provider: string; id: string }>
  }
  ui: { notify(message: string, type: 'info'): void }
}

export type BridgeBashToolFactory = (
  cwd: string,
  options: {
    spawnHook: (input: { env?: Record<string, string>; [key: string]: unknown }) => {
      env: Record<string, string>
      [key: string]: unknown
    }
  },
) => unknown

const BUILTIN_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
const CATALOG_PREFIX = 'autobuild-pi-catalog:'

export function selectActiveToolNames(
  tools: readonly BridgeTool[],
  baseTools: readonly string[],
  extensions: readonly string[],
): string[] {
  const allowedBase = new Set(baseTools)
  const allowedExtensions = extensions.map((value) => value.toLowerCase())
  return [
    ...new Set(
      tools
        .filter((tool) => {
          if (BUILTIN_TOOL_NAMES.has(tool.name)) return allowedBase.has(tool.name)
          if (tool.sourceInfo?.origin !== 'package') return false
          const source = (tool.sourceInfo.source ?? '').toLowerCase()
          return allowedExtensions.some((name) => source.includes(name))
        })
        .map((tool) => tool.name),
    ),
  ]
}

export function installAutobuildBridge(pi: BridgeApi, createBashTool: BridgeBashToolFactory): void {
  let environment: Record<string, string> = {}
  let extensions: string[] = []
  let baseTools: string[] = []

  const activateTools = (): void => {
    pi.setActiveTools(selectActiveToolNames(pi.getAllTools(), baseTools, extensions))
  }

  pi.on('session_start', (_event, context) => {
    pi.registerTool(
      createBashTool(context.cwd, {
        spawnHook: (input) => ({
          ...input,
          env: { ...input.env, ...environment },
        }),
      }),
    )
    activateTools()
  })

  pi.registerCommand('autobuild-configure', {
    description: 'Configure an Autobuild-managed headless session',
    handler: async (args) => {
      const payload = decode(args)
      if (!isRecord(payload)) throw new Error('invalid Autobuild bridge configuration')
      environment = stringRecord(payload.environment)
      extensions = stringArray(payload.extensions)
      baseTools = stringArray(payload.tools)
      activateTools()
    },
  })

  pi.registerCommand('autobuild-models', {
    description: 'Return the local Pi model catalog to Autobuild',
    handler: async (args, context) => {
      const payload = decode(args)
      if (!isRecord(payload) || typeof payload.nonce !== 'string' || payload.nonce.length < 8) {
        throw new Error('invalid Autobuild model-catalog nonce')
      }
      const models = payload.availableOnly
        ? context.modelRegistry.getAvailable()
        : context.modelRegistry.getAll()
      const entries = models.map((model) => ({ provider: model.provider, id: model.id }))
      context.ui.notify(`${CATALOG_PREFIX}${payload.nonce}:${encode(entries)}`, 'info')
    },
  })
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

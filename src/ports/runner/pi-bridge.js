import { createBashTool } from '@earendil-works/pi-coding-agent'

const BASE_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
const CATALOG_PREFIX = 'autobuild-pi-catalog:'

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export default function autobuildBridge(pi) {
  let environment = {}
  let extensions = []
  let baseTools = []
  let cwd

  function activateTools() {
    const allowedBase = new Set(baseTools)
    const allowed = extensions.map((value) => value.toLowerCase())
    const names = pi
      .getAllTools()
      .filter((tool) => {
        if (BASE_TOOLS.has(tool.name)) return allowedBase.has(tool.name)
        const info = tool.sourceInfo
        if (info?.origin !== 'package') return false
        const source = String(info.source ?? '').toLowerCase()
        return allowed.some((name) => source.includes(name))
      })
      .map((tool) => tool.name)
    pi.setActiveTools([...new Set(names)])
  }

  pi.on('session_start', (_event, ctx) => {
    cwd = ctx.cwd
    pi.registerTool(
      createBashTool(cwd, {
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
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('invalid Autobuild bridge configuration')
      }
      environment = payload.environment ?? {}
      extensions = Array.isArray(payload.extensions) ? payload.extensions : []
      baseTools = Array.isArray(payload.tools) ? payload.tools : []
      activateTools()
    },
  })

  pi.registerCommand('autobuild-models', {
    description: 'Return the local Pi model catalog to Autobuild',
    handler: async (args, ctx) => {
      const payload = decode(args)
      if (typeof payload.nonce !== 'string' || payload.nonce.length < 8) {
        throw new Error('invalid Autobuild model-catalog nonce')
      }
      const models = payload.availableOnly
        ? ctx.modelRegistry.getAvailable()
        : ctx.modelRegistry.getAll()
      const entries = models.map((model) => ({ provider: model.provider, id: model.id }))
      ctx.ui.notify(`${CATALOG_PREFIX}${payload.nonce}:${encode(entries)}`, 'info')
    },
  })
}

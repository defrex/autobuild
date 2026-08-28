import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLiveAgentRunnerContract } from './live-contract-fixture'
import { JsonlDecoder, PI_BRIDGE_PATH } from './pi-rpc'
import { checkLocalPi, PiAgentRunner } from './pi'

const enabled = process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1'
const PROBE_PREFIX = 'autobuild-pi-tool-probe:'
const PROBE_TOOL = 'autobuild_contract_probe_tool'

type JsonRecord = Record<string, unknown>

interface ProbeTool {
  name: string
  sourceInfo?: { origin?: string; source?: string }
}

interface ToolProbe {
  all: ProbeTool[]
  active: string[]
}

function requiredModel(): string {
  const value = process.env.AB_PI_CONTRACT_MODEL?.trim()
  if (!value) {
    throw new Error(
      'Pi live AgentRunner contract requires AB_PI_CONTRACT_MODEL when AB_RUN_LIVE_PORT_CONTRACTS=1',
    )
  }
  return value
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProbe(value: unknown): ToolProbe {
  if (!isRecord(value) || !Array.isArray(value.all) || !Array.isArray(value.active)) {
    throw new Error('Pi live installed-package gating probe returned a malformed payload')
  }
  const all = value.all.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      throw new Error('Pi live installed-package gating probe returned malformed tool metadata')
    }
    const rawSource = isRecord(entry.sourceInfo) ? entry.sourceInfo : undefined
    return {
      name: entry.name,
      ...(rawSource === undefined
        ? {}
        : {
            sourceInfo: {
              ...(typeof rawSource.origin === 'string' ? { origin: rawSource.origin } : {}),
              ...(typeof rawSource.source === 'string' ? { source: rawSource.source } : {}),
            },
          }),
    }
  })
  if (!value.active.every((entry) => typeof entry === 'string')) {
    throw new Error('Pi live installed-package gating probe returned malformed active tools')
  }
  return { all, active: value.active }
}

async function probeExplicitExtensionActivation(): Promise<ToolProbe> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  await checkLocalPi(process.cwd(), env)
  const root = await mkdtemp(join(tmpdir(), 'ab-pi-package-contract-'))
  const probePath = join(root, 'tool-probe.ts')
  const nonce = crypto.randomUUID()
  await writeFile(
    probePath,
    `import { Type } from 'typebox'

export default function toolProbe(pi) {
  pi.registerTool({
    name: ${JSON.stringify(PROBE_TOOL)},
    label: 'Autobuild contract probe',
    description: 'Test-only explicitly loaded tool',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'unexpected activation' }], details: {} }
    },
  })
  pi.registerCommand('autobuild-contract-probe', {
    description: 'Report registered and active tools for the Autobuild live contract',
    handler: async (args, context) => {
      const payload = {
        all: pi.getAllTools().map((tool) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
        active: pi.getActiveTools(),
      }
      context.ui.notify(
        ${JSON.stringify(PROBE_PREFIX)} + args + ':' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
        'info',
      )
    },
  })
}
`,
  )

  let stderr = ''
  let outputFailure: Error | undefined
  let exitCode: number | undefined
  const records: JsonRecord[] = []
  const listeners = new Set<() => void>()
  const wake = (): void => {
    for (const listener of listeners) listener()
  }
  const proc = Bun.spawn(
    [
      'pi',
      '--mode',
      'rpc',
      '--no-session',
      '--no-approve',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-extensions',
      '--extension',
      PI_BRIDGE_PATH,
      '--extension',
      probePath,
    ],
    {
      cwd: root,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const readOutput = async (): Promise<void> => {
    const decoder = new JsonlDecoder()
    try {
      for await (const chunk of proc.stdout) {
        for (const line of decoder.push(chunk)) {
          const parsed: unknown = JSON.parse(line)
          if (!isRecord(parsed)) throw new Error(`non-object JSONL record: ${line}`)
          records.push(parsed)
          wake()
        }
      }
      for (const line of decoder.end()) {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) throw new Error(`non-object JSONL record: ${line}`)
        records.push(parsed)
        wake()
      }
    } catch (error) {
      outputFailure = error instanceof Error ? error : new Error(String(error))
      wake()
    }
  }
  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true })
    stderr += decoder.decode()
  }
  void readOutput()
  void readStderr()
  void proc.exited.then((code) => {
    exitCode = code
    wake()
  })

  const diagnostic = (message: string): Error =>
    new Error(`${message}${stderr.trim().length > 0 ? `\nPi stderr:\n${stderr.trim()}` : ''}`)

  const waitFor = (
    description: string,
    predicate: (record: JsonRecord) => boolean,
  ): Promise<JsonRecord> =>
    new Promise((resolve, reject) => {
      const finish = (): void => {
        const match = records.find(predicate)
        if (match !== undefined) {
          cleanup()
          resolve(match)
          return
        }
        if (outputFailure !== undefined) {
          cleanup()
          reject(
            diagnostic(
              `Pi live installed-package gating probe emitted invalid JSONL: ${outputFailure.message}`,
            ),
          )
          return
        }
        if (exitCode !== undefined) {
          cleanup()
          reject(
            diagnostic(
              `Pi live installed-package gating probe exited with code ${exitCode} before ${description}`,
            ),
          )
        }
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        listeners.delete(finish)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          diagnostic(`Pi live installed-package gating probe timed out waiting for ${description}`),
        )
      }, 20_000)
      listeners.add(finish)
      finish()
    })

  let nextId = 0
  const command = async (type: string, fields: JsonRecord = {}): Promise<void> => {
    const id = `package-contract-${++nextId}`
    proc.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
    proc.stdin.flush()
    const response = await waitFor(
      `RPC response ${id}`,
      (record) => record.type === 'response' && record.id === id && record.command === type,
    )
    if (response.success !== true) {
      throw diagnostic(
        `Pi live installed-package gating RPC ${type} failed: ${typeof response.error === 'string' ? response.error : 'no diagnostic'}`,
      )
    }
  }

  try {
    await command('get_state')
    await command('prompt', {
      message: `/autobuild-configure ${encoded({
        tools: ['read'],
        environment: { AB_PHASE: 'live-extension-contract', AB_SESSION: nonce },
      })}`,
    })
    await command('prompt', { message: `/autobuild-contract-probe ${nonce}` })
    const notification = await waitFor(
      `nonce-tagged tool notification ${nonce}`,
      (record) =>
        record.type === 'extension_ui_request' &&
        record.method === 'notify' &&
        typeof record.message === 'string' &&
        record.message.startsWith(`${PROBE_PREFIX}${nonce}:`),
    )
    const message = notification.message as string
    const payload = message.slice(`${PROBE_PREFIX}${nonce}:`.length)
    return parseProbe(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } finally {
    proc.stdin.end()
    proc.kill()
    await Promise.race([proc.exited, Bun.sleep(1_000)])
    await rm(root, { recursive: true, force: true })
  }
}

describe.skipIf(!enabled)('Pi live AgentRunner contract (opt-in)', () => {
  test('activates explicitly loaded extension tools through the production bridge', async () => {
    const probe = await probeExplicitExtensionActivation()

    expect(probe.all.map((tool) => tool.name)).toContain(PROBE_TOOL)
    expect(probe.active).toContain('read')
    expect(probe.active).toContain(PROBE_TOOL)
  }, 60_000)

  test('runs start, continue, end, ambient/PATH probe, and one-shot against the local Pi CLI', async () => {
    await runLiveAgentRunnerContract(new PiAgentRunner(), requiredModel())
  }, 300_000)
})

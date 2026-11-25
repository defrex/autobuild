/**
 * MCP prompts for the agent context (#1225): one prompt per skill, whose
 * messages are exactly the `context.read` text of the skill's SKILL.md. The
 * hosted endpoints and `ab mcp` register them through this one helper, so
 * naming and lookup cannot drift between bindings.
 *
 * `prompts/get` never parses a repository out of a name: it recomputes the
 * listing for the repositories whose label matches the name's label and
 * matches the name exactly.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import {
  contextPromptMessages,
  contextPrompts,
  promptNameLabel,
  type ContextIndex,
  type ContextReadResult,
} from './agent-context-serve'

export interface ContextPromptSource {
  /** True on a binding that serves one repository (names omit the label). */
  scoped: boolean
  /** The indexes in scope. `label` narrows a deployment binding to the
   * repositories whose prompt label equals it. */
  indexes(label?: string): Promise<{ repo: string; index: ContextIndex }[]>
  read(repo: string, path: string): Promise<ContextReadResult>
}

export function registerContextPrompts(server: Server, source: ContextPromptSource): void {
  server.registerCapabilities({ prompts: {} })
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = contextPrompts(await source.indexes(), { scoped: source.scoped })
    return {
      prompts: prompts.map((prompt) => ({ name: prompt.name, description: prompt.description })),
    }
  })
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name
    const scope = await source
      .indexes(source.scoped ? undefined : promptNameLabel(name))
      .catch(() => [])
    const prompt = contextPrompts(scope, { scoped: source.scoped }).find(
      (candidate) => candidate.name === name,
    )
    if (prompt === undefined)
      throw new McpError(ErrorCode.InvalidParams, `unknown prompt "${name}"`)
    let result: ContextReadResult
    try {
      result = await source.read(prompt.repo, prompt.entry)
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `prompt "${name}" is unavailable right now`)
    }
    return { description: prompt.description, messages: contextPromptMessages(result) }
  })
}

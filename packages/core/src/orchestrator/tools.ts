/**
 * Registry entries as AI SDK tools (AUT-342): the turn runner binds the
 * in-process operator registry, so the agent's tools ARE the operator
 * surface — never a reimplementation.
 *
 * Two rules shape the binding:
 *
 * 1. **Attribution.** Every call carries the session operator as the human
 *    actor with `via: {kind: 'session', id}` — the operator's session did
 *    it, exactly as an MCP client's calls carry `via: {kind: 'mcp', …}`.
 *
 * 2. **The model never supplies `repo`.** Every registry entry requires a
 *    `repo` field and `call()` validates it before the handler runs, but
 *    nothing in the turn's durable state teaches the model a repository
 *    identity it could type: message-triggered turns carry no repo fact, the
 *    canonical skill must stay generic, and the registry has no
 *    repositories.list tool. The model-facing schema therefore strips `repo`
 *    (the mirror of the registry's own `extendUnion`), and `execute` injects
 *    the session's repository into the validated input before
 *    `registry.call` re-validates it — the session's repository is the only
 *    value a tool can ever target. The registry's `allowedRepo` guard stays
 *    bound as defense in depth.
 *
 * A thrown `RegistryError` is caught and returned as the operator-API
 * failure body (`kind`/`error`/`code`) so the model can react to a refusal
 * instead of the step dying; the registry's JSON-value invariant makes every
 * output wire-safe.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { RegistryError, type OperatorToolRegistry } from '../operator/registry'
import type { Via } from '../events/envelope'
import type { ApprovalDecision } from './approvals'

/** The model-facing stand-in for a stripped `repo` on schemas Zod 4 refuses
 * to `.omit()` — an object carrying refinements (`.refine` locks the shape).
 * `safeExtend` preserves the refinements while replacing the field with an
 * optional `never`: absent is fine, any supplied value fails validation, so
 * the model still cannot point a tool anywhere but the session's
 * repository. (Checked against the installed zod; `.omit` and `.extend`
 * both throw on refined objects.) */
const unsatisfiableRepo = z.optional(z.never())

/** Strip `repo` from a tool's model-facing schema: plain `ZodObject` entries
 * omit the field; union entries (the `extendUnion` shape) strip each option
 * and rebuild the union — Zod 4 unions expose no `withOptions`, so the
 * original union must never be handed through unchanged (its members still
 * require `repo`, which the model cannot know). Refined objects neutralize
 * the field instead of omitting it. Returns undefined only for a schema the
 * entry table never uses. */
function stripRepoField(schema: z.ZodType): z.ZodType | undefined {
  const options = (schema as unknown as { options?: readonly z.ZodType[] }).options
  if (Array.isArray(options) && options.length > 0) {
    const stripped = options.map((option) => stripRepoField(option) ?? option)
    return z.union(stripped)
  }
  const object = schema as unknown as {
    omit?: (mask: Record<string, boolean>) => unknown
    safeExtend?: (patch: Record<string, z.ZodType>) => unknown
  }
  if (typeof object.omit === 'function') {
    try {
      return object.omit({ repo: true }) as z.ZodType
    } catch {
      // A refined object: neutralize `repo` instead of omitting it.
      if (typeof object.safeExtend === 'function') {
        return object.safeExtend({ repo: unsatisfiableRepo }) as z.ZodType
      }
    }
  }
  return undefined
}

export interface RegistryToolsInput {
  registry: OperatorToolRegistry
  /** The session's repository — the only value any tool can target. */
  repo: string
  /** The session operator: the human actor every attributed write names. */
  operator: string
  /** The session-scoped delegate marker. */
  via: Via
  /** Optional per-tool approval configuration (from `approvals.ts`), keyed
   * by registry tool name; absent keys never suspend. (Kept for signature
   * symmetry; the agent takes the configuration directly.) */
  toolApproval?: Record<string, ApprovalDecision>
}

/** Build the AI SDK tool set from the registry's closed table. */
export function registryTools(input: RegistryToolsInput): ToolSet {
  const tools: ToolSet = {}
  for (const entry of input.registry.entries) {
    const modelSchema = stripRepoField(entry.inputSchema)
    if (modelSchema === undefined) continue
    tools[entry.name] = tool({
      description: `${entry.description}${entry.outputDescription ? `\n\nReturns: ${entry.outputDescription}` : ''}`,
      inputSchema: modelSchema,
      execute: async (modelInput: unknown) => {
        // Re-inject the session's repository: the registry re-validates the
        // whole input (with `repo`) before the handler runs.
        const fullInput =
          typeof modelInput === 'object' && modelInput !== null
            ? { ...(modelInput as Record<string, unknown>), repo: input.repo }
            : { repo: input.repo }
        try {
          return await input.registry.call(entry.name, fullInput, {
            identity: input.operator,
            via: input.via,
          })
        } catch (error) {
          if (error instanceof RegistryError) return error.body
          throw error
        }
      },
    })
  }
  return tools
}

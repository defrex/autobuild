/**
 * The checked-in risk table for the agent tool registry (operator/registry.ts).
 *
 * MCP annotations are per-tool hints, never per-argument, so a tool whose
 * action set *may* destroy work carries `destructiveHint: true` for the whole
 * tool, and each destructive action value is additionally named in the input
 * field's description so a model still sees the per-value risk. Today exactly
 * three tools may destroy work: `builds.control` (abort, discard),
 * `builds.answer` (revise-spec), and `tickets.move` (a move into the
 * configured ready state).
 *
 * The registry entries and the contract suite both read this table, so a
 * change to any tool's risk class is a one-line visible diff this suite
 * enforces. `approval` is the registry's own vocabulary (`'never'` for reads,
 * `'default'` for mutators): the registry carries the class, and each binding
 * decides what to do with it — the registry itself enforces only that a
 * mutator refuses to run without an attributed identity.
 */

export interface ToolAnnotationsTableEntry {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  approval: 'never' | 'default'
}

/** The exact version-one tool names; the registry's closed table must match. */
export const OPERATOR_TOOL_ANNOTATIONS = {
  'builds.list': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'builds.get': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'builds.events': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'builds.artifact': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'builds.control': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    approval: 'default',
  },
  'builds.answer': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    approval: 'default',
  },
  'repository.status': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'repository.settings': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'repository.bulk_control': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'harvest.status': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'harvest.control': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'tickets.list': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'tickets.get': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'tickets.create': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'tickets.update': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'tickets.block': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'tickets.unblock': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
  'tickets.move': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    approval: 'default',
  },
  'notes.read': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    approval: 'never',
  },
  'notes.write': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    approval: 'default',
  },
} as const satisfies Record<string, ToolAnnotationsTableEntry>

export type OperatorToolName = keyof typeof OPERATOR_TOOL_ANNOTATIONS

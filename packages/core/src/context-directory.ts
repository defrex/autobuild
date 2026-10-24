/** Session scratch names are direct children of .ab, shared across rounds. */
export function isSafeStepName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'
}

export function contextDirectory(phase: string, finalizeStep?: string): string {
  const base = phase.split('@')[0]!
  const step = finalizeStep ?? (base.startsWith('verify:') ? base.slice(7) : undefined)
  if (step !== undefined && !isSafeStepName(step)) {
    throw new Error(`Invalid context step name "${step}"`)
  }
  return `.ab/${finalizeStep !== undefined ? `finalize-${step}` : base.replace(':', '-')}`
}

export function resolveContextDirectory(phase: string, explicit?: string): string {
  const expected = contextDirectory(phase)
  if (explicit === undefined) return expected
  if (explicit === expected) return explicit
  if (
    phase.split('@')[0] === 'finalize' &&
    explicit.startsWith('.ab/finalize-') &&
    isSafeStepName(explicit.slice('.ab/finalize-'.length))
  )
    return explicit
  throw new Error(`AB_CONTEXT_DIR "${explicit}" must name the session directory ${expected}`)
}

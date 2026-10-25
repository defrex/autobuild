/** Evidence from an asserted TypeScript-oracle/native HTTP comparison. Paths
 * are relative to /operator/v1/repos/:repo; inventory entries alone are not
 * operation evidence. Validation/auth-only responses never cover an operation. */
export interface OperatorOperationWitness {
  suite: string
  id: string
  method: string
  path: string
  requestBody?: unknown
  status: number
  responseBody?: unknown
}
export interface OperatorCoverageEvidence {
  format: 1
  /** Hash of fixture-core.sources(), binding a run to the current TS oracle. */
  sourceClosureSha256: string
  /** Native and proof source/fixture bytes used by this completed run. */
  proofSourcesSha256: string
  /** Actual case IDs returned only after native assertions passed. */
  suites: Record<string, readonly string[]>
  /** Helper probes without a checked-in HTTP-result corpus emit the actual
   * request/result they compared to the TypeScript oracle at runtime. */
  operationWitnesses?: OperatorOperationWitness[]
}

/** Successful HTTP observations become evidence only when their enclosing
 * explicitly asserted proof returns. Failed proofs publish no route claims. */
import { assertProtocolCoverage, protocolCases } from './protocol-cases'
type Witness = { proof: string; method: string; path: string; status: number }
let pending: { name: string; rows: Witness[] } | undefined
const committed: Witness[] = []
function routeKey(method: string, pathname: string, status: number) {
  let parts: string[]
  try {
    parts = pathname.split('/').map((part) => decodeURIComponent(part))
  } catch {
    return undefined
  }
  const row = protocolCases.find(
    (row) =>
      row.method === method &&
      row.status.includes(status) &&
      (() => {
        const wanted = row.path.split('/')
        return (
          wanted.length === parts.length &&
          wanted.every((part, index) =>
            part.startsWith(':') ? Boolean(parts[index]) : part === parts[index],
          )
        )
      })(),
  )
  return row ? `${row.method} ${row.path}` : undefined
}
/** Harness-only hook: never observes TypeScript-oracle or unrelated HTTP traffic. */
export async function observeProtocolResponse(method: string, url: string, response: Response) {
  const context = pending
  if (!context) return
  const key = routeKey(method, new URL(url).pathname, response.status)
  if (!key) return
  if (!response.headers.get('content-type')?.startsWith('application/json'))
    throw new Error(`Protocol coverage requires JSON: ${key}`)
  await response.clone().json()
  // A response arriving after its proof completed cannot manufacture coverage.
  if (pending === context)
    context.rows.push({
      proof: context.name,
      method,
      path: key.slice(method.length + 1),
      status: response.status,
    })
}
export function beginProtocolCoverage() {
  if (pending) throw new Error('Protocol proof is already active')
  committed.length = 0
  return {
    async proof<T>(name: string, run: () => Promise<T>): Promise<T> {
      if (pending) throw new Error('Protocol coverage proofs must run sequentially')
      const context = { name, rows: [] as Witness[] }
      pending = context
      try {
        const result = await run()
        committed.push(...context.rows)
        return result
      } finally {
        pending = undefined
      }
    },
    report() {
      if (pending) throw new Error('Cannot claim coverage before assertions finish')
      const covered = new Set(committed.map((row) => `${row.method} ${row.path}`))
      const rows = protocolCases.map((row) => {
        const observations = committed.filter((w) => w.method === row.method && w.path === row.path)
        return {
          method: row.method,
          path: row.path,
          expectedStatuses: row.status,
          observations: observations.length,
          statuses: [...new Set(observations.map((w) => w.status))].sort(),
          assertedProofs: [...new Set(observations.map((w) => w.proof))].sort(),
        }
      })
      return { covered, rows, total: protocolCases.length, coveredCount: covered.size }
    },
    assertComplete() {
      const report = this.report()
      assertProtocolCoverage(report.covered)
      return { total: report.total, coveredCount: report.coveredCount, rows: report.rows }
    },
  }
}

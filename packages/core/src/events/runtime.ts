import { z } from 'zod'

export const runtimeIdentitySchema = z.strictObject({
  version: z.string().trim().min(1),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|unknown)$/),
  source: z.strictObject({
    kind: z.enum(['source', 'package']),
    location: z.string().trim().min(1),
  }),
})
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>
export function formatRuntimeIdentity(runtime: RuntimeIdentity | null): string {
  return runtime === null
    ? 'runtime unrecorded'
    : `autobuild ${runtime.version}; commit ${runtime.commit}; ${runtime.source.kind} ${runtime.source.location}`
}

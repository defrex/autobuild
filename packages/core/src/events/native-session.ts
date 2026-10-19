import { isAbsolute } from 'node:path'
import { z } from 'zod'

const nonblank = z.string().refine((value) => value.trim().length > 0, 'Expected a nonblank string')
const absolutePath = nonblank.refine(isAbsolute, 'Expected an absolute path')
export const nativeSessionHandleSchema = z.strictObject({
  version: z.literal(1),
  runner: nonblank,
  nativeId: nonblank,
  host: nonblank,
  workspacePath: absolutePath,
  statePath: absolutePath.optional(),
})

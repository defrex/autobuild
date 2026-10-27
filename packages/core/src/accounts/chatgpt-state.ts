import { sensitiveAccountValues } from './sensitive'
import { z } from 'zod'

const token = z
  .string()
  .min(1)
  .max(65536)
  .refine((s) => !s.includes('\0'))
export const chatgptStateSchema = z.strictObject({
  version: z.literal(1),
  hostId: z
    .string()
    .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  clientId: z
    .string()
    .min(1)
    .refine((s) => s !== 'dynamic_agent_client'),
  subject: z.string().min(1),
  scopes: z
    .array(z.string())
    .refine((s) => s.includes('chatgpt.tokens.use.direct') && s.includes('offline_access')),
  accessToken: token,
  refreshToken: token,
  idToken: token,
  expiresAt: z.number().finite(),
  earliestRefreshAt: z.number().finite().optional(),
})
export type ChatGPTState = z.infer<typeof chatgptStateSchema>
export function credentialValues(state: ChatGPTState): string[] {
  const values = [state.accessToken, state.refreshToken, state.idToken]
  values.forEach((v) => {
    sensitiveAccountValues.add(v)
  })
  return values
}
/** Provider uses absolute Unix seconds for numbers and absolute dates for strings. */
export function earliestRefreshAt(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

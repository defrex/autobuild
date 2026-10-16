import { z } from 'zod'
import { validateTicketAssetInput, type TicketAssetInput } from '../../store/ticket-assets'

export const portableAssetSchema = z
  .strictObject({
    kind: z.string(),
    name: z.string(),
    layout: z.enum(['file', 'tree']),
    entries: z.array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('dir'), path: z.string() }),
        z.strictObject({
          type: z.literal('file'),
          path: z.string(),
          base64: z
            .string()
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        }),
      ]),
    ),
  })
  .superRefine((value, ctx) => {
    try {
      validateTicketAssetInput(decodePortableAsset(value))
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: String(error) })
    }
  })
export type PortableAsset = z.infer<typeof portableAssetSchema>
export function decodePortableAsset(value: PortableAsset): TicketAssetInput {
  return {
    kind: value.kind,
    name: value.name,
    layout: value.layout,
    entries: value.entries.map((entry) =>
      entry.type === 'dir'
        ? entry
        : { type: 'file', path: entry.path, content: Buffer.from(entry.base64, 'base64') },
    ),
  }
}
export function encodePortableAsset(input: TicketAssetInput): PortableAsset {
  validateTicketAssetInput(input)
  return {
    kind: input.kind,
    name: input.name,
    layout: input.layout,
    entries: input.entries.map((entry) =>
      entry.type === 'dir'
        ? entry
        : { type: 'file', path: entry.path, base64: Buffer.from(entry.content).toString('base64') },
    ),
  }
}

/** The read catalog identity, kept free of payload schemas so stores can name
 * it without initializing the decoders. `./compatibility` re-exports it. */
import { buildEventPolicy, repositoryEventPolicy } from './policy'

/** Change this revision whenever projection semantics change without new types. */
// Revision 3 retains optional billing-account descriptors in session/attempt projections.
// Revision 4 retains the optional effective prompt in session projections.
// Revision 5 retains the optional preparation creation key.
// Revision 6 retains the optional role profile on build creation and session starts.
// Revision 7 retains the optional abort destination and hand-back report fields.
// Revision 8 retains the optional landed head on accepted attempt settlements.
// Revision 9 retains the optional stream and provider substitution on judge session starts.
// Revision 10 retains the optional hold reason.
// Revision 11 retains optional forge rate-limit snapshots on tick telemetry
// and the optional continued marker on forge degradation.
// Revision 12 retains the optional build priority and urgent scan demand.
export const READ_DECODER_REVISION = 12
export function catalogIdentity(
  build: Record<string, string> = buildEventPolicy,
  repository: Record<string, string> = repositoryEventPolicy,
): string {
  const sorted = (catalog: Record<string, string>) =>
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([READ_DECODER_REVISION, sorted(build), sorted(repository)]))
    .digest('hex')
}
export const READ_CATALOG_IDENTITY = catalogIdentity()

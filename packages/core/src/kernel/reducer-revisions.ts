/**
 * The append-only reducer revision ledger. A reducer's version is derived from
 * its frozen legacy base, the number of lines here naming its identity, and the
 * versions of its declared parts (`reducer-identity.ts`), so two branches that
 * each revise the same reducer merge by union (`.gitattributes`) and the
 * combined code counts both revisions.
 *
 * Append a line only with `bun tools/reducer-revision.ts <shape|fold> <identity>
 * --reason "…"`. Never edit, reorder or delete a line, and never resolve this
 * file by choosing a side: a deleted line lowers a version, and saved values
 * under the higher version would then be reduced again on every read. A revert
 * adds a revision rather than removing one.
 */
export const REDUCER_REVISIONS: Readonly<Record<string, string>> = {
  __ledger__: 'not a revision; append revisions below',
  'leafRestack/shape/ga4knf62mj': 'AUT-1266 generated replay resolution state',
  'nodeRestack/shape/8su0tli8be': 'AUT-1266 generated replay resolution state',
  'executionNoProgress/fold/v2he1qwp0t': 'AUT-1266 regeneration events count as progress',
  'buildReadFacts/shape/2kbhcftrqb': 'Carry the verify diff base as a bounded part',
  'build/shape/691nlqt5o8': 'Hold reason on the landing command',
  'buildReadFacts/shape/fjcms3g67h': 'Hold reason on the landing command',
  'buildStreamSeed/shape/cnyes1nf0o': 'Hold reason on the landing command',
  'build/shape/0sj01uqgcz': 'Forge CI failure record on finished leaves',
  'buildReadFacts/shape/42qtslvxvq': 'Forge CI failure record on finished leaves',
  'buildStreamSeed/shape/9970dr98ff': 'Forge CI failure record on finished leaves',
}

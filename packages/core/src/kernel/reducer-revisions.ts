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
  'build/shape/3vstye5scq': 'Reopen of a settled leaf (build.reopened)',
  'logIndex/shape/5so3ulzgzo': 'Reopen of a settled leaf (build.reopened)',
  'buildReadFacts/shape/q1u260vc6f': 'Reopen of a settled leaf (build.reopened)',
  'buildStreamSeed/shape/vc3s07eqg4': 'Reopen of a settled leaf (build.reopened)',
  'build/fold/un4t96vlnx': 'Reopen of a settled leaf (build.reopened)',
  'logIndex/fold/oj2ejk6qgb': 'Reopen of a settled leaf (build.reopened)',
  'executionNoProgress/fold/e37vc1wkgl': 'Reopen of a settled leaf (build.reopened)',
  'terminalGuard/fold/stc1et9vcy': 'A reopen re-runs verify and finalize terminals',
  'build/shape/p4ohsa1w9f': 'AUT-1290 build priority and urgent scan demand',
  'buildReadFacts/shape/jjcct3w7sh': 'AUT-1290 build priority and urgent scan demand',
  'buildStreamSeed/shape/x80591dawj': 'AUT-1290 build priority and urgent scan demand',
  'repositoryReadFacts/shape/hgw4spz5c0': 'AUT-1290 build priority and urgent scan demand',
  'repositoryReadFacts/shape/xyn7875cxw': 'AUT-1293 carry pending ticket start requests',
}

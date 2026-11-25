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
 * adds a revision rather than removing one. Verify enforces this: the registry
 * integration test fails any change that drops a line present at its verify
 * base or lowers any reducer's version below the base's, and the remedy is to
 * restore the lines and record the undo with the revision tool. A deregistered
 * identity keeps its lines; they stay inert.
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
  'repositoryReadFacts/shape/se5kk44boc': 'AUT-1288 open-PR backpressure engagement',
  'build/shape/0sj01uqgcz': 'Forge CI failure record on finished leaves',
  'buildReadFacts/shape/42qtslvxvq': 'Forge CI failure record on finished leaves',
  'buildStreamSeed/shape/9970dr98ff': 'Forge CI failure record on finished leaves',
  'repositoryReadFacts/shape/xyn7875cxw': 'AUT-1293 carry pending ticket start requests',
  'ticketStarts/shape/eecofz22vy': 'AUT-1293 start request priority',
  'repositoryReadFacts/shape/7hbgb52kw8': 'AUT-1293 start request priority',
  'ticketStarts/fold/eglrhnb0ta': 'AUT-1293 re-request updates pending start priority',
  'repositoryReadFacts/fold/fk3ka9gb3z': 'AUT-1293 re-request updates pending start priority',
  'buildReadFacts/shape/grk476irlr': 'history.retained fold for best-effort leaf history retention',
  'buildReadFacts/fold/iub07xo6kf': '#1051 commits-retained and node.history-retained folds',
  'optimization/shape/wy6151hb4q': '#1069 active-hours clock and execution fact counts',
  'build/shape/d3jt2tcoj6': '#1069 active-hours clock and execution fact counts',
  'buildDigest/shape/7dw02b53nl': '#1069 active-hours clock and execution fact counts',
  'optimization/fold/px86golc8e': '#1069 active-hours clock and execution fact counts',
  'build/fold/qt6bkt4ezw': '#1069 active-hours clock and execution fact counts',
  'buildDigest/fold/2lfn4ripe4': '#1069 active-hours clock and execution fact counts',
  'optimization/fold/n2q2dksb1t': '#1069 settlement chunks and the dispatcher-started clock',
  'build/fold/xfau4h85gn': '#1069 settlement chunks and the dispatcher-started clock',
  'buildDigest/fold/r14f4ydbcd': '#1069 settlement chunks and the dispatcher-started clock',
  'optimization/shape/dlths9d2kt': '#1069 clock compacts below open runs and last batch',
  'build/shape/qggqu27a51': '#1069 clock compacts below open runs and last batch',
  'buildDigest/shape/qr2vs0xtvj': '#1069 clock compacts below open runs and last batch',
  'optimization/fold/mpmd7m1p0r': '#1069 clock compacts below open runs and last batch',
  'build/fold/sgmw4zxzmb': '#1069 clock compacts below open runs and last batch',
  'buildDigest/fold/8fy0afqcn5': '#1069 clock compacts below open runs and last batch',
  'sandboxStates/shape/gbrf8k4qxq': '#1223 sandbox provisioning/failed states',
  'repositoryReadFacts/shape/o7791nz2gt': '#1223 sandbox provisioning/failed states',
  'sandboxStates/fold/hjdgop7xoh': '#1223 fold sandbox lifecycle facts',
  'build/shape/o79t0vefkb': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'leafRestack/shape/4ju65uzvg9': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'logIndex/shape/n7i96wfovf': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'build/fold/1do6v52s3p': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'leafRestack/fold/5zq9n2zlit': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'logIndex/fold/bwl7r7gjae': '#1274 rewritten-target reprovision, accept waiver, episodes',
  'verifyDiffBase/fold/p2si2x55v7': '#1274 rewritten-target reprovision, accept waiver, episodes',
}

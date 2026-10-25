import { parseConfig } from '../packages/core/src/config/load'
import { validateEventWrite, type AbEvent } from '../packages/core/src/events/catalog'
import { KERNEL, DISPATCHER } from '../packages/core/src/events/envelope'
import { reduceBuild } from '../packages/core/src/kernel/reducer'
import { projectBuild, type DashboardModel } from '../packages/core/src/cli/dashboard/model'
const at = '2026-07-15T12:09:00.000Z'
const config = parseConfig(
  `[tickets]\nsource="file"\nreadyState="ready"\n[commands]\ntest="true"\n[verify]\nsteps=[["unit","integration"]]\n[verify.unit]\nkind="check"\ncommand="test"\nfailFast=true\n[verify.integration]\nkind="check"\ncommand="test"`,
)
/** Event-derived rows shared by terminal and web evidence, using their real projection. */
export function verifyStagesCapture(model: DashboardModel): DashboardModel {
  const rows = ['concurrent-verification', 'cancelled-verification'].map((slug, index) => {
    const writes = [
      validateEventWrite({
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo: 'capture',
          baseBranch: 'main',
          ticket: { source: 'file', id: `STAGE-${index + 1}` },
        },
      }),
      validateEventWrite({
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: 'git-worktree',
          ref: '/capture',
          branch: `ab/${slug}`,
          base: { source: 'remote', sha: 'a'.repeat(40) },
        },
      }),
      validateEventWrite({
        actor: DISPATCHER,
        type: 'spec.imported',
        payload: {
          artifact: { kind: 'spec', rev: 0 },
          ticket: { source: 'file', id: `STAGE-${index + 1}` },
        },
      }),
      validateEventWrite({
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'capture', host: 'capture' },
      }),
      validateEventWrite({
        actor: KERNEL,
        type: 'verify.started',
        payload: { step: 'unit', attempt: 1 },
      }),
      validateEventWrite({
        actor: KERNEL,
        type: 'verify.started',
        payload: { step: 'integration', attempt: 1 },
      }),
    ]
    if (index)
      writes.push(
        validateEventWrite({
          actor: KERNEL,
          type: 'verify.completed',
          payload: { step: 'unit', attempt: 1, outcome: 'fail' },
        }),
        validateEventWrite({
          actor: KERNEL,
          type: 'verify.cancelled',
          payload: { step: 'integration', attempt: 1, cause: { step: 'unit' } },
        }),
      )
    const events = writes.map((write, i) => ({
      ...write,
      build: slug,
      seq: i + 1,
      ts: at,
    })) as AbEvent[]
    return projectBuild(
      { slug, repo: 'capture', createdAt: at, updatedAt: at },
      reduceBuild(events),
      config,
      events,
    )!
  })
  return { ...model, builds: [...rows, ...model.builds] }
}

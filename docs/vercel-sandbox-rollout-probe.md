# Vercel Sandbox rollout probe

This PR records the rollout probe for hosted ticket [AUT-295](https://linear.app/defrex/issue/AUT-295) and build `vercel-recovery-probe-2`, published from branch `ab/vercel-recovery-probe-2`.

The build's durable Store event stream and attached artifacts are the substantive evidence. Together they record Vercel Sandbox execution with noninteractive Pi served through Vercel AI Gateway; controlled replacement of the original environment with same-build resumption; configured checks and manual terminal/web visual verdicts; finalization and publication to this PR; and exact resource cleanup. Store execution, workspace, session, verification, publication, finalize, PR, and cleanup events carry the operational identities and outcomes without duplicating them here.

The passing visual reports are attached as `rollout-probe:terminal-report` and `rollout-probe:web-report`. Every inspected image is attached under its stable `dashboard-frame:<frame>:png` or `web-dashboard-frame:<frame>:png` kind.

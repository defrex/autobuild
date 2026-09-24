/**
 * The builtin `vercel-sandbox` provider's remote readiness validation
 * (AUT-516): the body of `validateInitReadiness`'s remote branch, moved here
 * so the capability declaration can point at it without
 * `cli/init-validation.ts` naming the provider. Store precondition checks
 * stay with the caller, driven by the `storeRequirements` declaration.
 */
import type { VercelSandboxConfig } from '../config/schema'
import type {
  InitValidationReport,
  WorkspaceReadinessContext,
} from '../ports/workspace/provider-capabilities'
import { validateVercelSandbox, type VercelSandboxFacade } from '../ports/workspace/vercel-sandbox'
import { gitText, parseGuestOutput } from './init-readiness-shared'

export async function validateRemoteReadiness(
  ctx: WorkspaceReadinessContext,
): Promise<InitValidationReport> {
  const vercel = ctx.providerConfig as VercelSandboxConfig
  const remoteLine = await gitText(
    ctx.exec,
    ctx.repo,
    ['ls-remote', '--heads', 'origin', `refs/heads/${ctx.baseBranch}`],
    ctx.signal,
  )
  const remoteRevision = remoteLine.split(/\s+/)[0]
  if (!/^[0-9a-f]{40,64}$/i.test(remoteRevision ?? '')) {
    throw new Error(
      `remote base ${ctx.baseBranch} does not exist; commit and push setup changes before validating`,
    )
  }
  await gitText(
    ctx.exec,
    ctx.repo,
    [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      'origin',
      `refs/heads/${ctx.baseBranch}`,
    ],
    ctx.signal,
  )
  const shownConfig = await ctx.exec(['git', 'show', `${remoteRevision}:autobuild.toml`], {
    cwd: ctx.repo,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })
  if (shownConfig.exitCode !== 0) {
    throw new Error(
      `remote ${ctx.baseBranch} does not contain autobuild.toml; commit and push setup changes before validating`,
    )
  }
  if (shownConfig.stdout !== ctx.configBytes) {
    throw new Error(
      `remote ${ctx.baseBranch} autobuild.toml differs from this checkout; commit and push setup changes before validating`,
    )
  }
  let remote: Awaited<ReturnType<typeof validateVercelSandbox>>
  try {
    remote = await validateVercelSandbox({
      config: vercel,
      env: ctx.env,
      storeRef: ctx.storeRef,
      storeToken: ctx.storeToken,
      repo: ctx.repo,
      baseBranch: ctx.baseBranch,
      ...(ctx.facade !== undefined ? { facade: ctx.facade as VercelSandboxFacade } : {}),
      exec: ctx.exec,
      ...(ctx.packageArchive !== undefined ? { packageArchive: ctx.packageArchive } : {}),
      runtimeReferences: [...ctx.runtimeReferences],
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      onSandbox: (name) => ctx.stdout(`Disposable Vercel Sandbox: ${name} (active)`),
    })
  } catch (error) {
    throw new Error(ctx.redact(error))
  }
  let guest: Awaited<ReturnType<typeof parseGuestOutput>>
  try {
    guest = parseGuestOutput(remote.output)
  } catch (error) {
    throw new Error(
      `disposable sandbox ${remote.sandbox} was deleted, but its readiness output was invalid: ${ctx.redact(error)}`,
    )
  }
  return {
    provider: 'vercel-sandbox',
    context: 'Vercel Sandbox',
    workspace: remote.sandbox,
    revision: remote.revision,
    snapshotsDeleted: remote.snapshotsDeleted,
    checks: [
      {
        name: 'repository acquisition',
        status: 'pass',
        detail: `${remote.origin} ${remote.revision}`,
      },
      {
        name: 'system provisioning',
        status: 'pass',
        detail:
          remote.provisioning.length === 0
            ? 'no workspace.config.provisioning steps declared'
            : `completed: ${remote.provisioning.join(', ')}`,
      },
      ...guest.checks,
    ],
    exitCode: guest.checks.some((check) => check.status === 'fail') ? 1 : 0,
  }
}

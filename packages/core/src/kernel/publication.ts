import type { Forge } from '../ports/types'

/** Ordinary local publication leaves no durable request on failure. */
export async function publishExact(
  forge: Forge,
  workspacePath: string,
  branch: string,
  sha: string,
): Promise<void> {
  if (!forge.confirmPublication)
    throw new Error(
      `forge ${forge.name} lacks authoritative publication inspection; upgrade the adapter`,
    )
  const confirm = () => forge.confirmPublication!(workspacePath, branch, sha)
  if (await confirm()) return
  try {
    await forge.pushBranch(workspacePath, branch, sha)
  } catch (error) {
    if (!(await confirm())) throw error
  }
  if (!(await confirm())) throw new Error(`publication readback did not confirm ${sha}`)
}

import { readFile, writeFile } from 'node:fs/promises'
import { captureDashboardFrames, type DashboardCaptureResult } from './dashboard-capture'
import {
  type FrameAssetEnvironment,
  type FrameAssetOutput,
  type FrameAssetSpec,
  processOutput,
  runFrameAsset,
} from './frame-asset'
import { repoRoot } from './git-tracked'

type HeadlineFrame = Pick<DashboardCaptureResult['frames'][number], 'id' | 'png' | 'pngPath'>

/** The README headline image: the exact PNG bytes of the happy wide frame. */
export const README_HEADLINE: FrameAssetSpec<HeadlineFrame> = {
  label: 'README headline',
  sourceFrameId: 'headline-happy-wide',
  assetPath: 'docs/assets/headline-wide.png',
  regenerateCommand: 'bun run capture:readme-headline',
  bytes: (frame) => frame.png,
  source: (frame) => frame.pngPath,
}

export type ReadmeHeadlineEnvironment = FrameAssetEnvironment<HeadlineFrame>
export type ReadmeHeadlineOutput = FrameAssetOutput

export function runReadmeHeadline(
  args: readonly string[],
  env: ReadmeHeadlineEnvironment = realEnvironment,
  output: ReadmeHeadlineOutput = processOutput,
): Promise<number> {
  return runFrameAsset(README_HEADLINE, args, env, output)
}

export const realEnvironment: ReadmeHeadlineEnvironment = {
  repoRoot,
  captureFrames: captureDashboardFrames,
  readFile,
  writeFile,
}

if (import.meta.main) {
  process.exitCode = await runReadmeHeadline(process.argv.slice(2))
}

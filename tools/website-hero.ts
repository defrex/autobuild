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

type HeroFrame = Pick<DashboardCaptureResult['frames'][number], 'id' | 'lines' | 'textPath'>

/** The exact ANSI lines `ab dispatch` painted for the frame, one per row, with
 * a final newline. The website parses this file; it never paints its own. */
export function heroFrameBytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

/** The website hero: the dashboard's own colored output for the happy scenario. */
export const WEBSITE_HERO: FrameAssetSpec<HeroFrame> = {
  label: 'website hero frame',
  sourceFrameId: 'website-hero',
  assetPath: 'packages/website/src/hero-frame.txt',
  regenerateCommand: 'bun run capture:website-hero',
  bytes: (frame) => heroFrameBytes(frame.lines),
  source: (frame) => frame.textPath,
}

export type WebsiteHeroEnvironment = FrameAssetEnvironment<HeroFrame>

export function runWebsiteHero(
  args: readonly string[],
  env: WebsiteHeroEnvironment = realEnvironment,
  output: FrameAssetOutput = processOutput,
): Promise<number> {
  return runFrameAsset(WEBSITE_HERO, args, env, output)
}

export const realEnvironment: WebsiteHeroEnvironment = {
  repoRoot,
  captureFrames: captureDashboardFrames,
  readFile,
  writeFile,
}

if (import.meta.main) {
  process.exitCode = await runWebsiteHero(process.argv.slice(2))
}

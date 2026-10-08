import { join } from 'node:path'
import type { DashboardCaptureOptions } from './dashboard-capture'

/**
 * A tracked repository asset derived from one scripted dashboard frame.
 *
 * The README headline image and the website's hero frame are both generated
 * evidence: each is the exact output of a named frame in
 * `tools/dashboard-capture.ts`, committed so the repository renders without
 * running the capture. This module owns the two modes every such asset
 * needs — regenerate the tracked file from the live capture, or check it byte
 * for byte and fail with the regeneration command — so a new asset only has
 * to say which frame it comes from and which bytes of it to keep.
 */

export interface FrameAssetSpec<Frame extends { id: string }> {
  /** How messages name the asset, e.g. "README headline". */
  label: string
  /** The unique frame id in the capture that produces the asset. */
  sourceFrameId: string
  /** Repository-relative path of the tracked file. */
  assetPath: string
  /** The command that rewrites the tracked file. */
  regenerateCommand: string
  /** The exact bytes the tracked file must hold for the selected frame. */
  bytes(frame: Frame): Uint8Array
  /** Where the capture left this frame's own evidence, for the success message. */
  source(frame: Frame): string
}

export interface FrameAssetEnvironment<Frame extends { id: string }> {
  repoRoot: string
  captureFrames(options: DashboardCaptureOptions): Promise<{ frames: readonly Frame[] }>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, contents: Uint8Array): Promise<void>
}

export interface FrameAssetOutput {
  stdout(message: string): void
  stderr(message: string): void
}

export const processOutput: FrameAssetOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function selectSourceFrame<Frame extends { id: string }>(
  spec: FrameAssetSpec<Frame>,
  frames: readonly Frame[],
): Frame {
  const matches = frames.filter((frame) => frame.id === spec.sourceFrameId)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dashboard frame named "${spec.sourceFrameId}", found ${matches.length}`,
    )
  }
  return matches[0]!
}

function parseMode(spec: FrameAssetSpec<never>, args: readonly string[]): 'regenerate' | 'check' {
  if (args.length === 0) return 'regenerate'
  if (args.length === 1 && args[0] === '--check') return 'check'
  throw new Error(
    `unsupported arguments: ${args.join(' ') || '(none)'}; usage: ${spec.regenerateCommand} [--check]`,
  )
}

/** Regenerate (no arguments) or check (`--check`) the asset; returns the exit code. */
export async function runFrameAsset<Frame extends { id: string }>(
  spec: FrameAssetSpec<Frame>,
  args: readonly string[],
  env: FrameAssetEnvironment<Frame>,
  output: FrameAssetOutput = processOutput,
): Promise<number> {
  let mode: 'regenerate' | 'check'
  try {
    mode = parseMode(spec, args)
  } catch (error) {
    output.stderr(`Could not produce ${spec.label}: ${describeError(error)}\n`)
    return 1
  }

  try {
    const result = await env.captureFrames({ workspacePath: env.repoRoot })
    const source = selectSourceFrame(spec, result.frames)
    const generated = spec.bytes(source)
    const destination = join(env.repoRoot, spec.assetPath)

    if (mode === 'regenerate') {
      await env.writeFile(destination, generated)
      output.stdout(
        `Wrote ${spec.assetPath} from dashboard frame "${spec.sourceFrameId}" (${spec.source(source)}).\n`,
      )
      return 0
    }

    let tracked: Uint8Array
    try {
      tracked = await env.readFile(destination)
    } catch (error) {
      if (isMissingFile(error)) {
        output.stderr(
          `${spec.label} is missing at ${spec.assetPath}. Regenerate it with: ${spec.regenerateCommand}\n`,
        )
        return 1
      }
      throw new Error(`could not read ${spec.assetPath}: ${describeError(error)}`)
    }

    if (!sameBytes(tracked, generated)) {
      output.stderr(
        `${spec.label} is stale: ${spec.assetPath} does not match dashboard frame "${spec.sourceFrameId}". Regenerate it with: ${spec.regenerateCommand}\n`,
      )
      return 1
    }

    output.stdout(
      `${spec.assetPath} matches dashboard frame "${spec.sourceFrameId}" byte for byte.\n`,
    )
    return 0
  } catch (error) {
    output.stderr(`Could not produce ${spec.label}: ${describeError(error)}\n`)
    return 1
  }
}

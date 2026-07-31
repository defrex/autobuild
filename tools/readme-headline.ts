import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  captureDashboardFrames,
  type DashboardCaptureOptions,
  type DashboardCaptureResult,
} from './dashboard-capture'
import { repoRoot } from './git-tracked'

const SOURCE_FRAME_ID = 'mixed-wide'
const HEADLINE_PATH = 'docs/assets/headline-wide.png'
const REGENERATE_COMMAND = 'bun run capture:readme-headline'

interface HeadlineCaptureResult {
  frames: readonly Pick<DashboardCaptureResult['frames'][number], 'id' | 'png' | 'pngPath'>[]
}

export interface ReadmeHeadlineEnvironment {
  repoRoot: string
  captureFrames(options: DashboardCaptureOptions): Promise<HeadlineCaptureResult>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, contents: Uint8Array): Promise<void>
}

export interface ReadmeHeadlineOutput {
  stdout(message: string): void
  stderr(message: string): void
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

function selectSourceFrame(result: HeadlineCaptureResult): HeadlineCaptureResult['frames'][number] {
  const matches = result.frames.filter((frame) => frame.id === SOURCE_FRAME_ID)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dashboard frame named "${SOURCE_FRAME_ID}", found ${matches.length}`,
    )
  }
  return matches[0]!
}

function parseMode(args: readonly string[]): 'regenerate' | 'check' {
  if (args.length === 0) return 'regenerate'
  if (args.length === 1 && args[0] === '--check') return 'check'
  throw new Error(
    `unsupported arguments: ${args.join(' ') || '(none)'}; usage: ${REGENERATE_COMMAND} [--check]`,
  )
}

export async function runReadmeHeadline(
  args: readonly string[],
  env: ReadmeHeadlineEnvironment = realEnvironment,
  output: ReadmeHeadlineOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let mode: 'regenerate' | 'check'
  try {
    mode = parseMode(args)
  } catch (error) {
    output.stderr(`Could not produce README headline: ${describeError(error)}\n`)
    return 1
  }

  try {
    const result = await env.captureFrames({ workspacePath: env.repoRoot })
    const source = selectSourceFrame(result)
    const destination = join(env.repoRoot, HEADLINE_PATH)

    if (mode === 'regenerate') {
      await env.writeFile(destination, source.png)
      output.stdout(
        `Wrote ${HEADLINE_PATH} from dashboard frame "${SOURCE_FRAME_ID}" (${source.pngPath}).\n`,
      )
      return 0
    }

    let tracked: Uint8Array
    try {
      tracked = await env.readFile(destination)
    } catch (error) {
      if (isMissingFile(error)) {
        output.stderr(
          `README headline is missing at ${HEADLINE_PATH}. Regenerate it with: ${REGENERATE_COMMAND}\n`,
        )
        return 1
      }
      throw new Error(`could not read ${HEADLINE_PATH}: ${describeError(error)}`)
    }

    if (!sameBytes(tracked, source.png)) {
      output.stderr(
        `README headline is stale: ${HEADLINE_PATH} does not match dashboard frame "${SOURCE_FRAME_ID}". Regenerate it with: ${REGENERATE_COMMAND}\n`,
      )
      return 1
    }

    output.stdout(`${HEADLINE_PATH} matches dashboard frame "${SOURCE_FRAME_ID}" byte for byte.\n`)
    return 0
  } catch (error) {
    output.stderr(`Could not produce README headline: ${describeError(error)}\n`)
    return 1
  }
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

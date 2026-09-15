/**
 * Shared production streaming boundary for the local CLI runners (SPEC §9):
 * spawn the harness executable, decode stdout into lines as they arrive, and
 * still deliver the completed result to the ordinary accumulators.
 *
 * A ReadableStream admits exactly one reader, so the raw stdout is tee()d:
 * one branch feeds the live line decoder, the other is drained to a string
 * for the result. Handing `proc.stdout` to a second direct reader would lock
 * the stream and throw "ReadableStream is locked" mid-turn, silently failing
 * every live translation. The tee keeps the result complete even when the
 * line consumer stops early (abort, translation error) — the surviving
 * branch continues to drain the process output.
 */

export interface CliStreamInvocation {
  /** Arguments after the executable. */
  args: string[]
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export interface CliStreamResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** A streaming CLI turn: decoded stdout lines as they arrive, plus the
 * completed result. The consumer accumulates the lines it needs. */
export interface CliStreamHandle {
  lines: AsyncIterable<string>
  result: Promise<CliStreamResult>
}

/** Incremental line decoder shared by the streaming CLI paths. */
export class LineDecoder {
  private buffer = ''
  private readonly text = new TextDecoder()

  async *lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    for await (const chunk of stream) {
      this.buffer += this.text.decode(chunk, { stream: true })
      yield* this.drain()
    }
    this.buffer += this.text.decode()
    yield* this.drain()
    if (this.buffer.length > 0) yield this.buffer
  }

  private *drain(): Generator<string> {
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) yield line
    }
  }
}

/** Spawn `executable` for a streaming turn. Direct argv (never a shell),
 * piped stdout/stderr, stdin ignored: the positional prompt is the turn's
 * only input. */
export function spawnCliStream(
  executable: string,
  invocation: CliStreamInvocation,
): CliStreamHandle {
  const proc = Bun.spawn([executable, ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
  })
  const [forLines, forText] = proc.stdout.tee()
  return {
    lines: new LineDecoder().lines(forLines),
    result: (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(forText).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    })(),
  }
}

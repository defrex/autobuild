import { readFileSync } from 'node:fs'

/** Observe presentation liveness, never kernel work. Raw-mode Ctrl-Z stops only
 * the generation; the shell also needs its direct child stopped to regain the
 * terminal. SIGCONT from `fg` resumes that presentation, leaving the kernel alone. */
export function watchPresentationJob(pid: number): { close(): void } {
  let closed = false
  let checking = false
  const continued = () => {
    try {
      process.kill(pid, 'SIGCONT')
    } catch {}
  }
  process.on('SIGCONT', continued)
  const timer = setInterval(async () => {
    if (closed || checking) return
    checking = true
    try {
      let state: string
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        state = stat.slice(stat.lastIndexOf(')') + 2)
      } else {
        const child = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)], {
          stdout: 'pipe',
          stderr: 'ignore',
        })
        state = await new Response(child.stdout).text()
        await child.exited
      }
      if (!closed && state.trimStart().startsWith('T')) process.kill(process.pid, 'SIGSTOP')
    } catch {
      // An exited or inaccessible child does not establish a stopped job.
    } finally {
      checking = false
    }
  }, 100)
  timer.unref()
  return {
    close() {
      closed = true
      clearInterval(timer)
      process.removeListener('SIGCONT', continued)
    },
  }
}

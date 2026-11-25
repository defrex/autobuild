import {
  FOCUS_REPORTING_MODE,
  KITTY_KEYBOARD_MODE,
  BRACKETED_PASTE_MODE,
  ALTERNATE_SCREEN_MODE,
  HIDDEN_CURSOR_MODE,
  DRAINED_QUIT_EXIT,
} from './terminal-restore'
import { GENERATION_SIGNALS } from './dispatch-launch-contract'

/**
 * On a terminal the operator's stop reaches the generation both from its
 * process group and from the launcher's forwarding. A generation that died of
 * the same signal the launcher received performed the requested stop.
 */
export function operatorStopped(
  launcherSignal: NodeJS.Signals | undefined,
  childSignal: string | number | null,
): boolean {
  return launcherSignal !== undefined && childSignal === launcherSignal
}

/**
 * Last-resort restore after the presentation owner failed. `--plain`
 * generations never enable a terminal mode, so the launcher never restores one.
 */
export function restoreLauncherTerminal(
  plain: boolean,
  stdin: { isTTY?: boolean; setRawMode?(raw: boolean): unknown },
  stdout: { isTTY?: boolean; write(chunk: string): unknown },
): void {
  if (stdin.isTTY) stdin.setRawMode?.(false)
  if (plain || !stdout.isTTY) return
  for (const mode of [
    FOCUS_REPORTING_MODE,
    KITTY_KEYBOARD_MODE,
    BRACKETED_PASTE_MODE,
    ALTERNATE_SCREEN_MODE,
    HIDDEN_CURSOR_MODE,
  ])
    stdout.write(mode.restore)
}

/**
 * Once the dispatcher has drained it has removed its own stop handlers, and a
 * forwarded stop would otherwise kill the generation by default disposition
 * and be reported as a failure. A stop in that window means "stop now": exit
 * with the outcome already earned. Listeners are never removed; the process
 * exits right after.
 */
export function holdDrainedStop(
  exit: () => void,
  boundary: { on(signal: string, listener: () => void): unknown } = process,
): void {
  for (const signal of GENERATION_SIGNALS) boundary.on(signal, exit)
}

/**
 * Public outcome after the drain: SIGINT exits 0; SIGQUIT exits 131 rather
 * than dumping core by default disposition; SIGHUP and SIGTERM are re-delivered
 * so the shell sees the signal.
 */
export function drainedLauncherExit(
  signal: NodeJS.Signals | undefined,
  publicCode: number,
  boundary: { readonly pid: number; kill(pid: number, signal: NodeJS.Signals): unknown } = process,
): number {
  if (signal === undefined) return publicCode
  if (signal === 'SIGINT') return 0
  if (signal === 'SIGQUIT') return DRAINED_QUIT_EXIT
  boundary.kill(boundary.pid, signal)
  return publicCode
}

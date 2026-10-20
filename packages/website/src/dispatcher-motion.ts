import { bindFigureMotion } from './motion-binding'
import { sequenceRenderer } from './sequence-motion'

export const DURATION = 4800

/** Each ticket is claimed, routed, started, then durably written before the next claim. */
export function stateAt(time: number): { active: string[]; running: string[] } | null {
  if (time >= DURATION) return null
  const beat = Math.floor(Math.max(0, time) / 400)
  const ticket = Math.floor(beat / 4)
  const step = beat % 4
  const active = [
    [`ticket-${ticket}`, 'claim', 'dispatcher'],
    ['dispatcher', 'route', `start-${ticket}`, 'start'],
    [`runner-${ticket}`],
    [`write-${ticket}`, 'write', 'store'],
  ][step]!
  const running = Array.from({ length: ticket + (step >= 2 ? 1 : 0) }, (_, i) => `runner-${i}`)
  return { active, running }
}

export const dispatcherRenderer = (root: ParentNode): ((time: number) => void) =>
  sequenceRenderer(root, stateAt)

export function bindDispatcherMotion(): void {
  bindFigureMotion('dispatcher', DURATION, dispatcherRenderer)
}

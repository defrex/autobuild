import { bindFigureMotion } from './motion-binding'
import { sequenceRenderer } from './sequence-motion'

export const DURATION = 4800

/** Every source routes through the PM agent before its ticket reaches the dispatcher. */
export function stateAt(time: number): { active: string[]; running: string[] } | null {
  if (time >= DURATION) return null
  const beat = Math.floor(Math.max(0, time) / 400)
  const source = Math.floor(beat / 3)
  const active = [[`source-${source}`], ['route', 'pm'], ['delivery', 'queue']][beat % 3]!
  return { active, running: [] }
}

export const intakeRenderer = (root: ParentNode): ((time: number) => void) =>
  sequenceRenderer(root, stateAt)

export function bindIntakeMotion(): void {
  bindFigureMotion('intake', DURATION, intakeRenderer)
}

import { bindFigureMotion } from './motion-binding'

export const DURATION = 4800
const BEATS = [
  ['spec', ''],
  ['plan', 'plan'],
  ['plan-review', 'plan-review'],
  ['plan', 'plan-return'],
  ['plan-review', 'plan-review'],
  ['implement', 'implement'],
  ['code-review', 'code-review'],
  ['implement', 'code-return'],
  ['code-review', 'code-review'],
  ['verify:*', 'verify:*'],
  ['finalize', 'finalize'],
  ['merged', 'merged'],
] as const

export function stateAt(timeMs: number): { node: string; edge: string } | null {
  if (timeMs >= DURATION) return null
  const [node, edge] = BEATS[Math.floor(Math.max(0, timeMs) / 400)]!
  return { node, edge }
}

/** Attribute-only rendering leaves all text, accessible descriptions and geometry intact. */
export function pipelineRenderer(root: ParentNode): (time: number) => void {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-motion-node]')]
  const edges = [...root.querySelectorAll<SVGElement>('[data-motion-edge]')]
  return (time) => {
    const state = stateAt(time)
    for (const node of nodes) {
      node.toggleAttribute('data-motion-active', node.dataset.motionNode === state?.node)
    }
    for (const edge of edges) {
      if (!state) edge.removeAttribute('data-motion-traversed')
      else
        edge.setAttribute('data-motion-traversed', String(edge.dataset.motionEdge === state.edge))
    }
  }
}

export function bindPipelineMotion(): void {
  bindFigureMotion('pipeline', DURATION, pipelineRenderer)
}

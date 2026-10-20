/** A seek renders only attributes; the original text and geometry remain authoritative. */
export function sequenceRenderer(
  root: ParentNode,
  stateAt: (time: number) => { active: string[]; running: string[] } | null,
): (time: number) => void {
  const elements = [...root.querySelectorAll<HTMLElement>('[data-sequence-key]')]
  return (time) => {
    const state = stateAt(time)
    for (const element of elements) {
      const key = element.dataset.sequenceKey!
      if (!state || key === 'human' || key === 'escalation') {
        element.removeAttribute('data-sequence-state')
      } else {
        element.setAttribute(
          'data-sequence-state',
          state.active.includes(key)
            ? 'active'
            : state.running.includes(key)
              ? 'running'
              : 'waiting',
        )
      }
    }
  }
}

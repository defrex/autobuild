/** Shared progressive-enhancement control, outside the drawing's image semantics. */
export function replayControl(name: string): string {
  return `<button type="button" class="word motion-replay" data-motion-replay hidden aria-label="Replay ${name} animation">Replay animation</button>`
}

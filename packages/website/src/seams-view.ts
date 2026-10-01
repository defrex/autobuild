import { SEAMS, initialState, summary, type SeamState } from './seams'

/** Knob offset as CSS: the knob's left edge sits at the remote share of the track. */
export function knobLeft(knob: number): string {
  return `calc(${knob * 100}% - ${knob * 24}px)`
}

export type Lean = 'local' | 'remote'

/** Which word reads as active: remote only once most seams are remote. */
export function lean(knob: number): Lean {
  return knob > 0.5 ? 'remote' : 'local'
}

function chips(state: SeamState): string {
  return SEAMS.map((seam) => {
    const buttons = seam.adapters
      .map(
        (a) =>
          `<button class="chip" type="button" aria-pressed="${state[seam.id] === a.id}" data-seam="${seam.id}" data-adapter="${a.id}">${a.label}</button>`,
      )
      .join('')
    const open = seam.open ? `<span class="chip-open">${seam.open}</span>` : ''
    return `<div class="seam"><div><b>${seam.name}</b><br><span class="dim">${seam.caption}</span></div><div class="chips">${buttons}${open}</div></div>`
  }).join('')
}

export function seamSelector(): string {
  const state = initialState()
  const s = summary(state)
  return `<div class="seam-selector" data-lean="${lean(s.knob)}"><div class="toggle"><button class="word" type="button" data-set="local" aria-label="Set every seam to local">local</button><button class="track" type="button" data-track aria-label="Move every seam to remote"><span class="rail"></span><span class="knob" style="left: ${knobLeft(s.knob)}"></span></button><button class="word" type="button" data-set="remote" aria-label="Set every seam to remote">remote</button><span role="status" class="dim" data-status>${s.label}</span></div><div class="seams">${chips(state)}</div></div>`
}

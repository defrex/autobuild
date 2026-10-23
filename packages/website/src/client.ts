import { bindDocs } from './docs-client'
import { bindSiteHeader } from './site-header-client'
import {
  SEAMS,
  initialState,
  selectAdapter,
  setAll,
  summary,
  toggleTrack,
  type Side,
  type SeamState,
} from './seams'
import { knobLeft, lean } from './seams-view'

/** The seam selector itself when `root` is it (querySelector only searches descendants), else its descendant. */
function closestSelector(root: ParentNode): HTMLElement | null {
  if ('matches' in root && (root as Element).matches('.seam-selector')) return root as HTMLElement
  return root.querySelector<HTMLElement>('.seam-selector')
}

export function applyState(root: ParentNode, state: SeamState): void {
  const s = summary(state)
  for (const chip of root.querySelectorAll<HTMLButtonElement>('.chip')) {
    chip.setAttribute(
      'aria-pressed',
      String(state[chip.dataset.seam ?? ''] === chip.dataset.adapter),
    )
  }
  const selector = closestSelector(root)
  selector?.setAttribute('data-lean', lean(s.knob))
  const knob = root.querySelector<HTMLElement>('.knob')
  if (knob) knob.style.left = knobLeft(s.knob)
  const status = root.querySelector<HTMLElement>('[data-status]')
  if (status) status.textContent = s.label
}

function bindSeams(root: HTMLElement): void {
  let state = initialState()
  const update = (next: SeamState): void => {
    state = next
    applyState(root, state)
  }
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const chip = target?.closest<HTMLElement>('.chip')
    if (chip?.dataset.seam && chip.dataset.adapter) {
      update(selectAdapter(state, chip.dataset.seam, chip.dataset.adapter))
      return
    }
    const set = target?.closest<HTMLElement>('[data-set]')
    if (set) {
      update(setAll(state, set.dataset.set as Side))
      return
    }
    if (target?.closest('[data-track]')) update(toggleTrack(state))
  })
}

if (typeof document !== 'undefined') {
  bindSiteHeader()
  bindDocs()
  const selector = document.querySelector<HTMLElement>('.seam-selector')
  if (selector && SEAMS.length > 0) bindSeams(selector)
}

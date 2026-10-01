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
import { INSTALL_COMMAND } from './constants'
import { knobLeft, lean } from './seams-view'

export interface ClipboardLike {
  writeText(text: string): Promise<void>
}

/** Copies text; resolves false, never throws, when the clipboard is missing or refuses. */
export async function copyText(
  clipboard: ClipboardLike | undefined,
  text: string,
): Promise<boolean> {
  try {
    if (!clipboard) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function applyState(root: ParentNode, state: SeamState): void {
  const s = summary(state)
  for (const chip of root.querySelectorAll<HTMLButtonElement>('.chip')) {
    chip.setAttribute(
      'aria-pressed',
      String(state[chip.dataset.seam ?? ''] === chip.dataset.adapter),
    )
  }
  const selector = root.querySelector<HTMLElement>('.seam-selector')
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

function bindCopy(button: HTMLButtonElement): void {
  button.addEventListener('click', async () => {
    if (await copyText(navigator.clipboard, INSTALL_COMMAND)) button.textContent = 'copied'
  })
}

if (typeof document !== 'undefined') {
  const selector = document.querySelector<HTMLElement>('.seam-selector')
  if (selector && SEAMS.length > 0) bindSeams(selector)
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) bindCopy(button)
}

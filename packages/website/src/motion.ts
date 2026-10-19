export interface CaptureAdapter {
  duration: number
  seek(
    timeMs: number,
    options: { still: boolean },
  ): {
    timeMs: number
    still: boolean
    complete: boolean
  }
}

declare global {
  interface Window {
    __websiteCapture?: Record<string, CaptureAdapter>
  }
}

export interface MotionEnvironment {
  requestFrame(callback: (time: number) => void): number
  cancelFrame(id: number): void
  observe(enter: () => void): () => void
  reduced(): boolean
  hidden(): boolean
  onReducedChange(callback: () => void): () => void
  onVisibilityChange(callback: () => void): () => void
}

/** One clock for viewport playback, replay and capture. Capture takes lasting ownership. */
export function createMotion(
  duration: number,
  render: (time: number) => void,
  control: {
    hidden: boolean
    addEventListener(type: 'click', callback: () => void): void
    removeEventListener(type: 'click', callback: () => void): void
  },
  env: MotionEnvironment,
): CaptureAdapter & { dispose(): void } {
  let frame: number | undefined
  let started = false
  let captured = false
  let stopObserving: (() => void) | undefined
  const stopObservation = (): void => {
    stopObserving?.()
    stopObserving = undefined
  }
  const cancel = (): void => {
    if (frame !== undefined) env.cancelFrame(frame)
    frame = undefined
  }
  const finish = (): void => {
    cancel()
    started = true
    stopObservation()
    render(duration)
  }
  const play = (): void => {
    if (captured || env.reduced() || env.hidden()) return
    cancel()
    started = true
    stopObservation()
    render(0)
    let start: number | undefined
    const tick = (time: number): void => {
      start ??= time
      const elapsed = Math.min(time - start, duration)
      render(elapsed)
      frame = elapsed < duration ? env.requestFrame(tick) : undefined
    }
    frame = env.requestFrame(tick)
  }
  // An unavailable idle figure has not spent its first-entry autoplay. Re-arm
  // observation on return so an already-visible figure gets a fresh callback too.
  const availability = (): void => {
    control.hidden = env.reduced()
    if (env.reduced() || env.hidden()) {
      if (frame !== undefined) finish()
      else stopObservation()
    } else if (!started && !captured && !stopObserving) {
      stopObserving = env.observe(() => {
        if (!started && !captured) play()
      })
    }
  }
  const offPreference = env.onReducedChange(availability)
  const offVisibility = env.onVisibilityChange(availability)
  control.addEventListener('click', play)
  availability()
  return {
    duration,
    seek(timeMs, { still }) {
      captured = true
      finish()
      // Still is the actual reduced-motion presentation, including its hidden control.
      control.hidden = still || env.reduced()
      render(still ? duration : timeMs)
      return { timeMs, still, complete: timeMs >= duration }
    },
    dispose() {
      finish()
      control.hidden = true
      offPreference()
      offVisibility()
      control.removeEventListener('click', play)
    },
  }
}

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
  let stopObserving = () => {}
  const cancel = (): void => {
    if (frame !== undefined) env.cancelFrame(frame)
    frame = undefined
  }
  const finish = (): void => {
    cancel()
    started = true
    stopObserving()
    render(duration)
  }
  const play = (): void => {
    if (captured || env.reduced() || env.hidden()) return
    cancel()
    started = true
    stopObserving()
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
  const preference = (): void => {
    control.hidden = env.reduced()
    if (env.reduced()) finish()
  }
  const visibility = (): void => {
    if (env.hidden()) finish()
  }
  const offPreference = env.onReducedChange(preference)
  const offVisibility = env.onVisibilityChange(visibility)
  control.addEventListener('click', play)
  control.hidden = env.reduced()
  if (env.reduced() || env.hidden()) finish()
  else
    stopObserving = env.observe(() => {
      if (!started && !captured) play()
    })
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

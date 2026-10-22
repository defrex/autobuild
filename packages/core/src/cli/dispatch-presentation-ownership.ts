/** Process-local output guard, never lifecycle authority. Durable terminal
 * release and lease acquisition decide when another generation may present. */
let released = false
export function releaseDispatchPresentation(): void {
  released = true
}
export function ownsDispatchPresentation(): boolean {
  return !released
}

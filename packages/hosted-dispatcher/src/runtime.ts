import { createDispatcherEndpoint } from './dispatcher'

let dispatcher: ReturnType<typeof createDispatcherEndpoint> | undefined
export function dispatcherEndpoint() {
  dispatcher ??= createDispatcherEndpoint({ env: process.env })
  return dispatcher
}

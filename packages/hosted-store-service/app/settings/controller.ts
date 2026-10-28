import type { ProjectSettings } from '@defrex/autobuild-hosted-store-service/operator-api'
import { WebOperatorError } from '../dashboard/api'

export interface SettingsState {
  data?: ProjectSettings
  pending?: string
  readError?: string
  writeError?: string
}
/** One mounted project's request lifecycle; transient values are never retained. */
export function settingsController(options: {
  read: () => Promise<ProjectSettings>
  write: (operation: 'set' | 'remove', name: string, value?: string) => Promise<unknown>
  changed: (state: SettingsState) => void
  acknowledged: () => void
}) {
  let state: SettingsState = {}
  let sequence = 0
  let live = true
  let busy = false
  const publish = (next: SettingsState) => {
    state = next
    if (live) options.changed(state)
  }
  async function refresh() {
    const id = ++sequence
    try {
      const data = await options.read()
      if (live && id === sequence) publish({ ...state, data, readError: undefined })
    } catch {
      if (live && id === sequence)
        publish({ ...state, readError: 'Could not refresh project secrets. Try again shortly.' })
    }
  }
  return {
    refresh,
    activate() {
      live = true
    },
    poll() {
      if (!busy) return refresh()
    },
    dispose() {
      live = false
      sequence++
    },
    async write(operation: 'set' | 'remove', name: string, value?: string): Promise<boolean> {
      if (!live || busy) return false
      busy = true
      sequence++
      publish({ ...state, pending: name, writeError: undefined })
      try {
        await options.write(operation, name, value)
        if (live) {
          options.acknowledged()
          void refresh()
        }
        return true
      } catch (cause) {
        const safe = [
          'The service’s project-secret encryption key is not configured or usable. An administrator must fix it.',
          'Refreshing credentials must be renewed with ab accounts login <account> --project.',
          'Enter a nonempty value of at most 65536 bytes without NUL characters.',
          'Project membership required.',
          'Unknown project.',
        ]
        publish({
          ...state,
          writeError:
            cause instanceof WebOperatorError && safe.includes(cause.message)
              ? cause.message
              : 'The write was refused. Check project access and the secret name, then try again.',
        })
        return false
      } finally {
        busy = false
        publish({ ...state, pending: undefined })
      }
    },
  }
}

import { EventValidationError, validateEventWrite, type EventWrite } from '../events/catalog'
import type { NewBuildInput } from './types'

/** Validate `input.created` before an adapter opens its create transaction, so
 * an invalid initial event creates nothing. Returns the validated write. */
export function validateCreatedEvent(
  input: NewBuildInput,
): EventWrite<'build.created'> | undefined {
  if (input.created === undefined) return undefined
  const validated = validateEventWrite(input.created)
  if (validated.type !== 'build.created') {
    throw new EventValidationError(
      `createBuild's initial event must be "build.created", got "${validated.type}"`,
    )
  }
  return validated as EventWrite<'build.created'>
}

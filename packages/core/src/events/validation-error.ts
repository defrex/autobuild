/** A rejected event write. Kept apart from the build-event catalog so other
 * event vocabularies can throw it without initializing that catalog;
 * `./catalog` re-exports it. */
export class EventValidationError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = 'EventValidationError'
  }
}

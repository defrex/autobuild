/** A permanent rejection of an outgoing store write's request size. */
export class StoreWriteTooLargeError extends Error {
  override readonly name = 'StoreWriteTooLargeError'

  constructor(
    readonly method: string,
    readonly route: string,
    readonly requestBytes: number,
    serverMessage?: string,
  ) {
    super(
      `oversized store write: ${method} ${route} (${requestBytes} request bytes)` +
        (serverMessage === undefined ? '' : `: ${serverMessage}`),
    )
  }
}

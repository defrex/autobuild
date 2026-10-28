/** An optional metadata capability is unavailable; callers may use ordinary artifact reads. */
export class ArtifactMetaUnsupportedError extends Error {
  constructor() {
    super('latest artifact metadata is unsupported')
    this.name = 'ArtifactMetaUnsupportedError'
  }
}

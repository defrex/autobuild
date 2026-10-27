/** Physical deletion is hosted maintenance, deliberately outside BlobStore. */
export interface BlobMaintenance {
  /** Remove an exact content key, including stored versions. Missing is success. */
  /** Bounded exact-key batch; partial provider failure rejects and is retryable. */
  deleteMany?(hashes: string[]): Promise<void>
  delete(hash: string): Promise<void>
}

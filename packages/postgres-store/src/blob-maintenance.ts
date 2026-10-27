/** Physical deletion is hosted maintenance, deliberately outside BlobStore. */
export interface BlobMaintenance {
  /** Remove an exact content key, including stored versions. Missing is success. */
  delete(hash: string): Promise<void>
}

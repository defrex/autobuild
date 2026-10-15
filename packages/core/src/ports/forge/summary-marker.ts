/** Stable, injection-safe identity shared by built-in forge adapters. */
export function summaryMarker(build: string): string {
  return `<!-- autobuild-summary:v1:${Buffer.from(build).toString('hex')} -->`
}

export function findSummaryMarker(body: string): string | undefined {
  return body.split('\n').find((line) => /^<!-- autobuild-summary:v1:[0-9a-f]+ -->$/.test(line))
}

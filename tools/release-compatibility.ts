/** Repository-local release preparation. Never writes candidates into the tree. */
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import {
  supportedPublishedLines,
  validatePublications,
  releaseLine,
  type ReleasedClient,
} from '../packages/core/src/store/remote/released-clients'
import type { ReleasedReducerValues } from '../packages/core/src/store/remote/released-reducer-values'

export const COMPATIBILITY_ROOT = 'packages/core/src/store/remote'
export interface CompatibilityCandidate {
  path: string
  content: string
}
export interface PublishedEvidence {
  publication: ReleasedClient
  catalog: ReleasedReducerValues
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const contractBytes = (catalog: ReleasedReducerValues | undefined) =>
  catalog &&
  json({
    roots: catalog.roots,
    schemas: catalog.schemas,
    versions: Object.fromEntries(
      Object.entries(catalog.versions).sort(([a], [b]) => a.localeCompare(b)),
    ),
  })

/** Generated candidates must already pass the repository's formatter gate. */
async function catalogJson(value: ReleasedReducerValues): Promise<string> {
  const child = Bun.spawn(
    [
      resolve(import.meta.dir, '../node_modules/.bin/biome'),
      'format',
      '--stdin-file-path=release.json',
    ],
    {
      stdin: new TextEncoder().encode(json(value)),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`cannot format frozen release catalog: ${error}`)
  return output
}

/** Missing outgoing evidence is recovered from the immutable npm artifact,
 * never by attaching the outgoing version to this checkout's schemas. */
export async function recoverPublished(root: string, version: string): Promise<PublishedEvidence> {
  const registry = 'https://registry.npmjs.org/@defrex%2fautobuild'
  const response = await fetch(registry)
  if (!response.ok) throw new Error(`cannot recover publication evidence: HTTP ${response.status}`)
  const metadata = (await response.json()) as {
    time: Record<string, string>
    versions: Record<string, { dist: { tarball: string; integrity: string } }>
  }
  const entry = metadata.versions[version]
  if (!entry || !metadata.time[version])
    throw new Error(`missing published evidence for ${version}`)
  const download = await fetch(entry.dist.tarball)
  if (!download.ok) throw new Error(`cannot download published ${version}`)
  const bytes = new Uint8Array(await download.arrayBuffer())
  const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
  if (!entry.dist.integrity.split(' ').includes(integrity))
    throw new Error(`integrity mismatch for ${version}`)
  await mkdir(resolve(root, '.ab/release-compatibility'), { recursive: true })
  const scratch = await mkdtemp(resolve(root, '.ab/release-compatibility/published-'))
  try {
    const archive = join(scratch, 'published.tgz')
    await Bun.write(archive, bytes)
    const child = Bun.spawn(['tar', 'xzf', archive, '-C', scratch], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((await child.exited) !== 0) throw new Error(`cannot unpack published ${version}`)
    const base = join(scratch, 'package')
    const { REDUCERS } = await import(
      pathToFileURL(join(base, 'packages/core/src/kernel/reducer-registry.ts')).href
    )
    const identity = await import(pathToFileURL(join(base, COMPATIBILITY_ROOT, 'version.ts')).href)
    const shapes = JSON.parse(
      await readFile(join(base, 'packages/core/src/store/reducer-value-shapes.json'), 'utf8'),
    )
    const client = await readFile(join(base, COMPATIBILITY_ROOT, 'client.ts'), 'utf8')
    return {
      publication: {
        version,
        publishedAt: metadata.time[version]!,
        protocol: identity.REMOTE_STORE_PROTOCOL_VERSION,
        contract: `${version}.json`,
        projects: client.includes("[REDUCER_VALUE_PROJECTION_HEADER]: '1'"),
        provenance: { registry, ...entry.dist },
      },
      catalog: {
        ...shapes,
        versions: Object.fromEntries(
          Object.entries(REDUCERS as Record<string, { reducer: { version: number } }>).map(
            ([name, entry]: [string, { reducer: { version: number } }]) => [
              name,
              entry.reducer.version,
            ],
          ),
        ),
      },
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function prepareReleaseCompatibility(input: {
  root: string
  outgoing: string
  target: string
  now: string
  recover?: (root: string, version: string) => Promise<PublishedEvidence>
  /** Offline seams exercise the same preparation with small frozen catalogs. */
  current?: { catalog: ReleasedReducerValues; protocol: string }
}): Promise<CompatibilityCandidate[]> {
  const { root, outgoing, target, now } = input
  const ledgerPath = `${COMPATIBILITY_ROOT}/released-clients.json`
  const releases = JSON.parse(await readFile(resolve(root, ledgerPath), 'utf8')) as ReleasedClient[]
  validatePublications(releases)
  const original = json(releases)
  const candidates: CompatibilityCandidate[] = []
  const catalogs = new Map<string, ReleasedReducerValues>()
  for (const entry of releases)
    if (entry.contract) {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?\.json$/.test(entry.contract))
        throw new Error('invalid catalog reference')
      try {
        catalogs.set(
          entry.contract,
          JSON.parse(
            await readFile(
              resolve(root, COMPATIBILITY_ROOT, 'released-reducer-values', entry.contract),
              'utf8',
            ),
          ),
        )
      } catch {
        /* completeness below decides whether a retired contract is required */
      }
    }
  const outgoingEntry = releases.find((entry) => entry.version === outgoing)
  if (
    (!outgoingEntry?.protocol ||
      !outgoingEntry.contract ||
      !catalogs.has(outgoingEntry.contract)) &&
    semver.prerelease(outgoing) === null
  ) {
    const evidence = await (input.recover ?? recoverPublished)(root, outgoing)
    if (evidence.publication.version !== outgoing || !evidence.publication.contract)
      throw new Error('outgoing provenance does not match release')
    if (
      outgoingEntry &&
      (Date.parse(outgoingEntry.publishedAt) !== Date.parse(evidence.publication.publishedAt) ||
        (outgoingEntry.protocol && outgoingEntry.protocol !== evidence.publication.protocol))
    )
      throw new Error('published evidence conflicts with immutable outgoing identity or date')
    const retainedContract =
      outgoingEntry?.contract && catalogs.has(outgoingEntry.contract)
        ? outgoingEntry.contract
        : undefined
    if (outgoingEntry)
      Object.assign(outgoingEntry, evidence.publication, {
        publishedAt: outgoingEntry.publishedAt,
        contract: retainedContract ?? evidence.publication.contract,
      })
    else releases.push(evidence.publication)
    if (!retainedContract) {
      catalogs.set(evidence.publication.contract, evidence.catalog)
      candidates.push({
        path: `${COMPATIBILITY_ROOT}/released-reducer-values/${evidence.publication.contract}`,
        content: await catalogJson(evidence.catalog),
      })
    }
  }
  let current = input.current
  if (!current) {
    const { REDUCERS } = await import(
      pathToFileURL(resolve(root, 'packages/core/src/kernel/reducer-registry.ts')).href
    )
    const { REMOTE_STORE_PROTOCOL_VERSION } = await import(
      pathToFileURL(resolve(root, COMPATIBILITY_ROOT, 'version.ts')).href
    )
    current = {
      protocol: REMOTE_STORE_PROTOCOL_VERSION,
      catalog: {
        ...JSON.parse(
          await readFile(
            resolve(root, 'packages/core/src/store/reducer-value-shapes.json'),
            'utf8',
          ),
        ),
        versions: Object.fromEntries(
          Object.entries(REDUCERS as Record<string, { reducer: { version: number } }>).map(
            ([name, entry]: [string, { reducer: { version: number } }]) => [
              name,
              entry.reducer.version,
            ],
          ),
        ),
      },
    }
  }
  const prior = releases.find((entry) => entry.version === target)
  if (prior) {
    if (
      prior.protocol !== current.protocol ||
      !prior.contract ||
      contractBytes(catalogs.get(prior.contract)) !== contractBytes(current.catalog)
    )
      throw new Error(`cannot replace immutable release contract ${target}`)
  } else {
    const equivalent = [...catalogs].find(
      ([, catalog]) => contractBytes(catalog) === contractBytes(current!.catalog),
    )
    const contract = equivalent?.[0] ?? `${target}.json`
    releases.push({
      version: target,
      publishedAt: now,
      protocol: current.protocol,
      contract,
      projects: true,
      provenance: { tag: `v${target}` },
    })
    if (!equivalent) {
      catalogs.set(contract, current.catalog)
      candidates.push({
        path: `${COMPATIBILITY_ROOT}/released-reducer-values/${contract}`,
        content: await catalogJson(current.catalog),
      })
    }
  }
  releases.sort((a, b) => semver.compare(a.version, b.version))
  validatePublications(releases)
  const supported = new Set(supportedPublishedLines(target, Date.parse(now), releases))
  for (const entry of releases) {
    if (!supported.has(releaseLine(entry.version))) continue
    const catalog = entry.contract && catalogs.get(entry.contract)
    if (
      !entry.protocol ||
      !catalog ||
      !Object.keys(catalog.roots).length ||
      Object.keys(catalog.roots).some((name) => !Number.isInteger(catalog.versions[name]))
    )
      throw new Error(`missing supported identity or contract: ${entry.version}`)
    // Protocol 6 is the retained handler family above the 1.2 floor. New wire
    // families must deliberately retain and prove old handlers before releasing.
    if (entry.protocol !== '6')
      throw new Error(`missing retained handler evidence for protocol ${entry.protocol}`)
    for (const other of releases)
      if (
        releaseLine(other.version) === releaseLine(entry.version) &&
        other.protocol &&
        other.protocol !== entry.protocol
      )
        throw new Error('patch release cannot change protocol')
  }
  if (json(releases) !== original) candidates.push({ path: ledgerPath, content: json(releases) })
  const contracts = [
    ...new Set(
      releases.flatMap((entry) =>
        entry.contract && catalogs.has(entry.contract) ? [entry.contract] : [],
      ),
    ),
  ].sort()
  const registry =
    '// Generated release catalog registry. Historical catalogs are immutable evidence.\n' +
    contracts.map((file, index) => `import release${index} from './${file}'\n`).join('') +
    "import type { ReducerValueCatalog } from '../../reducer-value-validation'\nexport interface ReleasedReducerValues extends ReducerValueCatalog {\n  versions: Record<string, number>\n}\nexport const RELEASED_REDUCER_VALUES: Readonly<Record<string, ReleasedReducerValues>> = {\n" +
    contracts.map((file, index) => `  '${file}': release${index},\n`).join('') +
    '}\n'
  const registryPath = `${COMPATIBILITY_ROOT}/released-reducer-values/index.ts`
  if ((await readFile(resolve(root, registryPath), 'utf8').catch(() => undefined)) !== registry)
    candidates.push({ path: registryPath, content: registry })
  return candidates
}

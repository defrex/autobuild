import { join } from 'node:path'
import { repoRoot } from './git-tracked'
import { publishablePackages } from './release'
import { readWorkspaceManifests } from './workspace-manifest-check'

/**
 * Fails when `bun pm pack --dry-run` would pack anything outside a publishable
 * package's allowlist, when a `files` allowlist entry packs nothing, when a
 * manifest's exports/bin targets would not resolve from the tarball, or when
 * the publishable set itself cannot be enumerated. Every publishable workspace
 * manifest's tarball is guarded — the packed surface of each publishable
 * package is deliberate, not incidental.
 *
 * **What makes a manifest publishable.** A manifest is publishable iff the
 * release's own `publishablePackages` includes it: a non-private workspace
 * manifest, the repository root included. Release publishes exactly that set
 * via `bun publish --access public` (`PUBLISH_ARGS` in `tools/release.ts`),
 * and every package in it also declares `publishConfig.access: "public"`.
 * `private: true` both opts a manifest out of publication and out of this
 * guard, so a newly publishable package enters the ruled set the moment it is
 * not private — it cannot be silently skipped. The ruled set is derived with
 * the release's own code (`readWorkspaceManifests` → `publishablePackages`,
 * the same enumeration `tools/publish-imports-check.ts` uses; no
 * hand-maintained package list), and each package's ruling is derived from its
 * declared `files` allowlist, so ruling and manifest cannot drift apart.
 * Today that yields, in publish order: `@defrex/autobuild` (the root
 * manifest), `@defrex/autobuild-postgres-store`,
 * `@defrex/autobuild-hosted-store-service`,
 * `@defrex/autobuild-hosted-dispatcher` (`@defrex/autobuild-core` is
 * `private: true` and excluded).
 *
 * The three sub-package rulings and the root ruling carry their rulings' pinned prose:
 *
 * - AUT-463 — `@defrex/autobuild-hosted-store-service` ships exactly
 *   `package.json`, `README.md`, and `src/**` — with the AUT-490 exception that
 *   every `*.test.ts`, `*.test.tsx`, `*.spec.ts`, and `*.spec.tsx` file under `src/` (written
 *   as the negations `!src/**` + `*.test.ts`, `*.test.tsx`, `*.spec.ts`, and `*.spec.tsx` in
 *   the manifest; the within-segment `*` also covers the `*.live.test.*`
 *   suites) does not publish. The ruling exists because
 *   AUT-409's move of the operator web app into the service package silently
 *   added `app/`, `server.ts`, `next.config.ts`, `vercel.json`,
 *   `tsconfig.json`, `next-env.d.ts`, and the internal
 *   `.impeccable/surfaces/` design brief to the published npm tarball: the
 *   manifest declared no `files` field, so npm's default
 *   (everything-not-ignored) packed the whole package directory. Every npm
 *   consumption path goes through the manifest's `exports` map and `bin`, all
 *   of which live under `src/`; the app and config files are
 *   release-checkout/Vercel surface read from the repository at deploy time,
 *   never from node_modules, and the Impeccable surface brief is internal.
 *   The allowlist is the durable fix: deny-by-default, so a file added to the
 *   package later stays out of the tarball unless deliberately allowlisted —
 *   the exact failure mode the move created.
 * - AUT-473 — `@defrex/autobuild-postgres-store` declares the same shape
 *   (`files: ["src", "README.md"]`) so its tarball ships exactly
 *   `package.json`, `README.md`, and `src/**` — again with the AUT-490
 *   test-file exception (the negated `*.test.ts`, `*.test.tsx`, `*.spec.ts`,
 *   and `*.spec.tsx` spellings) — by manifest rather than by
 *   directory layout. Its directory today carries only `src/`, so the tarball
 *   was correct by accident of layout; deny-by-default keeps a future
 *   top-level addition (a scratch script, a live-test fixture, a dotenv file,
 *   an editor artifact) out of the tarball unless the allowlist and this check
 *   are updated together.
 * - AUT-490 — none of the three sub-packages' tarballs carries test files:
 *   each `files` allowlist negates every `*.test.ts`, `*.test.tsx`, `*.spec.ts`,
 *   and `*.spec.tsx` file under `src/` (manifest entries `!src/**` + `*.test.ts`,
 *   `!src/**` + `*.test.tsx`, `!src/**` + `*.spec.ts`, and `!src/**` + `*.spec.tsx`;
 *   under the matcher's within-segment `*`, this also denies the `*.live.test.*`
 *   suites). This is a deliberate ruling, not a leak: the root package takes the same
 *   stance (its `packages/core/src` test files are negated the same way), the tests
 *   are written for `bun test`
 *   (not a declared runtime dependency of the packages), and the live suites
 *   additionally need a Postgres URL and env a consumer installing from npm
 *   cannot have. The denial is bounded to the TypeScript test spellings: `*.test.js`,
 *   `*.spec.js`, `*.test.jsx`, and `*.spec.jsx` are deliberately out of scope (this
 *   workspace writes its tests in TypeScript only), so a future JS/JSX test file
 *   would publish unless the ruling is deliberately widened here and in the
 *   manifests together. If a sub-package's ruling changes, update its 'files'
 *   allowlist and this check together.
 * - AUT-503 — the root `@defrex/autobuild` tarball ships `packages/core/src` except its
 *   `*.test.ts`, `*.test.tsx`, `*.spec.ts`, and `*.spec.tsx` files (AUT-490's negation, broadened
 *   to the four spellings by AUT-508); the test-only `src/testing/store-failures.ts` and
 *   `src/testing/packed-install.ts` helpers (their sole consumers are the pack-denied test
 *   files) are excluded by per-file negations, while `src/testing/fixed.ts` and
 *   `src/testing/index.ts` deliberately ship: `fixed.ts` is a runtime dependency of the packed
 *   `./plugin-sdk` surface (`store/contract.ts` imports `manualClock` from it) and `index.ts`
 *   is the `./testing` exports target that out-of-tree packages' tests build against. See
 *   `ROOT_RULING` below for the warning about publish-imports-check's self-scan skip.
 * - AUT-506 — the same ruling extended once more: the test-only `src/cli/testkit.ts` helper
 *   (its sole consumers are the colocated `*.test.ts` files the pack already denies; no
 *   exports target and no packed source imports it) is excluded by a per-file negation, while
 *   `src/integration/harness.ts` deliberately ships: it is a runtime dependency of the packed
 *   `./testing` surface (`src/testing/index.ts` re-exports the harness that out-of-tree packages'
 *   tests build against), the same load-bearing shape as `src/testing/fixed.ts` under AUT-503.
 * - AUT-513 — the same ruling extended once more: the remaining four dead-weight files
 *   (`src/cli/store-opening.contract.ts`, a shared `bun:test` contract suite;
 *   `src/ports/runner/live-contract-fixture.ts`, a live-suite fixture;
 *   `src/cli/dashboard/frame-image.ts`, a `@resvg/resvg-js`-dependent PNG renderer whose
 *   dependency is a root devDependency only; and `src/markdown.ts`, approximate link-target
 *   extraction written for the repo's own doc checks) are excluded by per-file negations: each
 *   ships with no packed importer and no exports/bin target, and its sole consumers are the
 *   pack-denied `*.test.ts` / `*.live.test.ts` files (for `frame-image.ts` and `markdown.ts`
 *   also the unpacked repo tooling, which reads the working tree by relative path).
 *
 * Every ruling is read out of its package's declared `files` allowlist, so
 * ruling and manifest cannot drift apart:
 *
 * - positive entries (leading `./` and trailing `/` stripped) become allowed
 *   surfaces: a packed path is allowed iff it equals a surface or starts with
 *   `surface + '/'`, and matches no negation — npm's own file-or-directory
 *   semantics, so an entry needs no file-vs-directory classification and no
 *   filesystem probing;
 * - every surface must be represented in the listing (the exact path packed,
 *   or at least one packed path under it), which also catches a `files` entry
 *   that packs nothing (a typo in the allowlist would otherwise ship nothing
 *   while looking deliberate);
 * - negation entries (leading `!`) become denied glob patterns — a packed path
 *   matching one is a violation even where a surface would allow it (the root
 *   manifest denies its `packages/core/src` test files through the negations
 *   `!packages/core/src/**` with the `*.test.ts`, `*.test.tsx`, `*.spec.ts`, and
 *   `*.spec.tsx` suffixes; bun honors them);
 * - every `exports`/`bin` target in the manifest must appear in the packed
 *   listing (the packed artifact must resolve everything the manifest
 *   promises);
 * - a manifest that declares no non-empty `files` array keeps the
 *   `no-files-allowlist` violation: the publishable surface must be pinned by
 *   manifest, not by whatever happens to sit in the package directory.
 *
 * Implementation notes:
 *
 * - The check packs through bun's own packer (`bun pm pack --ignore-scripts
 *   --dry-run`), the same packing implementation `bun publish` (which
 *   `tools/release.ts` uses) runs, so it asserts what would actually ship.
 *   `--ignore-scripts` matches release's `PUBLISH_ARGS` and keeps the root
 *   `prepare` script from running `husky`, which is not on PATH in every
 *   sandbox. `--dry-run` writes no tgz.
 * - The parser keys on bun 1.4.0's `packed <size> <path>` listing lines (the
 *   version `autobuild.toml` and the workspace engines pin). The tgz-name
 *   line and the `Total files:`/`Unpacked size:` trailer are ignored. A
 *   listing with no parseable packed lines is a failure, never a pass, so a
 *   format drift fails loudly here instead of silently retiring the
 *   invariant.
 * - `README.md` and `package.json` are always included by the packer
 *   regardless of the allowlist; requiring them in the listing means a
 *   listing that failed to parse or truncate cannot masquerade as a pass.
 * - Surface presence is a presence check, not an exact-file check: the
 *   allowlisted trees evolve, and `package-boundary-check` plus the manifests'
 *   exports are the tripwires for what they may depend on. The rulings this
 *   check enforces are the *boundaries* (nothing outside the allowlist plus
 *   the two manifest-mandated files), not frozen file lists.
 * - Enumeration is fail-closed: a thrown `readWorkspaceManifests` or
 *   `publishablePackages` (an unparseable manifest, a missing name, a
 *   dependency cycle) is reported on stderr and exits 1, never a pass, the
 *   same shape as `publish-imports-check`.
 * - Every publishable package is checked all the way through: one failing
 *   package never hides another's violations, and a package whose manifest
 *   declares no usable allowlist is reported rather than silently skipped.
 */

/** A package whose npm tarball contents are ruled, and what the ruling requires. */
export interface TarballRuling {
  /** The package's npm name, used to label every message about it. */
  readonly name: string
  /** The package's directory, repo-root-relative (`.` for the root manifest). */
  readonly directory: string
  /** Paths the ruling requires in every tarball (`README.md` and `package.json` are always packed). */
  readonly requiredPackedPaths: readonly string[]
  /**
   * The positive `files` entries (leading `./` and trailing `/` stripped). A
   * packed path is allowed iff it equals a surface or starts with
   * `surface + '/'` — npm's own file-or-directory semantics — and matches no
   * denied pattern.
   */
  readonly allowedSurfaces: readonly string[]
  /**
   * Negated `files` entries (leading `!` stripped) as glob patterns; a packed
   * path matching one is denied even where a surface would allow it.
   */
  readonly deniedPackedPatterns: readonly string[]
  /** The ruling text, printed above the violations so the rationale ships with the failure. */
  readonly ruling: string
  /** Per-surface overrides of the missing-surface sentence, for rulings whose legacy wording is pinned. */
  readonly missingSurfaceMessages?: Readonly<Record<string, string>>
}

const HOSTED_STORE_SERVICE_RULING =
  'Ruling (AUT-463, extended by AUT-490, extended by AUT-502): the @defrex/autobuild-hosted-store-service npm tarball ships exactly ' +
  'package.json, README.md, and src/** — except src/**/*.test.ts, src/**/*.test.tsx, src/**/*.spec.ts, and src/**/*.spec.tsx files (the within-segment * ' +
  'covers the *.live.test.* suites too): test files are dev-only surface and do not publish. The denial covers the TypeScript test spellings ' +
  'only: *.test.js, *.spec.js, *.test.jsx, and *.spec.jsx are deliberately out of scope (this workspace writes its tests in TypeScript ' +
  'only), so a future JS/JSX test file would publish unless the ruling is widened here and in the manifests together. The Next.js app/ tree, server.ts, next.config.ts, ' +
  'vercel.json, tsconfig.json, next-env.d.ts, and the internal .impeccable/ surface brief are ' +
  'release-checkout/Vercel surface and must not publish. If the ruling changes, update the ' +
  "'files' allowlist in packages/hosted-store-service/package.json and this check together."

const POSTGRES_STORE_RULING =
  'Ruling (AUT-473, extended by AUT-490, extended by AUT-500, extended by AUT-502): the @defrex/autobuild-postgres-store npm tarball ships exactly ' +
  'package.json, README.md, and src/** — except src/**/*.test.ts, src/**/*.test.tsx, src/**/*.spec.ts, and src/**/*.spec.tsx files (the within-segment * ' +
  'covers the *.live.test.* suites too): test files are dev-only surface and do not publish. The denial covers the TypeScript test spellings ' +
  'only: *.test.js, *.spec.js, *.test.jsx, and *.spec.jsx are deliberately out of scope (this workspace writes its tests in TypeScript ' +
  'only), so a future JS/JSX test file would publish unless the ruling is widened here and in the manifests together. By AUT-500 the src/testing/ tree is also ' +
  'test-only dev surface (its helpers are consumed only by the live suites, e.g. ' +
  'src/store.live.test.ts spawning src/testing/concurrent-worker.ts) and is excluded from the tarball by the !src/testing/** ' +
  'negation. The allowlist pins the publishable surface by manifest ' +
  'rather than by directory layout: a future top-level file in packages/postgres-store (a ' +
  'scratch script, a live-test fixture, a dotenv file, an editor artifact) must not ride into ' +
  'the tarball. If the ruling changes, update the ' +
  "'files' allowlist in packages/postgres-store/package.json and this check together."

const DISPATCHER_RULING =
  'Ruling (AUT-490, extended by AUT-502): the @defrex/autobuild-hosted-dispatcher npm tarball ships exactly ' +
  'package.json, README.md, and src/** — except src/**/*.test.ts, src/**/*.test.tsx, src/**/*.spec.ts, and src/**/*.spec.tsx files (the within-segment * ' +
  'covers the *.live.test.* suites too): test files are dev-only surface and do not publish. The denial covers the TypeScript test spellings ' +
  'only: *.test.js, *.spec.js, *.test.jsx, and *.spec.jsx are deliberately out of scope (this workspace writes its tests in TypeScript ' +
  'only), so a future JS/JSX test file would publish unless the ruling is widened here and in the manifests together. They are ' +
  'written for `bun test` and are dead weight for consumers; the root package takes the same ' +
  'stance, and a deliberate negation keeps the surface from drifting wider by accident. If ' +
  'the ruling changes, update the ' +
  "'files' allowlist in packages/hosted-dispatcher/package.json and this check together."

const ROOT_RULING =
  'Ruling (AUT-490, extended by AUT-503, extended by AUT-508, extended by AUT-506, extended by AUT-513, extended by AUT-552): the @defrex/autobuild npm tarball ships bin, packages/core/src, ' +
  'skills, templates, LICENSE, README.md, SPEC.md, and docs — except every *.test.ts, *.test.tsx, *.spec.ts, and *.spec.tsx file under ' +
  'packages/core/src (the !packages/core/src/**/*.test.ts, !packages/core/src/**/*.test.tsx, !packages/core/src/**/*.spec.ts, and ' +
  '!packages/core/src/**/*.spec.tsx negations; the within-segment * covers the *.live.test.* suites too): test files are dev-only surface and do ' +
  'not publish. The denial covers the TypeScript test spellings only: *.test.js, *.spec.js, *.test.jsx, and *.spec.jsx are deliberately out of ' +
  'scope (this workspace writes its tests in TypeScript only), so a future JS/JSX test file would publish unless the ruling is widened here and ' +
  'in the manifests together. By AUT-503 the test-only src/testing/store-failures.ts and src/testing/packed-install.ts ' +
  'helpers (their sole consumers are *.test.ts files the pack already denies) are excluded by per-file ' +
  'negations, while src/testing/fixed.ts and src/testing/index.ts deliberately ship: fixed.ts is a runtime ' +
  'dependency of the packed ./plugin-sdk surface (store/contract.ts imports manualClock from it), and ' +
  "index.ts is the ./testing exports target that out-of-tree packages' tests build against. By AUT-506 the " +
  'test-only src/cli/testkit.ts helper (its sole consumers are the colocated *.test.ts files the pack already ' +
  'denies; no exports target and no packed source imports it) is excluded by a per-file negation, while ' +
  'src/integration/harness.ts deliberately ships: it is a runtime dependency of the packed ./testing surface ' +
  "(src/testing/index.ts re-exports the harness that out-of-tree packages' tests build against), the same " +
  'load-bearing shape as src/testing/fixed.ts under AUT-503. By AUT-513 the remaining four dead-weight files ' +
  'src/cli/store-opening.contract.ts (a shared bun:test contract suite), src/ports/runner/live-contract-fixture.ts (a live-suite fixture), ' +
  'src/cli/dashboard/frame-image.ts (a PNG renderer whose @resvg/resvg-js dependency is a root devDependency only), and ' +
  "src/markdown.ts (approximate link-target extraction written for the repo's own doc checks) are excluded by per-file negations: " +
  'each ships with no packed importer and no exports/bin target, and its sole consumers are the pack-denied *.test.ts and *.live.test.ts ' +
  'files — for frame-image.ts and markdown.ts also the unpacked repo tooling tools/dashboard-capture.ts, tools/docs-asset-check.ts, and ' +
  'tools/skill-docs-asset-check.ts, which read the working tree by relative path — so dropping them from the tarball changes nothing for ' +
  "any consumer; no packed source imports any of them. By AUT-552 the repo's patches/ directory is excluded from the tarball — the workspace install reads the patch from the repo tree, not from the tarball, and the packed manifest strips patchedDependencies (packedManifestOmittedFields in packages/core/src/ports/workspace/distribution-archive.ts), so the packed artifact never consumes the patch file and shipping it was dead weight. Warning: " +
  "publish-imports-check does not scan the provider's own packed files, so excluding fixed.ts would pass " +
  'every check while breaking the packed ./plugin-sdk export. If the ruling changes, update the ' +
  "'files' allowlist in package.json and this check together."

/** The missing-surface sentence the pre-widening check printed for `src/`;
 * the store rulings keep it verbatim (their legacy wording is pinned). */
const MISSING_SRC_SURFACE_MESSAGE =
  'no src/ file is packed; the ruling requires the src/ tree (every exports and bin target lives there)'

/**
 * Rulings whose prose their rulings pinned (AUT-463/AUT-473/AUT-490/AUT-503), keyed by npm
 * name. Every other publishable package gets the generic derived template, so
 * a newly publishable package is guarded without anyone extending this map.
 */
const PINNED_RULING_PROSE: Readonly<
  Record<string, { ruling: string; missingSurfaceMessages?: Readonly<Record<string, string>> }>
> = {
  '@defrex/autobuild': { ruling: ROOT_RULING },
  '@defrex/autobuild-hosted-store-service': {
    ruling: HOSTED_STORE_SERVICE_RULING,
    missingSurfaceMessages: { src: MISSING_SRC_SURFACE_MESSAGE },
  },
  '@defrex/autobuild-postgres-store': {
    ruling: POSTGRES_STORE_RULING,
    missingSurfaceMessages: { src: MISSING_SRC_SURFACE_MESSAGE },
  },
  '@defrex/autobuild-hosted-dispatcher': {
    ruling: DISPATCHER_RULING,
    missingSurfaceMessages: { src: MISSING_SRC_SURFACE_MESSAGE },
  },
}

const genericRulingProse = (name: string, manifestPath: string): string =>
  `Ruling (derived from the manifest): the ${name} npm tarball packs exactly what the ` +
  `'files' allowlist in ${manifestPath} declares. The allowlist is deny-by-default: a packed ` +
  'path outside it, a path matching a negated entry, an allowlist entry that packs nothing, or ' +
  'an exports/bin target missing from the tarball fails the publish. If the ruling changes, ' +
  `update the 'files' allowlist in ${manifestPath} and this check together.`

/**
 * True when `path` matches `pattern`, where `**` (as a whole path segment)
 * matches zero or more whole segments and `*` matches zero or more characters
 * within one segment; every other byte is literal. Enough for the negated
 * allowlist entries this workspace rules (the root manifest's
 * `packages/core/src` test-file denial), with no glob dependency: a
 * divergence from the packer's own semantics surfaces as a named-path failure
 * here, never as a silent pass.
 */
export function matchesPackedPattern(path: string, pattern: string): boolean {
  return matchSegments(path.split('/'), pattern.split('/'))
}

function matchSegments(path: readonly string[], pattern: readonly string[]): boolean {
  const [head, ...rest] = pattern
  if (head === undefined) return path.length === 0
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip++) {
      if (matchSegments(path.slice(skip), rest)) return true
    }
    return false
  }
  if (path.length === 0) return false
  return matchSegment(path[0]!, head) && matchSegments(path.slice(1), rest)
}

/** `*` matches any run of characters within one segment; everything else is literal. */
function matchSegment(segment: string, pattern: string): boolean {
  if (!pattern.includes('*')) return segment === pattern
  const source = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${source}$`).test(segment)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A command to run on behalf of the check, with its working directory. */
export interface PackRequest {
  command: string
  args: readonly string[]
  cwd: string
}

export interface PackResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The process seam: injected so tests never spawn a real `bun pm pack`.
 * Same shape as `tools/release.ts`'s `CommandRunner`.
 */
export type PackRunner = (request: PackRequest) => Promise<PackResult>

/** The real runner: `bun pm pack --dry-run` at `cwd`, output captured. */
export const spawnPack: PackRunner = async (request) => {
  try {
    const processHandle = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Paths bun would pack, from `bun pm pack --dry-run` output. Only
 * `packed <size> <path>` lines are listings; the banner (`bun pack v…`), the
 * tgz-name line, and the `Total files:`/`Unpacked size:` trailer carry no
 * paths and are ignored. The path is everything after the first two
 * whitespace-separated tokens, so size spellings (`320B`, `2.1KB`) and
 * bracketed route paths (`app/api/auth/[...all]/route.ts`) parse as-is.
 */
export function parsePackedPaths(listing: string): string[] {
  const paths: string[] = []
  for (const line of listing.split(/\r?\n/)) {
    const match = /^packed (\S+) (.+)$/.exec(line)
    if (match !== null) paths.push(match[2]!)
  }
  return paths
}

/**
 * A packed path is allowed iff it is one of the manifest-mandated always-packed
 * files, or equals an allowed surface / starts with `surface + '/'` (npm's
 * file-or-directory semantics for a `files` entry), and matches no denied
 * pattern. A denied pattern wins over a surface: a negated entry carves a
 * hole out of an allowlisted tree.
 */
export function isAllowedPackedPath(path: string, ruling: TarballRuling): boolean {
  if (ruling.requiredPackedPaths.includes(path)) return true
  if (ruling.deniedPackedPatterns.some((pattern) => matchesPackedPattern(path, pattern))) {
    return false
  }
  return ruling.allowedSurfaces.some(
    (surface) => path === surface || path.startsWith(`${surface}/`),
  )
}

export type PackedContentsViolation =
  | { kind: 'empty-listing' }
  | { kind: 'missing'; path: string }
  | { kind: 'missing-surface'; entry: string }
  | { kind: 'extra'; path: string }
  | { kind: 'no-files-allowlist' }
  | { kind: 'missing-target'; path: string }

/**
 * The pure ruling, for one ruled package: the packed set must be exactly the
 * required manifest-mandated files plus paths the `files` allowlist admits
 * (and nothing else), every allowlist entry must be represented in the
 * listing, and every manifest `exports`/`bin` target must be packed. An empty
 * parsed listing is a violation in itself so an unreadable or format-drifted
 * listing can never pass. The manifest-level `no-files-allowlist` kind is
 * produced by the derivation (it is a fact about the manifest, not the
 * listing); everything else is derivable here.
 */
export function evaluatePackedPaths(
  paths: readonly string[],
  ruling: TarballRuling,
  targets: readonly string[] = [],
): PackedContentsViolation[] {
  if (paths.length === 0) return [{ kind: 'empty-listing' }]
  const violations: PackedContentsViolation[] = []
  for (const required of ruling.requiredPackedPaths) {
    if (!paths.includes(required)) violations.push({ kind: 'missing', path: required })
  }
  for (const surface of ruling.allowedSurfaces) {
    // A surface that is also an always-packed path is already enforced by the
    // required-path check above; its absence must not be reported twice.
    if (ruling.requiredPackedPaths.includes(surface)) continue
    const represented = paths.some((path) => path === surface || path.startsWith(`${surface}/`))
    if (!represented) violations.push({ kind: 'missing-surface', entry: surface })
  }
  for (const path of paths) {
    if (!isAllowedPackedPath(path, ruling)) violations.push({ kind: 'extra', path })
  }
  for (const target of targets) {
    if (!paths.includes(target)) violations.push({ kind: 'missing-target', path: target })
  }
  return violations
}

/**
 * Package-relative paths a manifest promises the tarball carries: every
 * `./`-prefixed string reachable in the `exports` map (a bare string, or a
 * condition object recursed to its string leaves) plus every `bin` value,
 * each stripped of its leading `./`. Subpath patterns or external references
 * are not present in the ruled manifests; if one appears, the target
 * cross-check fails visibly, which is the intended tripwire.
 */
export function packedTargetsFromManifest(manifest: {
  exports?: unknown
  bin?: unknown
}): string[] {
  const targets = new Set<string>()
  const addBin = (value: string): void => {
    targets.add(value.startsWith('./') ? value.slice('./'.length) : value)
  }
  const walkExports = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.add(value.slice('./'.length))
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) walkExports(entry)
    }
  }
  walkExports(manifest.exports)
  if (typeof manifest.bin === 'string') {
    addBin(manifest.bin)
  } else if (typeof manifest.bin === 'object' && manifest.bin !== null) {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string') addBin(value)
    }
  }
  return [...targets]
}

/** The extensionless members of bun pm pack's always-included set: bun packs
 * these names (any extension, so the bare spellings included) regardless of
 * the `files` field, so an allowlist entry naming one can only ever be the
 * file itself, never a ruled directory tree.
 *
 * Per-packer always-included sets (empirically confirmed and per
 * npm-packlist 10.0.4's strict rules and npm's package-json docs §files):
 * - npm (npm-packlist): package.json, README, LICENSE, LICENCE, COPYING — no NOTICE.
 * - bun pm pack: package.json, README, LICENSE, LICENCE — no NOTICE, no COPYING.
 *
 * This check parses `bun pm pack --dry-run` output, so the constant holds
 * bun's set: those are the only extensionless names guaranteed to be files
 * in the listing under inspection. (`package.json` contains a dot and renders
 * bare via describeSurface's dotted-name branch regardless.) Note the
 * defect class this guards: an extensionless allowlist entry whose name is
 * NOT in this set — e.g. NOTICE or COPYING — renders as `NAME/**`, which is
 * correct, since such a name is not guaranteed to be packed as a file. An
 * editor extending the allowlist must not rely on the file form for it. */
const ALWAYS_PACKED_FILE_NAMES: ReadonlySet<string> = new Set(['README', 'LICENSE', 'LICENCE'])

/**
 * Renders an allowlist entry for messages: a last segment containing a dot, or
 * naming one of bun pm pack's always-packed extensionless files, is a file and
 * renders bare (`SPEC.md` → `SPEC.md`, `LICENSE` → `LICENSE`); anything else is
 * treated as a directory (`src` → `src/**`). An extensionless allowlist entry
 * whose name is not in the always-packed set (e.g. `NOTICE` or `COPYING`) is
 * not guaranteed to be packed as a file, so it correctly renders as `NAME/**` —
 * do not rely on the file form for such names. Cosmetic only — enforcement uses
 * the exact-or-prefix predicate, never this guess.
 */
export function describeSurface(entry: string): string {
  const lastSegment = entry.split('/').at(-1) ?? entry
  return lastSegment.includes('.') || ALWAYS_PACKED_FILE_NAMES.has(lastSegment)
    ? entry
    : `${entry}/**`
}

/** The allowed set as the ruling sentence renders it: the always-packed files
 * plus each surface, deduplicated, with `and` before the last item. */
function allowedByRuling(ruling: TarballRuling): string {
  const items = [
    ...ruling.requiredPackedPaths,
    ...ruling.allowedSurfaces
      .filter((surface) => !ruling.requiredPackedPaths.includes(surface))
      .map(describeSurface),
  ]
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function describeViolation(violation: PackedContentsViolation, ruling?: TarballRuling): string {
  switch (violation.kind) {
    case 'empty-listing':
      return (
        'the pack listing contained no `packed <size> <path>` lines, so the tarball contents ' +
        'could not be checked; if bun changed its pack output format, update this parser'
      )
    case 'missing':
      return `${violation.path} is missing from the tarball; the ruling requires it packed`
    case 'missing-surface':
      return (
        ruling?.missingSurfaceMessages?.[violation.entry] ??
        `the 'files' entry ${violation.entry} packs nothing into the tarball; every allowlist ` +
          `entry must be represented (expected ${describeSurface(violation.entry)})`
      )
    case 'extra':
      if (ruling === undefined) return `${violation.path} must not publish`
      return `${violation.path} must not publish; only ${allowedByRuling(ruling)} are allowed by the ruling`
    case 'no-files-allowlist':
      return (
        'the manifest declares no non-empty `files` allowlist; the ruling pins the publishable ' +
        'surface by manifest rather than by directory layout, so the package must declare one ' +
        '(e.g. `"files": ["src", "README.md"]`)'
      )
    case 'missing-target':
      return (
        `${violation.path} is an exports/bin target in the manifest but is missing from the ` +
        'tarball; every manifest target must resolve from the packed artifact'
      )
  }
}

export interface PublishContentsCheckEnvironment {
  /** Absolute path of the repository root. */
  repositoryRoot: string
  pack: PackRunner
  /**
   * Reads every workspace manifest (root included) once; the ruled-set
   * derivation and the per-package checks share this single read. The
   * default is `readWorkspaceManifests`.
   */
  readManifests: (root: string) => Promise<readonly { path: string; text: string }[]>
}

export interface PublishContentsCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const PACK_COMMAND = 'bun'
const PACK_ARGS = ['pm', 'pack', '--ignore-scripts', '--dry-run'] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseManifestObject(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: invalid package manifest: ${detail}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: invalid package manifest: must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * The derivation outcome for one publishable package, in publish order: a
 * derived ruling for a package whose manifest declares a usable `files`
 * allowlist, or a `no-files-allowlist` marker for one that does not (reported
 * as a violation with no listing evaluation, since no ruling can be derived
 * from it — still a failure).
 */
export type DerivedPublishablePackage =
  | { kind: 'ruled'; ruling: TarballRuling; manifest: Record<string, unknown> }
  | { kind: 'no-files-allowlist'; name: string; directory: string; ruling: string }

/**
 * A parsed `files` allowlist: positive entries become allowed surfaces and
 * negation entries (`!`-prefixed) become denied glob patterns. Entries are
 * normalized the way npm reads them: a leading `./` and trailing slashes are
 * stripped, so `./src/` rules the same surface as `src`.
 */
export interface ParsedFilesAllowlist {
  readonly surfaces: readonly string[]
  readonly deniedPatterns: readonly string[]
}

export function parseFilesAllowlist(
  files: readonly unknown[],
  label: string,
): ParsedFilesAllowlist {
  const surfaces: string[] = []
  const deniedPatterns: string[] = []
  for (const entry of files) {
    if (typeof entry !== 'string') {
      throw new Error(`${label}: every 'files' entry must be a string, found ${typeof entry}`)
    }
    if (entry.startsWith('!')) deniedPatterns.push(normalizeAllowlistEntry(entry.slice(1)))
    else surfaces.push(normalizeAllowlistEntry(entry))
  }
  return { surfaces, deniedPatterns }
}

/** A leading `./` and trailing slashes never change what a `files` entry rules. */
function normalizeAllowlistEntry(entry: string): string {
  return entry.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Derives the ruled table mechanically: the ruled set is release's own
 * publish set (`publishablePackages` — every non-private workspace manifest,
 * root included, in publish order), and each ruling is that package's
 * declared `files` allowlist, so the table cannot drift from the manifests
 * and a newly publishable package is guarded automatically. A `files` entry
 * that is not a string throws — a hard failure the runner reports (an
 * allowlist it cannot parse must not quietly become a narrower ruling). A
 * manifest with no usable `files` array yields a `no-files-allowlist` marker
 * instead of a ruling; the runner reports it as a violation with no listing
 * evaluation, since no ruling can be derived.
 */
export function deriveRuledPackages(
  manifests: readonly { path: string; text: string }[],
): readonly DerivedPublishablePackage[] {
  const parsed = manifests.map((entry) => ({
    path: entry.path,
    text: entry.text,
    manifest: parseManifestObject(entry.text, entry.path),
  }))
  const manifestByPath = new Map(parsed.map((entry) => [entry.path, entry.manifest]))
  return publishablePackages(parsed).map((pkg) => {
    const manifest = manifestByPath.get(pkg.manifestPath)
    if (manifest === undefined) {
      throw new Error(`${pkg.manifestPath} vanished from the workspace manifests mid-check`)
    }
    const pinned = PINNED_RULING_PROSE[pkg.name]
    const rulingText = pinned?.ruling ?? genericRulingProse(pkg.name, pkg.manifestPath)
    const files = manifest.files
    if (!Array.isArray(files) || files.length === 0) {
      return {
        kind: 'no-files-allowlist' as const,
        name: pkg.name,
        directory: pkg.directory,
        ruling: rulingText,
      }
    }
    const allowlist = parseFilesAllowlist(files, pkg.manifestPath)
    return {
      kind: 'ruled' as const,
      manifest,
      ruling: {
        name: pkg.name,
        directory: pkg.directory,
        requiredPackedPaths: ['package.json', 'README.md'],
        allowedSurfaces: allowlist.surfaces,
        deniedPackedPatterns: allowlist.deniedPatterns,
        ruling: rulingText,
        ...(pinned?.missingSurfaceMessages === undefined
          ? {}
          : { missingSurfaceMessages: pinned.missingSurfaceMessages }),
      },
    }
  })
}

/**
 * The ruling shape the store packages declared before the table widened:
 * exactly the `src` surface plus always-packed `README.md`, no denials. Such
 * rulings keep the legacy success line, whose count is over `src/` files.
 */
function isLegacySrcRuling(ruling: TarballRuling): boolean {
  return (
    ruling.deniedPackedPatterns.length === 0 &&
    ruling.allowedSurfaces.length === 2 &&
    ruling.allowedSurfaces.includes('src') &&
    ruling.allowedSurfaces.includes('README.md')
  )
}

function successLine(ruling: TarballRuling, paths: readonly string[]): string {
  if (isLegacySrcRuling(ruling)) {
    const srcCount = paths.filter((path) => path.startsWith('src/')).length
    return (
      `${ruling.name} pack contents match the ruling: package.json, README.md, ` +
      `and ${srcCount} src/ file(s).`
    )
  }
  const allowlistedCount = paths.length - ruling.requiredPackedPaths.length
  return (
    `${ruling.name} pack contents match the ruling: package.json, README.md, ` +
    `and ${allowlistedCount} allowlisted file(s).`
  )
}

function reportPackageViolations(
  name: string,
  rulingText: string,
  violations: readonly PackedContentsViolation[],
  ruling: TarballRuling | undefined,
  output: PublishContentsCheckOutput,
): void {
  output.stdout(`${rulingText}\n`)
  for (const violation of violations) {
    output.stdout(`${describeViolation(violation, ruling)}\n`)
  }
  output.stderr(
    `${violations.length} packed-contents violation(s) against the ${name} tarball ruling; see the messages above.\n`,
  )
}

/**
 * Checks one ruled package end to end. Never throws and never short-circuits
 * the caller's loop: every failure mode — a thrown runner, a failing pack, a
 * content mismatch — reports nonzero, and the caller keeps checking the
 * remaining rulings.
 */
async function checkRuledPackage(
  ruling: TarballRuling,
  manifest: Record<string, unknown>,
  env: PublishContentsCheckEnvironment,
  output: PublishContentsCheckOutput,
): Promise<boolean> {
  const packageDirectory = join(env.repositoryRoot, ruling.directory)

  let result: PackResult
  try {
    result = await env.pack({
      command: PACK_COMMAND,
      args: PACK_ARGS,
      cwd: packageDirectory,
    })
  } catch (error) {
    output.stderr(`Could not check the ${ruling.name} pack contents: ${errorMessage(error)}\n`)
    return false
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
    output.stderr(
      `${PACK_COMMAND} ${PACK_ARGS.join(' ')} failed in ${packageDirectory}: ${detail}\n`,
    )
    return false
  }

  const paths = parsePackedPaths(result.stdout)
  const violations = evaluatePackedPaths(paths, ruling, packedTargetsFromManifest(manifest))
  if (violations.length === 0) {
    output.stdout(`${successLine(ruling, paths)}\n`)
    return true
  }
  reportPackageViolations(ruling.name, ruling.ruling, violations, ruling, output)
  return false
}

/**
 * Derives the ruled table from the release's own publish set and packs every
 * publishable package dry-run, asserting its ruling. Every failure mode — a
 * thrown enumeration, a failing pack, a missing allowlist, a content
 * mismatch — reports nonzero; the check never reports success on ambiguity,
 * and one failing package never hides another's violations.
 */
export async function runPublishContentsCheck(
  env: PublishContentsCheckEnvironment,
  output: PublishContentsCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let derived: readonly DerivedPublishablePackage[]
  try {
    derived = deriveRuledPackages(await env.readManifests(env.repositoryRoot))
  } catch (error) {
    // A check that cannot enumerate the publishable set must never report
    // success: fail closed, naming the enumeration error.
    output.stderr(
      `Could not check the publishable packages' pack contents: ${errorMessage(error)}\n`,
    )
    return 1
  }

  let failed = false
  for (const entry of derived) {
    if (entry.kind === 'no-files-allowlist') {
      reportPackageViolations(
        entry.name,
        entry.ruling,
        [{ kind: 'no-files-allowlist' }],
        undefined,
        output,
      )
      failed = true
      continue
    }
    const passed = await checkRuledPackage(entry.ruling, entry.manifest, env, output)
    if (!passed) failed = true
  }
  return failed ? 1 : 0
}

export const realEnvironment: PublishContentsCheckEnvironment = {
  repositoryRoot: repoRoot,
  pack: spawnPack,
  readManifests: (root) => readWorkspaceManifests(root),
}

if (import.meta.main) {
  process.exitCode = await runPublishContentsCheck(realEnvironment)
}

# Experiment verification

From the repository root, provision dependencies with
`bun install --frozen-lockfile --cwd experiments/proa-server` and run:

```
bun experiments/proa-server/tools/verify.ts
bun experiments/proa-server/tools/capture.ts
bun test experiments/proa-server/tools
```

Prerequisites are the experiment README's pinned Rust 1.99.1 and Proa 0.1.3,
Bun, Linux flock, and local Chromium (`CHROMIUM_BIN`, default /usr/bin/chromium).
Capture uses offline dependency resolution; provision Cargo dependencies with the
Rust gate first. The full Rust gate also needs an installed local PostgreSQL
cluster (on Debian: provision with the repository's `scripts/postgres-live.sh install`
as a maintainer). With `AB_POSTGRES_TEST_URL` unset, the gate invokes
`scripts/postgres-live.sh ensure-running` and explicitly uses
`postgres://postgres:postgres@127.0.0.1:5432/postgres`. A nonblank override must name a
loopback administrative connection; it bypasses the helper, and invalid connections
fail without fallback. The gate never installs, stops or resets PostgreSQL.

The locked private `s3rver` 3.7.1 dependency supplies a real local HTTP S3 subset,
binding loopback port zero in a unique temporary directory. Startup probes signed
upload/download through the actual TypeScript AWS client. Production blob settings
are removed, and exact test endpoint/credentials are passed explicitly to both clients.
The TypeScript producer creates a uniquely named database/SELECT-only role, writes
all three event and artifact scopes through the actual store, and invokes the native
Rust reader. Cleanup closes clients and removes only that run's database, role,
server and directory, including failure paths. Startup/teardown are bounded.
No forge or live sandbox runner is needed. Capture alone remains offline and does
not provision either service.
The proa-rust gate runs `bun test tools` from the experiment directory before
Rust checks, so negative capture fixtures, route coverage and pipeline regressions
are enforced for every applicable build. Capture-build mode only exports the
server; it does not recursively run the tooling tests.
The real server serves the worktree's local assets. Do not run against a .env
containing production settings.

Cargo targets, including Proa linked descriptor/final compilation, share a cache
below XDG_CACHE_HOME (default ~/.cache), keyed by canonical Git common directory,
experiment, Rust and Proa versions. PROA_VERIFY_CACHE may explicitly override it
with an absolute path outside every worktree. flock serializes the entire gate;
the OS releases the lock on process exit, including crashes. Each build exports
its own executable under ignored root .ab/proa-build-* before releasing the lock.
Never capture a mutable executable directly from the shared cache.

Accepted cache limitation: pinned Proa 0.1.3 hashes the absolute package path
into its linked descriptor/final namespaces. Ordinary Cargo artifacts reuse
across worktrees; linked dependencies currently rebuild in a new worktree.
Same-worktree reuse works. See FIELD-NOTES.md for the two-worktree measurements;
operator guidance accepts this partial reuse for the cross-build cache criterion.
Revisit linked reuse when upgrading Proa; keep linked builds and the pinned
toolchain enabled.

Capture evidence is under the printed .ab/proa-frames-* directory, including
inventory.json, verify-report.md and sixteen PNGs. Each run owns two server ports (admitted and refused identities),
Chromium profile and exported executable. Process cleanup runs in finally and
termination handlers. Old evidence/build logs can be deleted when no longer needed.
The agent must inspect every PNG; deterministic probes are necessary, not a
substitute for visual judgment. Route declarations are classified independently
of cases in capture-cases.ts; new/unsupported declarations fail closed. Extend
cases with every HTML route/state, 1440/390 widths and light/dark grounds. Supply
explicit seeded identifiers for parameterized routes, never guessed ids.

Data contract: the native configured reader and the deliberately unconfigured shell
are distinct modes. Proa's generated database layer remains `database.driver=none`;
the native reader is initialized separately before binding. Current pages read no
data, so capture starts in an isolated cwd with no inherited database/blob credentials
and renders the unchanged shell. Source inventory rejects page-level data reads until a seeded data capture
contract is supplied; auth uses the development issuer described below. The full gate's data proof is separate
from pixel capture and never invents browser records.

Corpus generation: `bun tools/generate-fixtures.ts` from the experiment executes
scenario/compatibility producers, captures per-store logs and validates every event
catalog witness. Verification runs `bun tools/check-fixtures.ts` before Cargo tests;
it recomputes TypeScript answers and checks source hashes without regenerating goldens.
`fixtures/corpus.json.gz` stores lossless JSON cases; the readable manifest inventories
producers and source hashes. Identical scope/log cases retain all provenance aliases.
Staging is under ignored workspace `.ab/`; replacement restores the old corpus if
publication fails, and failed runs retain diagnostic inputs.
`tests/reducer_parity.rs` compares native replay and chunked advancement field by field.
`tools/data-integration.ts` proves TS-write/Rust-read PostgreSQL/blob interoperability,
read-only tables, incremental suffix counts, restart and failure isolation.

Auth contract: capture requires the supported Rust development issuer and fails
closed if its capability contract is absent. It launches isolated loopback servers
from a clean temporary cwd with explicit development settings, random session
secrets and a fresh issuance capability. The admitted identity is
operator@example.com; the second server's configured refused@example.com is absent
from its allowlist. No live GitHub calls or browser-signed cookie stubs are used.
The exact server-issued cookie is installed into Chromium; each frame starts with
cleared cookies. Refusal is a real POST navigation to the denied issuer, with only
that route's expected 403 excluded from asset-error detection.

The matrix covers initial public sign-in, actual refusal, signed-in Builds and
open account menu at 1440/390 in both grounds. Content/readiness probes understand
public versus authenticated pages and assert identity, sign-out and alert content.
Palette, rendered fonts, overflow, external requests, HTTP asset failures and
browser exceptions remain enforced. After capture a real sign-out form submission
must revoke the copied cookie. Rust tests cover config, return paths, state/PKCE,
callback replay, allowlist removal, cookie/session policy, CSRF, peer checks and
the GitHub adapter's wire shapes/pagination. A real TCP test proves the development
serve adapter supplies ConnectInfo. The gate retains Proa accessibility/performance
checks and linked builds.

### Remote store protocol foundation

`protocol-cases.ts` inventories the machine BuildStore routes, including
current-client additions and the excluded ticket-source/connect/MCP surfaces.
This is a checklist, not proof of Rust conformance. Future HTTP runners must
register assertions for each method/path and call `assertProtocolCoverage`;
an empty or partial registry fails.

`bun tools/protocol-database-proof.ts` runs the initial storage isolation proof:
it provisions two independently named databases with the TypeScript migrations,
checks that each is empty, and tears both down. It reuses the loopback-only
PostgreSQL and isolated S3 lifecycle from `data-services.ts`. Set
`AB_POSTGRES_TEST_URL` only to a loopback administrative database, or leave it
unset to use the existing local development PostgreSQL helper. No credentials
or persistent test state are written to the repository. The proof does not
start Rust or claim the shared HTTP contract suite; those remain outstanding.

`withProtocolDatabase` supplies only an isolated environment to its callback,
never a TypeScript backing store. A future remote-client factory must stop its
Rust server and connections inside that callback before database teardown.

### Native machine-protocol checkpoints

The protocol implementation is still staged. `src/protocol/router.rs` is a
separate JSON branch exercised by the native test executable; it is not yet
mounted into the normal browser server. Unsupported families do not count as
conformance. Delegation, ticket assets, streams and reducer values
remain outstanding; the complete shared suite and production router merge are
still required. Build/repository/session appends, atomic initial events, public
snapshots, operator presence, artifact/deposit families and repository ticks now
run through the native test server.

Generate the independent strict append corpus with
`bun tools/generate-protocol-fixtures.ts`; verify it with
`bun tools/check-protocol-fixtures.ts`. The generator consults the core write
validators and actual TypeScript HTTP handler separately. It records source
hashes, normalized accepted writes and exact refusal messages in the deterministic
compressed corpus. It is distinct from the permissive persisted-log fixtures.
`protocol-payload-schemas.json` covers every current producer payload schema.
The closed Rust interpreter handles primitive checks, unions, transforms and
named refinements; generation rejects unknown constructs. Full write preparation
also enforces actor/catalog authority and stamps compatibility metadata. The
actor/type prefix alone is never a complete validator.

`bun tools/protocol-write-preparation-fixtures.ts` verifies producer policy,
metadata and initial-event/sequence oracles (`--generate` refreshes them).
`bun tools/protocol-event-reads.ts` checks the repository bounded-read policy
(`--write` refreshes it). The gate runs both before Rust tests.

Identity inputs and exact refusal oracles come from
`bun tools/protocol-identity-generate.ts`, checked by
`bun tools/protocol-identity-check.ts`. This tracks the actual release window,
protocol history and catalog identity rather than illustrative protocol versions.

Run `bun tools/protocol-integration.ts` for the native checkpoint proofs. It
uses the configured external Cargo cache and acquires its `.verify.lock` once.
Inside the maintained gate, use `--caller-holds-lock` to avoid nested acquisition.
The gate runs this command, identity freshness and append freshness automatically.
The example binary binds an ephemeral loopback port; its private stdin/stdout
channel synchronizes each request's clock without freezing monotonic waits.
Open machine authority and clock control exist only in the test example, never
as switches in the normal executable. The test harness forwards the shared
constructor retention option; newest-revision pruning runs inside the locked
deposit transaction, and session artifacts remain exempt.

The proofs cover project credentials in both language directions (including
actual TypeScript credential CLI issuance), immediate invalidation, authenticated
HTTP ownership gates, all three strict event catalogs, atomic build creation,
records, leases, node writers, snapshot caches, operator presence, all three
artifact scopes and atomic deposits, fenced repository tick telemetry, cross-language
sequence/CAS races, SQL/commit rollback, held-read wake/timeout/cancellation, and
restart continuity. Public snapshot state uses the TypeScript adapter's shared
JSONB string envelope, including scalar strings and legacy object reads. Raw tokens remain only in test process memory and private
pipes. Sanitized evidence is written to `.ab/proa-protocol-store/checkpoint-proof.json`.
This report explicitly states `fullBuildStoreContract: false`: the unchanged
full shared suite, historical-client fixtures and dispatch proof are still required.

Artifact preparation oracles are checked with
`bun tools/protocol-artifact-preparation-fixtures.ts` (`--generate` refreshes);
`bun tools/protocol-tick-fixtures.ts` checks core tick boundaries;
`bun tools/protocol-blob-fixtures.ts` captures the pinned provider SDK request
contract (`--generate` refreshes each). The maintained gate checks all three.
Native artifact proofs cover the exact 1 MiB decoded ceiling, canonical padded
base64, payload-only placeholder substitution, same-kind batches, stale deposits,
retention and SQL insert/commit rollback. Invalid deposit tests use raw HTTP so
the unchanged remote client's local producer validator cannot mask Rust failures.
The private `protocol-blob-proof` example cross-reads whole S3 objects with the
TypeScript adapter. Vercel request tests are local SDK/request evidence, not a
claim of live Vercel access. See [BLOB-CONTRACT.md](../BLOB-CONTRACT.md).

A remaining request-boundary conformance gap is confirmed for raw JSON numeric
literals. The current serde parser can preserve unsafe integers or round decimal
lexemes differently from JavaScript, and rejects exponent overflow that
JavaScript accepts before later schema validation/serialization. A complete
request numeric model is still required before conformance is claimed. Probe
regressions must send raw literal text and inspect persisted JSON as well as
responses: parsing both responses through JavaScript can hide the divergence.

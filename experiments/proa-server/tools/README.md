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
The TypeScript producer creates a uniquely named database and separate SELECT-only reader and mutation roles, writes
all three event and artifact scopes through the actual store, and invokes the native
Rust reader. Cleanup closes clients and removes only that run's database, role,
server and directory, including failure paths. Startup/teardown are bounded.
No forge or live sandbox runner is needed. Seeded capture provisions both services
in isolated loopback resources. Rust reader transactions retain their SELECT-only role; browser writes use `PROA_POSTGRES_WRITE_URL` with a separately granted writer role.
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
inventory.json, verify-report.md and twenty-four PNGs. Each run owns two server ports (admitted and refused identities),
Chromium profile and exported executable. Process cleanup runs in finally and
termination handlers. Old evidence/build logs can be deleted when no longer needed.
The agent must inspect every PNG; deterministic probes are necessary, not a
substitute for visual judgment. Route declarations are classified independently
of cases in capture-cases.ts; new/unsupported declarations fail closed. Extend
cases with every HTML route/state, 1440/390 widths and light/dark grounds. Supply
explicit seeded identifiers for parameterized routes, never guessed ids.

Data contract: the native configured reader and the deliberately unconfigured shell
are distinct modes. Proa's generated database driver remains `none`: the native
read-only adapter owns the SQL reads. `capture-seed.ts` imports both real root
scenario producers and replays records, ordered events and exact artifact revisions
into dedicated isolated projects before starting Rust. It adds nested nodes,
root leaves, an unreadable neighbor, stored detail/frame and closed/live transcript
cases. The printed inventory binds every frame to a project, build and producer,
with source hashes, timestamp shifts, replay counts and artifact inventories.
`sql-evidence.json` records actual native suffix reads and immutable downloads.
Capture checks no-JS DOM snapshots, same-document event refresh within five seconds,
live transcript suffixes and retained disclosures. Server and browser processes,
databases, reader/writer roles and S3 directories are cleaned on failure too.

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
that route's expected 403 and the tested `/controls` stale-answer 409 excluded from asset-error detection.

The 40-frame matrix covers initial public sign-in, actual refusal, signed-in Builds,
open account menu, detail, guidance, pending pause, destructive confirmation and
stale-answer refusal at 1440/390 in both grounds. Content/readiness probes understand
public versus authenticated pages and assert identity, sign-out and alert content.
Palette, rendered fonts, overflow, external requests, HTTP asset failures and
browser exceptions remain enforced. After capture a real sign-out form submission
must revoke the copied cookie. Rust tests cover config, return paths, state/PKCE,
callback replay, allowlist removal, cookie/session policy, CSRF, peer checks and
the GitHub adapter's wire shapes/pagination. A real TCP test proves the development
serve adapter supplies ConnectInfo. The gate retains Proa accessibility/performance
checks and linked builds.

The display projection has a separate offline oracle under
`fixtures/projection.json.gz`. Regenerate it explicitly with
`bun tools/projection-fixtures.ts --write`; check freshness without writing with
`bun tools/projection-fixtures.ts`. It imports the TypeScript projection only
at generation/check time. The native `projection_parity` test compares retained
facts, projected rows, session stream metadata and Unicode cells. The full Rust gate also runs `data-dashboard-integration.ts`, which checks the
real producer replay against native project/detail, stream and blob reads.

The dashboard integration proof also creates 509 hidden completed builds and
5,090 closed streams through the TS store. After warming, three idle polls must
make no per-history-build reads, no repeated pinned-config reads, and no closed
stream metadata transfers. It checks new-build discovery, terminal ancestors and
a new live event under five seconds. `metadata:*` entries in SQL evidence report
registry, discovery, stream and artifact metadata queries as well as returned row
counts; these are separate from event suffixes and blob byte downloads.

## Operator contract proofs

`bun tools/operator-fixtures.ts` checks the source-pinned session/validation
subcorpus, identity rules and documentation. Its historical `coverage.missing*`
fields describe only that foundation corpus. The aggregate completion authority
is `tools/operator-coverage.ts`, which combines all oracle and executable helper
manifests. Generators check by default; `--write` regenerates deliberately.
`tools/writer-fixtures.ts` checks the actor/classification catalog.

`bun tools/operator-integration.ts` provisions isolated PostgreSQL/S3 resources,
replays the actual Rust HTTP adapters and reads their bytes through the actual
TypeScript stores, validators and reducers. A private test bridge seeds and probes
storage foundations; it is never a production endpoint or request proxy. The
combined replay includes the direct hosted-ticket HTTP/storage proof. Reader and
writer roles are separate; narrowly granted retention/blocker deletes and
credential-last-use updates are exercised explicitly.

The command writes `.ab/proa-operator-evidence/results.json` and `coverage.json`.
It checks native/proof and TypeScript source hashes, every required executed case,
and zero missing routes/actions/answers/tools before reporting `httpParity: true`.
Recheck the runtime evidence with:

```sh
bun tools/operator-coverage.ts --evidence ../../.ab/proa-operator-evidence/coverage.json
```

Validation, auth and unknown-resource-only refusals cannot qualify an operation;
inventories and stale or skipped suites fail completion. Standalone helpers remain
available for diagnosis. `bun tools/dispatcher-integration.ts` additionally proves
native browser pause/resume changes actual core Dispatcher/BuildRunner scheduling
and real terminal frames, using only disposable databases, Git workspaces and
processes. [The interoperability ledger](../OPERATOR-PARITY.md) explains the
attribution exception and boundaries.

## Delegated credential HTTP proof

`bun tools/delegation-integration.ts` provisions an isolated PostgreSQL/S3 store,
starts the real native operator/delegation router, and compares its issuance
responses with the TypeScript remote-store handler and machine authenticator
against the same durable rows. It checks exact token and HMAC bytes, error bodies,
media types, version/auth/body precedence, all principal classes, non-widening
runner-to-phase grants, project removal, credential revocation and expiry,
execution/session binding, suspension, replaced authorization and the exact
terminal-grace boundary. Every Rust-issued token is decoded by TypeScript and
refused operator authority. A second test-owned server proves the unconfigured
issuance response. Issuance must leave build and repository event streams intact.

## Operator API read proof

`bun tools/api-read-fixtures.ts` checks the complete TypeScript-derived read
response corpus and its source hashes; `--write` regenerates it deliberately.
The cases cover build detail and nullable dashboard rows, the dashboard envelope,
repository status, and harvest status. They retain exact refusal text, pinned
pipeline metadata, runner runtime provenance, current verification cycles,
CLEANING rows, dispatcher lease/tick correlations, handoffs, degradation,
descendant-held capacity, durable settings, and harvest recovery/suspension.

`bun tools/api-read-integration.ts` independently proves that the manifest's
records, ordered facts and artifact bytes reproduce each response through the
TypeScript PostgreSQL/S3 adapter. The main `operator-integration.ts` gate replays
those same seeds through the actual native HTTP routes, compares entire bodies
and response content types, and checks that reads neither create repository
records nor change durable facts or lifecycle metadata. Only explicit test-owned
resource/slug bindings change between corpus cases and the isolated database.

## Native hosted ticket proof

`bun tools/ticket-integration.ts` uses isolated PostgreSQL/S3 and a least-privilege
writer role to compare native ticket operations with the unchanged TypeScript
adapter and `updateTicketTarget` policy. It checks body bytes, node/target graph
rules, state discovery and creation, exact refusals, guarded revisions, per-id
unguarded blocker commits, concurrent writers, restart reads and published policy
without a dispatcher configuration artifact. The retarget cases validate actual
Rust-produced `node.parent-requested` payloads through the core event validator,
compare them with TypeScript, and cover held writer leases, pending operations
and pending parent cycles.

The `ticket-proof` example is test-only. Its `--http` mode serves the actual Rust
operator router over an ephemeral loopback port. The proof issues a project
credential, creates and patches a ticket over HTTP, reads the stored result
through TypeScript, and checks strict unknown-field rejection, stale revisions
and revocation on the next request. This proves those routes; it does not claim
exhaustive operator HTTP parity. The gate prints machine-readable claims and
cleans up only its own database, role and processes.

## Browser mutation proof

The capture seeds independent control builds for each script mode. Chromium clicks
the rendered pause, cancel-pause, resume, abort, discard, guidance, retry and dismiss
forms with JavaScript enabled and disabled. The proof reads the resulting facts
through the TypeScript store, checks the admitted identity, confirms destructive
first steps write nothing and checks enhanced submissions retain the document.
`browser-control-proof.json` records the actions and exact event kinds. The same
run rejects wrong CSRF, foreign Origin and cross-project forms without writes.

`browser-extended-proof.json` covers another 18 submissions: intake, bulk pause
and resume, harvest enablement, harvest run resume and acknowledgment, review
ceiling, supplied specification revision and ticket specification revision, each
with JavaScript enabled and disabled. Isolated projects retain the real published
ticket policy and artifact store. Assertions compare ordered, validator-accepted
facts and source-derived actors, including kernel revision facts, exact spec
bytes and repinned asset metadata. Together the two proofs exercise 34 mutations.

Browser forms carry only the cookie session's CSRF token, project and slug. They
share the native operator policies and strict answer schema; supplied identity
fields never grant authority. Ordinary successful POSTs redirect with 303. Enhanced
POSTs request server-rendered HTML with `X-Proa-Fragment: 1`; a typed refusal is
escaped inline with the draft retained. Polls preserve drafts, errors and pending
confirmations, and responses from older polls cannot replace a mutation result.
Merge consent remains API-only.

`bun tools/config-fixtures.ts` checks the source-derived native configuration
grammar and the separate test-only differential corpus. Regenerate deliberately
with `--write`. The native decoder checks strict fields, defaults, open maps,
named-step transforms, URL normalization and cross-field policy; the corpus
compares normalized values and exact Zod issue bytes for whole configurations
and every schema node. Only the small grammar is loaded at runtime. Malformed
effective-config bytes retain the operator API's typed 409 conflict and label.
### Remote store protocol foundation

`protocol-cases.ts` inventories the machine BuildStore routes, including
current-client additions and the excluded ticket-source/connect/MCP surfaces.
This is a checklist, not proof of Rust conformance. The maintained HTTP aggregate
records successful native responses by method/path, completes each family's
assertions, then calls `assertProtocolCoverage`; an empty or partial registry
fails. Sanitized response counts appear beside the family evidence.

`bun tools/protocol-database-proof.ts` runs the initial storage isolation proof:
it provisions two independently named databases with the TypeScript migrations,
checks that each is empty, and tears both down. It reuses the loopback-only
PostgreSQL and isolated S3 lifecycle from `data-services.ts`. Set
`AB_POSTGRES_TEST_URL` only to a loopback administrative database, or leave it
unset to use the existing local development PostgreSQL helper. No credentials
or persistent test state are written to the repository. The proof does not
start Rust or claim the shared HTTP contract suite; the maintained native proof
below provides that separate evidence.

`withProtocolDatabase` supplies only an isolated environment to its callback,
never a TypeScript backing store. Remote-client factories stop their Rust
servers and connections inside that callback before database teardown.

### Native machine-protocol checkpoints

`src/protocol/router.rs` is the JSON branch mounted into the normal server before
browser middleware. The private native example adds only test clock, authority
and constructor controls. The maintained aggregate exercises project/delegated
authority, all event and storage families, ticket assets/pins, stream lifecycles,
all 42 exposed named values, historical decoders and isolated dispatch. The
separate contract command runs the entire unchanged shared suite. None of these
reports replace the separate unchanged shared contract result. Legacy JSONB
read envelopes are covered by the persisted-value proofs below.

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
deposit transaction, and session artifacts remain exempt. Production also reads
`AB_ARTIFACT_RETENTION_MAX_REVISIONS`; the aggregate’s retention environment proof
checks mixed Rust/TypeScript writers with limits 2 and 500.

The proofs cover project credentials in both language directions (including
actual TypeScript credential CLI issuance), immediate invalidation, authenticated
HTTP ownership gates, all three strict event catalogs, atomic build creation,
records, leases, node writers, snapshot caches, operator presence, all three
artifact scopes and atomic deposits, fenced repository tick telemetry, cross-language
sequence/CAS races, SQL/commit rollback, held-read wake/timeout/cancellation, and
restart continuity. Public snapshot state uses the TypeScript adapter's shared
JSONB string envelope, including scalar strings and legacy object reads. Raw tokens remain only in test process memory and private
pipes. Sanitized evidence is written to `.ab/proa-protocol-store/checkpoint-proof.json`.
This family report states `includesFullBuildStoreContract: false` and points to
the separate `.ab/proa-protocol-contract/report.json`, which records the complete
unchanged suite and factory counts. Historical-client and dispatch proofs remain
separate requirements.

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

Raw JSON numbers are parsed through `protocol/js_json.rs` with JavaScript's
IEEE-754 rounding and ECMAScript shortest formatting (`ryu-js`). Overflow remains
a number during typed schema validation, then accepted unknown values serialize
to null. Literal serde private-marker keys stay ordinary object properties.
PostgreSQL JSON/JSONB decoding uses the same safe wrapper, and replies normalize
expanded database numbers. `bun tools/protocol-json-number-fixtures.ts` and
`bun tools/protocol-numeric-fixtures.ts` check parser/stringification and Zod
number oracles (`--generate` refreshes each). The aggregate includes 204 raw HTTP
comparisons with exact response-number tokens and SQL JSON text; comparing only
`response.json()` would hide unsafe-integer differences.

Ticket assets use the core path/label/layout limits and PostgreSQL's identical
advisory lock for each repository/ticket/kind/name. Writes can precede a journal;
revision tombstones preserve historical bytes and build pins. Snapshot pins
verify gzip manifest identity, paths, digests and file sizes, including chunked
content and concatenated gzip members. The optional hosted-ticket extension is
discovered without assuming its tables exist. Deployment request/response caps
are test-constructor input (`PROA_TEST_ASSET_MAX_BYTES` only in the private
example), with advertised effective limits and mutation-free response preflight.
`bun tools/protocol-asset-fixtures.ts` checks the core structural/snapshot oracle.

Streams persist parts as the TypeScript JSONB string envelope, validate the
serialized UTF-8 batch ceiling and defer protocol semantics until close. Scope
rows serialize creation/pruning; stream rows serialize chunks and close. Close
uploads before its transaction, then verifies the locked chunk prefix and
reassembles if an acknowledged append raced preparation. Metadata and closed
state publish atomically. Held reads use monotonic deadlines, release their pool
slot between one-second database polls, and terminate when the HTTP future is
cancelled. `bun tools/protocol-stream-document-fixtures.ts` checks the pinned SDK
classifier, assembler and exact artifact byte oracles, including lossless UTF-16
partial tool JSON. The production assembler retains JsJson values and UTF16 strings through artifact
encoding. The previous scalar/fragment implementation remains a compatibility
oracle, not the active machine close path.

`bun tools/protocol-reducer-fixtures.ts` checks catalog/scope/arguments and native
value replay. Named values use one read-only repeatable-read prefix and replay
from authoritative events; poisoned public/private checkpoints cannot change an
answer. The digest endpoint also works for a repository with builds but no
journal and advertises catalog identity.

`bun tools/protocol-contract.ts` compiles the native example once and runs the
**unchanged** core `describeBuildStoreContract` through RemoteBuildStore. Each
factory receives its clock/retention constructor options and independent
PostgreSQL database/blob prefix. The explicitly invoked test process sets
`PROA_RUN_FULL_CONTRACT=1`; ordinary unit imports perform no database work.
The runner fails on any failed/skipped test, missing summary or leaked factory,
and writes logs/counts to `.ab/proa-protocol-contract/`. No methods are replaced
by direct SQL/backing-store calls and no test family is filtered.

Signed execution grants have separate crypto, lifecycle and real HTTP proofs.
`bun tools/protocol-token-fixtures.ts`,
`bun tools/protocol-delegation-fixtures.ts` and
`bun tools/protocol-delegation-authority-fixtures.ts` check their generated
oracles. They cover original-payload HMAC verification, token-specific base64url
semantics, current registration and lifecycle authority, all four grant kinds,
attenuation, immutable stream labels, source error precedence and duplicate
Latin1 header semantics. The aggregate invokes native issuance and authority
proofs; fixture keys and all service/database instances are isolated.

`tools/protocol-compatibility.integration.test.ts` exercises populated response
families using frozen historical decoder shapes for every identity admitted by
the current major/minor release window, and exact negotiation refusals outside
it. Successful mutations run once against the shared database, with independent
response validation and TypeScript read witnesses.

The dispatch proof in `tools/protocol-dispatch.integration.test.ts` uses real
Dispatcher/BuildRunner composition, workspace Git operations and finite scripted
runners in isolation. Its production Rust reader evidence identifies the exact
generated slug, listing, reduced terminal state and ordered durable history,
including a fresh reader. Rendering that dispatched result on the sibling Builds
page is deferred to node integration after file-131 by ruling esc_6370a20b.
The existing 24-frame captures prove browser coexistence only.

`bun tools/protocol-utf16-diagnostic.ts` retains the original investigation entry
but now asserts native/source equality and writes
`.ab/proa-protocol-utf16/conformance.json`. The aggregate runs those same checks
plus separate Unicode write, artifact, asset, reducer and stream proofs. New
freshness commands are `protocol-unicode-fixtures.ts`,
`protocol-token-unicode-fixtures.ts`, `protocol-unicode-validation-fixtures.ts`,
`protocol-reducer-unicode-fixtures.ts` and `protocol-lease-dates-fixtures.ts`, all
under `tools/`. UTF16 fingerprints retain exact units without relying on a text
formatter to preserve surrogate escapes. Deep JSON regressions require successful
asserted native/source responses through 8192 nested unused arrays.

`bun tools/protocol-read-envelope-diagnostic.ts` compares legacy JSONB
string envelopes against the actual TypeScript service: all three event journals,
artifact metadata, build tickets and lists, optional-column truthiness, one-layer
parsing, exact malformed-inner-JSON errors, all 42 named values and delegated
phase issuance/authorization. Its sanitized evidence is
`.ab/proa-protocol-read-envelopes/read-envelopes.json`.
`protocol-read-envelope-diagnostic.ts` remains an equality-proof CLI alias.

Persisted reducers now retain original UTF16 code units through permissive payload
projection, compound readers, reducer dictionaries and lifecycle facts. They do
not route stored facts through strict producer validation or a scalar fallback.
The independent source oracles cover 4,195 persisted payloads, 25,814 replay cases
across all 42 names, and 1,342 inner-JSON parsing cases. Generate/check them with
`protocol-persisted-unicode-fixtures.ts`, `protocol-persisted-reducer-fixtures.ts`
and `protocol-read-json-fixtures.ts` (each supports `--generate`); freshness is
part of the maintained gate. The existing 15,053 scalar replay cases also exercise
the typed kernels. PostgreSQL columns are decoded explicitly: the source helper
unwraps event actor/payload/compatibility, artifact metadata and build ticket,
whereas direct columns such as repository tick are not blanket-unwrapped.


The aggregate also checks route-tail parity against the actual source service:
resource IDs remain single decoded segments, while the generic build/repository/
session operation tail is joined and re-split. Original-segment repository special
routes and top-level stream addressing retain their distinct grammar. The route
proof includes 71 comparisons, including missing-repository reducer-values GET
and exact fallback errors. Delegation coverage includes 24 presence regressions:
delegated GET is refused before presence lookup, with the source's exact text;
POST retains the source's earlier mutation authorization and JSON-parse errors.
These results are recorded in `routeParity`, `retentionEnvironment` and the
authority proof's `presenceRefusals` in the family report.

`bun tools/ticket-protocol-fixtures.ts` checks the source-pinned ticket request
schema corpus (`--write` explicitly regenerates it). Its operation inventory
requires a valid seed for every exported hosted ticket operation, and records
strict-envelope, required-field, null and type diagnostics plus policy probes.
This is a request-validation oracle only; it does not establish native ticket
HTTP behavior, historical response compatibility or durable connect parity.

`bun tools/ticket-http-fixtures.ts` checks actual TypeScript ticket-handler
responses over a seeded in-memory TicketSource (`--write` explicitly refreshes).
The corpus records each request, identity headers and capability masks for every
ticket operation, including unknown capability values and release refusals.
The maintained `ticket-protocol-integration.ts` replays every recorded refused
case against native HTTP with exact status/body comparison. Every admitted
get/list projection is compared both to its recorded body and the real TypeScript
handler over an equivalent PostgreSQL seed. Only the generated revision value is
normalized, preserving its presence/type and all other fields. Frozen decoders
validate native projections when their release line is admitted; retired clients
receive the recorded version refusal. The fixture freshness check alone makes
no persistence or native parity claim; the database/HTTP replay supplies those
proofs and reports its refusal/projection counts in the gate output.

`connect-fixtures.ts` pins the TypeScript repository normalizer and its accepted
and refused identity forms. `connect-persistence-integration.ts` runs a native
bridge against isolated migrated PostgreSQL and checks restart, mixed-server
approval, credential usability, denial/expiry, collision rollback, cancellation
and revocation. Both participate in the experiment verify gate. Connect captures
seed real durable requests and decisions at both widths and in both grounds.

`ticket-protocol-integration.ts` compares native ticket reads and transactional
writes with the real TypeScript handler over isolated PostgreSQL/S3 projects.
`ticket-cli-integration.ts` exercises the actual ticket command parser/handlers
against both normal HTTP services and compares outputs and downloaded asset
bytes. `connect-integration.ts` runs the normal native server with server-issued
development browser sessions and unchanged CLI connection functions, including
hosted policy publication, cross-server credential use, no-JavaScript decisions,
Origin/CSRF refusals, restart, cancellation and disconnect. These commands run
inside the maintained experiment gate; they do not use production credentials.

## MCP evidence

`bun tools/mcp-fixtures.ts --write` explicitly regenerates the offline corpus
from the actual TypeScript MCP endpoint, SDK and hosted operator service. Format
the regenerated JSON with `bunx biome format --write fixtures/mcp-corpus.json`. The
normal invocation fails on drift. The corpus preserves SDK descriptors separately
from original execution schemas: the SDK advertises empty object schemas for
some union tools while still validating their original Zod inputs.

`bun tools/mcp-integration.ts` starts an isolated migrated PostgreSQL database,
S3 emulator and normal Rust server. It exercises discovery, registration,
server-issued development browser admission, consent, S256 exchange, the real
SDK transport, every advertised tool, restart persistence, refresh races and
allowlist revocation. Set `CARGO_TARGET_DIR` to an external verification cache
when running it independently. The normal verify gate includes this suite.

`bun tools/mcp-agent-proof.ts` is a separate explicit command that uses the
installed authenticated Claude CLI and may incur provider charges. It loads the
installed operator skill, creates a real OAuth grant and private HTTP MCP config,
and allows only this isolated deployment's MCP tools. It requires successful
build listing/detail, escalation answer and ticket creation, plus independent
TypeScript event-parser/reducer and ticket readback. Credential files are removed
in `finally`; redacted reports live under `.ab/implement/mcp-agent-proof/`. Deposit
those reports through the phase CLI; never attach the private config or raw logs.
Routine verification never launches this model proof.

Oracle refreshes must generate the base corpus first (it replaces `fixtures/`),
then the subsidiary families. Generate `control-fixtures.ts --write` before
`mcp-fixtures.ts --write`: the MCP positive-control seed reads that corpus.
The current presence proof includes idempotent `DELETE` withdrawal, per-segment
ID decoding/normalization, scoped deletion, and mutation-free credential refusals.
HTTP session proofs require inert creation even with malformed or retired hosted
runner configuration; only explicit session wake mutations write wake facts.

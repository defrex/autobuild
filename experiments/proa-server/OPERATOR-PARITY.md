# Native operator interoperability

This nonshipping experiment implements the operator contract with native Rust
policies and PostgreSQL/blob adapters. Authored changes stay inside
`experiments/proa-server/`; TypeScript is an offline oracle and test consumer,
never a production request subprocess. Immutable ANSI reference bytes remain
unchanged.

## Durable boundaries

Bearer HTTP and cookie-authenticated browser forms invoke the same native domain
operations. Build/repository/session facts are validated before append, with
TypeScript-compatible actors, compatibility stamps, parent locks, sequences and
compare-and-append behavior. The reader retains SELECT-only transactions; the
writer has an independent connection and optional `PROA_POSTGRES_WRITE_URL`.

Uploads precede SQL artifact publication. Ticket snapshots preserve sampled
revisions, binary bytes, empty files/directories, current tombstones and readable
legacy identities. TypeScript's actual snapshot consumer reads the native chunks
and gzip manifest and checks byte lengths/hashes. Referenced immutable snapshots
are not removed by notes/config retention.

Answers preserve sequential prefix and retry semantics. Idle node revisions use
writer/runner fences and exact-tail guards. Landing reobserves live source/frozen
children before the guarded consent write. Bulk control preserves hold, intake,
then eligible build ordering and exact partial progress.

## Executable evidence

`tools/operator-integration.ts` collects native HTTP replay results and checks
`tools/operator-coverage.ts` before reporting parity. The completion gate joins
actual checked case IDs to source-derived oracle results, requires every case in
every executable manifest, and binds evidence to both TypeScript and native/proof
source hashes. Inventories, validation/auth failures and unknown-resource-only
responses cannot establish operation coverage. All 33 routes, seven actions,
six answer variants and 25 advertised HTTP tools require positive or applicable
domain-refusal witnesses.

The replay combines session/Unicode/JSON boundaries, strict source-generated Zod
schemas, API detail/dashboard/repository/harvest projections, all build controls,
node completeness, ticket spec/asset repinning, repository controls, delegation,
hosted ticket mutations and generic registry dispatch. Reads include CLEANING,
run-correlated effective config, runtime attaches, handoffs, telemetry, capacity,
raw artifacts and bounded session streams. Config normalization and issue bytes
are differentially checked over the actual source grammar and its nodes.

Failure proofs use isolated SQL triggers and a local proxy forwarding signed
requests to the real local S3 fixture. They exercise surviving answer prefixes,
lazy authorized retry, failed uploads, terminalization during upload, node fence
contention, tail movement and each partial bulk boundary. No production fault
injection or generic event-write endpoint exists.

`tools/dispatcher-integration.ts` runs the actual core Dispatcher and BuildRunner
over a disposable PostgreSQL store and real temporary Git workspaces, with fake
agent/forge edges. Native browser pause/resume facts stop and restart session
scheduling. The actual terminal renderer records PAUSING, PAUSED and resumed
RUNNING frames. It never controls the live repository dispatcher.

## Browser evidence

The capture renders 40 states at 1440/390 in both ANSI grounds. It submits the
required detail and extended repository/answer controls with and without
JavaScript (34 mutations), checks identity and exact durable actor sequences,
requires destructive confirmation, and preserves drafts, refusal text, focus and
caret across polls. CSRF, Origin and project refusals leave facts unchanged.
Spec revision's deterministic fact is kernel-authored after the signed human
answer; the proof compares the source actor sequence rather than relabeling it.
No web landing consent or ticket authoring is offered.

The final linked executable's hash, served asset hashes, frame review and browser
proof are retained with ignored capture evidence. See `tools/README.md` for the
commands and `FIELD-NOTES.md` for measured framework behavior.

## Attribution exception

Ticket-row mutations preserve TypeScript storage parity and enforce the same
authentication/authorization. They are an explicit exception to the operator
API's broad claim that every write records its owner identity. Observation
`obs_675b94d9` records this existing product gap; guidance forbids inventing a
ticket audit record, artifact or schema here. A durable ticket-attribution
contract requires a maintainer product decision. Build/repository facts retain
the signed human and optional transport `via`; session facts never carry `via`.

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
inventory.json, verify-report.md and sixteen PNGs. Each run owns two server ports (admitted and refused identities),
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

`bun tools/operator-fixtures.ts` checks the committed operator HTTP oracle against
current TypeScript sources, identity rules and documentation. Regenerate deliberately
with `--write`; `coverage.missing*` in `fixtures/operator-corpus.json` remains an
explicit completion checklist. `bun tools/writer-fixtures.ts` checks the generated
actor/classification policy; `--write` regenerates it. Rust policy tests
consume the oracle and compare exact refusals, actor/payload, write count and state.

`bun tools/operator-integration.ts` provisions isolated PostgreSQL/S3 resources and
runs the native `operator-proof` test bridge, then reads its actual writes through
the TypeScript store. Its database roles are separate from the existing SELECT-only
reader proof; denied writes must leave no durable event. This bridge is test tooling,
not a production API or a proxy for Rust HTTP requests. The HTTP replay and browser
proofs exercise the real server separately. [The staged parity checklist](../OPERATOR-PARITY.md)
distinguishes measured coverage from remaining full-surface and concurrency gates;
a passing subset does not establish complete operator parity.

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

Browser forms carry only the cookie session's CSRF token, project and slug. They
share the native operator policies and strict answer schema; supplied identity
fields never grant authority. Ordinary successful POSTs redirect with 303. Enhanced
POSTs request server-rendered HTML with `X-Proa-Fragment: 1`; a typed refusal is
escaped inline with the draft retained. Polls preserve drafts, errors and pending
confirmations, and responses from older polls cannot replace a mutation result.
Landing consent remains API-only.

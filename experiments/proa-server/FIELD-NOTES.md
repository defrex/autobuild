# Field notes

## 2026-10-24 — ANSI shell and first Proa server

Environment: Linux, rustc 1.99.1 (58cf8f9c3), proa-cli 0.1.3, Proa Rust crates
0.3.0, Bun 1.4.4, Tailwind CSS and CLI 4.3.1, system Chromium. Rust is pinned
by rust-toolchain.toml, Cargo.lock is committed, and the private Bun project pins
both matching Tailwind packages. No global Tailwind was installed or used.

Starter reproduction:

```sh
proa new site experiments/proa-server --template app --database none --ui none \
  --styling tailwind --starter blank --deploy none --no-git --no-vscode --yes
```

The scaffold needed Tailwind on PATH, so it was first installed in a temporary
Bun project, whose dependency manifests were moved into the experiment and
installed locally. All later Proa commands used this directory's node_modules/.bin.
The starter supplied useful Axum routing, static serving, health/readiness seams,
content negotiation, representation tests and a small shared state without a DB.
The synchronous render API fit the shell directly; no islands were needed.
Proa's lint correctly rejected missing Markdown content when the placeholder body
changed. Updating the Markdown representation to match resolved it without an
exception. Build-time accessibility checks stayed enabled and passed.

### Workarounds and confirmed defect

1. **Linked build/start path mismatch (Proa 0.1.3).** From this project, run
   `proa build --locked`, then `proa start`. Expected: the just-built executable
   starts. Actual: start reports `release executable not found at .../target/release/proa-server`
   and asks to run `proa build` first. The successful linked build instead reports
   its executable beneath target/proa-rsjs. Workaround, validated here:
   `proa build --locked --artifact-out target/release/proa-server`, then
   `PORT=4567 proa start`. This uses the CLI's supported export, with no framework
   replacement or hand-written HTTP server. The README documents this run command.
2. **Generated assets and root lint.** The starter writes public/styles.css and
   starter.css. The generated output is ignored, starter.css is removed, and
   styles/input.css contains only standard CSS imports. Authored
   styles live in ansi.css. The local inherited Biome config excludes only the
   immutable design tree, Tailwind entrypoint and generated output. The reference
   remains byte-identical after formatting. This is integration configuration,
   not a confirmed Proa defect.
3. **Staged formatter.** The root staged-file formatter invokes Biome through
   stdin even for the locally excluded Tailwind entrypoint. An explicit Tailwind
   @source directive failed that parser. Removed the unnecessary directive;
   Tailwind automatic source detection and the imported authored styles suffice.
   The normal commit hook and rebuilt stylesheet then passed, without bypassing
   hooks or changing root rules.
4. **Render link consistency.** Editing a Rust file during an initial linked
   test caused RSJS0001, reporting the changed source rather than combining stale
   descriptors. Retrying after edits stopped passed. This was expected protection,
   not a defect. Cold linked test targets compiled separate descriptor/final
   dependency trees and were substantially slower than cargo test; warm release
   export reused 278/279 descriptor and 279/279 final artifacts.
5. **Security headers.** The blank scaffold adds no CSP header blocking the
   same-origin external scripts. No security-header adjustment or inline-script
   exception was required. The theme initializer runs before the stylesheet.

### Visual and interaction evidence

Copied the complete design/ansi asset, revision 1000000000: reference page,
README, both product briefs, and all 24 PNGs. Inspected desktop Builds/menu and
phone Builds references in both grounds before implementation. Kept the reference
1180px frame, 24px desktop/16px phone padding, masthead spacing, text controls,
square menu border and two font families. The neutral identity and placeholder
body replace synthetic account/data content. On phones the menu is clamped to
16px insets instead of the reference's edge-to-edge placement.

Real Chromium inspection at 1440 × 900 and 390 × 900, light and dark, captured
and opened all eight closed/open-menu images. scrollWidth equaled clientWidth
(1440 or 390) in every case. Computed prose face was Atkinson Hyperlegible Next;
project machine text was JetBrains Mono. Both font faces reported loaded.
Every application request stayed on the local origin, including fonts.

Checked keyboard Enter to open, Escape to close and restore trigger focus,
outside click to close, Dark override across reload and OS changes, System removal
of the override and response to changed OS preference, and explicit Light with
localStorage unavailable. The disclosure uses normal links/buttons and Tab order,
not ARIA menu roles. Theme choice returns focus to the trigger. Browser evidence
is deposited with this build; no capture script or transient PNG is committed.

WCAG contrast, computed from the exact reference sRGB token values:

| Text / background | Light | Dark | Use |
| --- | ---: | ---: | --- |
| ink / ground | 16.31:1 | 14.01:1 | prose, headings, project, links, active theme |
| slack / ground | 5.66:1 | 5.47:1 | explanation, menu labels, inactive themes |
| teal / ground | 4.61:1 | 8.87:1 | hovered text controls/links, focus outline |
| ink / select | 11.52:1 | 8.26:1 | selected text |

All used text pairings exceed 4.5:1, including small labels. Rule tokens are
purely decorative. No additional color literals were introduced.

### Verification

- `proa fmt --check --verify src`, `proa lint src --deny warnings`,
  `proa test --locked`, `cargo test --locked`, `proa build --locked`: passed.
- Removed public/styles.css before both the production build and proa dev;
  each regenerated it using local Tailwind and served styled output.
- Default server observed listening on 127.0.0.1:3000; exported production server
  on 127.0.0.1:4567 with PORT=4567. Both /health responses were 200 with 0.1.0.
  Styles, both scripts and both fonts returned 200 with CSS, JS and font/ttf types.
- Config tests cover default binding, IPv6/custom port, malformed/zero/overflow
  ports and invalid hosts. Router tests cover health/version, shared shell/assets,
  placeholder and HTML/Markdown negotiation. Four Rust tests passed.
- Experiment Biome check, reference byte parity and ignored target/styles checks
  passed. Root lint passed with an unrelated pre-existing untracked
  experiments_probe.html temporarily relocated and restored unchanged; that file
  makes the initial unmodified-workspace root lint run fail.
- Repository check:build and typecheck passed. Repository unit suite results are
  recorded in the implementation deposit alongside the other check evidence.

The root suite's Pi-install-pin repository scan also traversed the ignored Rust
target cache (24GB after cold linked tests/builds), timing out at its 5s limit.
Its directory skip list does not include target. Moved generated target output
under ignored .ab/proa-rust-target and reran configuration-doc.test.ts: all 30
tests passed in 142ms. No test code was changed; observation obs_7ec32af4 records
this integration follow-up for future Rust gates. The generated cache is not a
project deliverable. Two other initial root-suite failures (capture timeout under
load, fixture inheriting AB_CONTEXT_DIR from the build session) both passed their
targeted rerun with AB_CONTEXT_DIR cleared; the latter is obs_27a18ba5.

## 2026-10-24 — automated verification gates and cache investigation

Verified with Rust 1.99.1 (58cf8f9c3), Proa CLI 0.1.3, Bun 1.4.4,
Tailwind 4.3.1 and local /usr/bin/chromium. The new tools/verify.ts runs
Proa formatting/lint, Cargo formatting/clippy/tests, linked Proa tests and a
linked build with --artifact-out. It preserves accessibility/performance checks.
The real server, local fonts and stylesheet produced all eight Builds/menu
frames (1440/390, light/dark); deterministic probes and visual inspection passed.
No database or auth exists, so this proves unsigned placeholder pages only.

Negative checks in an isolated disposable Git worktree:

- Changing `pub struct Config {` to `pub struct Config{` made **Proa fmt return
  zero**, with no diagnostics. It checks Proa formatting, not all ordinary Rust
  formatting. Cargo fmt --check returned 1. Added Cargo's check to the gate.
- An unused Rust function made cargo clippy --locked --all-targets -- -D warnings
  exit 101 with dead-code diagnostics.
- An intentionally failing isolated Rust test made cargo test exit 101.
- Changing build.command to ["false"] made proa build --locked --artifact-out
  fail with exit 1: custom non-Cargo commands are unsupported by the linked
  pipeline. It did not create a successful export.
- Chromium fixture pages independently rejected forbidden RGB color, serif
  face, overflow, missing heading, external request, missing asset and page
  exception. Their browser profiles were removed after failure.

The first gate passed. Cargo reported 13.33s for clippy and 15.31s for ordinary
Rust tests. Linked tests use separate descriptor/final targets for each test
root (cold pairs 26.83/17.90s, 26.60/19.45s, 28.94/20.04s). The locked linked
release build reported 49.56/37.37s, descriptor/final 0/279 artifacts reused.
An initial --offline capture build used another namespace and took
47.73/35.21s, also 0/279 reused. A subsequent same-worktree offline capture
reported 0.07/0.06s and **279/279 reused in both stages**. Each invocation
exports a distinct executable before releasing the flock lock; concurrent gate
and capture runs serialized, with distinct exports. Shared dependency artifacts
never serve directly as the capture executable.

**Measured limitation: cross-worktree linked reuse.** The second
worktree at the exact same commit, sharing the identical absolute
CARGO_TARGET_DIR, reused ordinary Cargo dependencies (clippy 0.22s; tests 1.47s).
But its first linked test rebuilt dependencies, taking 26.20/19.84s and reporting
**descriptor 0/248 Cargo artifacts reused; final 0/248 reused**. Stopped that
proof run after obtaining the first complete linked-test result rather than
repeating the remaining cold test roots. This is not warm reuse across builds.

Installed Proa 0.1.3 lifecycle.rs selects package.id from Cargo metadata, puts
that absolute path-bearing ID in InvocationSpec.roots, hashes the invocation,
and places descriptor-target-policy-v4-sidecar-v10-persistent-v1 under that
hash. Its final-target/rsjs-final/wrapper-v6 is similarly invocation-separated.
rsjs_ir 0.2.0 build.rs canonically encodes RequestedRootTarget.package. Thus a
new worktree path gets a new linked namespace despite sharing CARGO_TARGET_DIR.
Also --offline is an invocation identity input, explaining the separate initial
capture namespace. The source confirms the observed cold rebuild; a stable
cache directory alone does not provide linked cross-worktree reuse.

Operator guidance for implement round 1 accepts partial reuse: ordinary Cargo
dependency reuse satisfies the intent of avoiding a cold dependency graph on
every build. Keep the shared CARGO_TARGET_DIR, pinned toolchain and linked builds;
do not patch Proa or move builds to a fixed checkout. The measured linked rebuild
(roughly 20–26 seconds per stage) is an accepted Proa 0.1.3 limitation to revisit
on a later Proa upgrade.

Capture implementation details: probes inspect only painted text/borders (zero
width borders and inherited colors on textless elements are not painted).
Chromium's implicit Other-type /favicon.ico request is fulfilled with 204;
explicit image and application asset requests still fail on errors. LocalStorage
theme selection happens before navigation scripts; setting documentElement at
new-document injection time throws because it does not exist yet. The real
server starts in a temporary cwd with a link to worktree public assets, so
repository .env files cannot supply production/auth settings through dotenvy's
ancestor search. Capture performs no GitHub or other external page requests.

## 2026-10-24 — Rust-owned GitHub operator auth

The experiment now has a closed-by-default gateway around HTML, Markdown and
fallback routes. GitHub OAuth uses a ten-minute single-use state transaction,
random browser binding and S256 PKCE. The adapter exchanges the code server-side,
requests verified email records with user:email and paginates up to ten pages
(fails closed beyond that bound). Selection prefers an allowlisted verified
primary address, then sorts other allowed verified addresses by email.
Tokens never become browser state. Adapter tests use an actual local HTTP
transport to check form fields, JSON shapes, bearer headers and pagination;
production endpoints are fixed and redirects disabled.

Eight-hour signed opaque cookie IDs address bounded process-local records.
Restart invalidates sessions; multiple replicas cannot share them. The current
allowlist is checked on every request, with an injected mutable source proving
immediate removal/revocation in tests. A supervisor must replace the process to
change its environment. Logout requires both a session CSRF token and the exact
canonical Origin, with same-origin Referer fallback, and deletes the record so a
copied cookie cannot replay it. OAuth state/binding and logout CSRF are separate
checks. Cookies are host-only, Path=/, HttpOnly and SameSite=Lax, with Secure on
HTTPS and off loopback. Canonical configuration, not forwarded/Host headers,
controls redirects and cookie policy. Credentials are never Debug-rendered.

Framework evidence: pinned proa_framework_axum 0.3.0's router_from_spec does not
install FrameworkBuilder's security layers. We explicitly install
SecurityHeadersLayer and CrossOriginProtectionLayer over the full router.
CrossOriginProtection accepts safe methods and nonbrowser requests with neither
Origin nor Fetch Metadata; it is not enough for logout or development issuance.
Its trusted-origin setting names the validated canonical origin; handlers still
require their independent proof. An outer privacy layer covers early rejection
responses with no-store. OAuth responses use no-referrer; signed-in pages use same-origin to preserve form Origin proof. CSP permits only self-hosted external
scripts/styles/fonts and forbids objects/framing; forms/base are self. HSTS is
conditional on HTTPS. This listener speaks HTTP and assumes trusted TLS termination
for non-loopback deployment.

Proa serve does not insert ConnectInfo. Reproduction: inspect its pinned serve
implementation, which accepts the socket but hands requests directly to Router.
The explicit loopback development-auth mode therefore uses Axum's
into_make_service_with_connect_info adapter, with SIGINT/SIGTERM and a bounded
30-second drain. A real TCP test issues through this path and proves the actual
loopback peer reaches the handler. Missing/remote peers, missing/wrong random
capture capability and cross-origin browser issuance are refused. The adapter
uses the exported binary without Proa's dev reload injection.

Visual capture now starts two isolated loopback server instances with fresh
secrets and capability: one admitted identity and one genuinely denied identity.
The refusal frame comes from a real POST response, not a query parameter or
browser stub. Sixteen frames cover sign-in, refusal, Builds and account disclosure
at both widths/grounds. Browser checks retain palette, loaded/rendered fonts,
overflow, network and error probes, and require real logout to revoke a copied
cookie under the enforced CSP. The ANSI organization's refusal wording is reference
copy only; this experiment authorizes solely by email and implements no org roles.

Browser evidence caught a policy interaction that direct router tests cannot:
Chromium can serialize Origin as null for a form POST from a no-referrer document.
Applying no-referrer indiscriminately therefore broke legitimate sign-out while
the CSRF check correctly refused the request. OAuth pages retain no-referrer;
protected pages use same-origin. The capture's real form submission plus copied
cookie replay check guards this behavior. Public sign-in has no monospace text,
so capture explicitly loads both local font faces before checking their availability;
rendered-font probes still verify the faces actually used on each page.

## Rust data access alongside Proa DataLoader

The native `data` library now initializes from the TypeScript store's environment
contract before the HTTP listener binds. It checks migration version 17 and its
checksum with SELECT, reads in read-only transactions, and never migrates or uses
snapshot answers. A bounded four-connection pool allows unrelated scope reads to
proceed independently. Build/session metadata and facts are filtered by repository.
Blob bytes are fetched by content hash through the official AWS SDK or Vercel GET;
no native writer is exposed.

Proa's `DataLoader` / `cx.load_typed(...)` shares keyed work within one request.
Each response should still get one `DataResolver::request_scope(...)`. Our
`DataReader` lives longer: the database identity is fixed by its connection, and
project/scope keys own serialized accumulator/cursor advances across requests.
A restart or cache eviction replays facts. Request-local sharing alone cannot avoid
whole-log reads on the next poll. The current shell uses neither reader in a page;
this library is the boundary for later dashboard work.

The real TypeScript-store/S3rver producer and native Rust process passed binary
artifact reads in build/repository/session scopes, active-project discovery,
foreign-project filtering, explicit/latest revisions, and distinct absent-metadata
versus absent-object results. Query instrumentation measured N=2 initial build rows,
M=1 appended row, and zero rows on the next poll. Concurrent callers returned equal
states without double folds; a fresh process replay returned the same value.
Table data, column definitions, constraints and indexes remained unchanged under
Rust reads with a SELECT-only role. Schema version 999 refused both the reader
bridge and actual HTTP-server startup, naming expected 17 and found 999.
The full gate supplies its own loopback S3 service and uniquely named database/role;
it also intentionally fails a Rust child and checks resource cleanup.

Operator rulings `esc_a5644697` and `esc_f213ee9f` resolve the compatibility seam:
classify negative logs mechanically against each scope's current catalog. Preserve
the TypeScript answer as evidence, but require Rust decoding failure for any unknown
event name. Assert the classification itself so no known-only log escapes strict
field parity. An unreadable build leaves healthy neighbors usable; repository or
session failures remain local to their own scope. This is deliberately stricter
than the TypeScript advisory-event compatibility path, not a guessed partial state.


Provider inspection for the native blob reader: the pinned TypeScript
`@vercel/blob` 2.8.0 `dist/index.js` `get` and
`dist/chunk-YYMLUMXS.js` `resolveBlobAuth` / `constructBlobUrl` send GET directly to
`https://{storeId}.{public|private}.blob.vercel-storage.com/{pathname}` with
`authorization: Bearer {token}` for either access mode. The read/write token's
fourth underscore-delimited segment supplies the store id; OIDC uses the
configured store id with an optional `store_` prefix removed. This SDK performs
no OIDC exchange for GET: the OIDC token itself is the bearer. GET has no
`x-api-version` header. A 404 returns null; other unsuccessful responses throw;
304 has no stream. The store adapter does not request conditional reads or
cache bypass. Prefix normalization removes empty slash-separated components.
Native GET wire tests cover bearer authentication, binary bodies, missing objects
and preserved authorization failures. S3 interoperability uses the real signed
TypeScript and Rust SDK clients against S3rver 3.7.1; that local subset is not a
claim about every AWS behavior. A credentialed disposable Vercel store was not
available; the pinned SDK implementation and local wire proof are recorded in
[BLOB-CONTRACT.md](BLOB-CONTRACT.md).

Provider contracts consulted:
[AWS GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html),
[Vercel SDK get](https://vercel.com/docs/vercel-blob/using-blob-sdk#get), and
[S3rver 3.7.1 lifecycle](https://github.com/jamhall/s3rver/blob/v3.7.1/README.md).


Linked-build finding: the initial PostgreSQL native-TLS connector introduced
`libcrypto.so.3`. Proa 0.1.3 refuses that non-system dependency when freezing an
immutable launch snapshot. Switching to `tokio-postgres-rustls` with native trust
roots removes both libcrypto/libssl links while preserving URL sslmode and certificate
validation. The real-store proof passes after this change; no Proa patch or disabled
linked build is needed.

Current corpus inventory: 33 producer files executed 725 tests, with two explicitly
provider-gated skips. The corpus preserves 19,408 source cases/provenance aliases
as 5,868 distinct scope/log fixtures: 4,330 build, 1,409 repository and 129 session.
All 219 catalog names have decoding witnesses (134 build, 74 repository, 11 session).
Ten unknown-type cases retain TS answers and assert scoped Rust unreadability;
39 deliberately invalid TS histories preserve the oracle error outcome, and 16
causally incomplete standalone witnesses are decoding-only. Freshness covers 820
source/dependency inputs. Lossless deterministic gzip is about 2.8 MiB, alongside
268 KiB of decoding schemas and a readable 110 KiB manifest; identical logs retain
all original producer identities as aliases. Generation completed with the current
producer code, then its non-mutating freshness check passed.

The clean repository unit run passed 8,153 tests with 49 skips and zero failures.
The initial run exposed a corpus self-test instrumentation leak, now fixed by full
prototype/reducer restoration. The separately known inherited AB_CONTEXT_DIR routing
test issue remains outside this build; the clean run removed only that variable.
Rust default/union validation caches and exact-equality fast paths keep the broader
17,616-case development parity stress run practical (about 102 seconds before the
last redundant-validator optimization); final-gate timings remain in its ignored
build evidence directory. Extra generated additive-field histories verified raw
repository journals and opaque session fields against TypeScript. The server
never loads oracle answers: only the generated event schema catalog is embedded.


## Review round 2: unreadable streams and disconnected backends

An unreadable append-only stream now retains its deterministic scoped decode error
in the process cache. Further polls issue no event query, even after new facts are
appended. Cache clear or process restart replays once and rediscovers the failure;
the failed batch never publishes partial state or advances its successful cursor.
The integration proof polls an unknown build through repeated project reads, then
checks unchanged query instrumentation after an extra append. Repository, session
and known-malformed build failures also retain their error without further reads.

Closed PostgreSQL pool slots reconnect under the slot lock on subsequent reads.
Replacement connections use the same TLS settings and SELECT-only schema preflight;
a failed reconnect leaves the slot retryable, and a changed schema marker refuses
reuse. The real-store test terminates all four reader backends, verifies all four
PIDs are replaced, retains the healthy build's accumulator/cursor, and checks schema
refusal again after disconnection. No query is transparently retried mid-transaction.

## Dense live views: projection and rendering (2026-10-25)

The dashboard oracle now covers 4,330 build logs, their corpus prefix boundaries,
32 stream/config variants and nested/missing-parent/cyclic tree inputs. The
whole/prefix native comparison took about 15 seconds on this host. Recomputing
TypeScript answers twice in the freshness tooling test took about 12 seconds
under concurrent checks, so this corpus test has an explicit 60-second budget.
It never regenerates expected outputs in check mode.

Proa 0.1.3's strict performance lint rejected URL building, JSON formatting and
elapsed-time allocation inside rendering. Preparing row/step/frame views before
rendering removed those allocations without suppressing the lint. Data reads use
request-scoped typed resolvers. Holding ordinary `WebContext` across an await in
an Axum handler failed its Send-bound Handler check; the pinned core's
`SendWebContext::with_loader_buffer` supports that handler boundary.

This implementation completes its typed store snapshot before emitting HTML,
then uses synchronous Proa components for both the document and refresh fragment.
It is in-order SSR: the no-JS snapshot has all rows and artifact text. It trades
an early empty shell for a complete first response. The official
[streaming SSR guide](https://proa.so/docs/core/streaming-ssr) documents Suspense
swap delivery; using that mode would require the browser swap runtime, so it is
unsuitable as this view's no-JS baseline. The pinned framework also exposes
`ssr_async_with_loader` and `ssr_stream_with_loader` in its route response source;
these must not be confused with synchronous `ssr`.

The [islands guide](https://proa.so/docs/guides/islands) keeps static data, links
and forms in ordinary SSR. This view uses native project selection and disclosure,
with one external progressive polling script and locally ticking elapsed values.
It does not instantiate RSJS islands or signals, so its empty island manifest is
intentional and no hydration/runtime CSP exception is needed. Durable event and
stream versions remain server-side; the client has no second projection.

Reproducible proa-ui evaluation: fetch
`https://ui.proa.so/r/select.json` (version
`sha256:11415b61da4cc2ac36ce27f3fdc80c2c954bd2a6473290f86e6fa3fd6553b413`),
then resolve each `files[].source` against `https://ui.proa.so/r/` and inspect
`select/select.rs`. Its `SelectOption` requires static string values/labels and
its recipe/foundation adds a styled widget surface. Store-owned project ids
need owned values without leaking strings. Fetch `accordion.json` the same way
and inspect `accordion/css_only.rs`: despite the module header describing native
details, its implementation uses checkbox/radio controls. Native select and
details preserve the needed keyboard/no-JS behavior and ANSI styles with less
machinery. No decorative component was added to claim adoption.

Linked RSJS builds detect edits while linking and stop with RSJS0001 rather than
combine stale descriptors with changed source. Freeze `src/` for the linked gate
and capture. Ordinary Cargo checks alone do not exercise this safeguard.

The live-stream SQL proof caught a real cross-language decoding seam: the TS
Postgres adapter can store `stream_chunks.parts` as a JSONB string containing the
serialized parts array. Rust now accepts that representation and decoded JSONB
arrays, then validates the part types before advancing its independent cursor.
The real TS-write/Rust-read proof passes with both idle suffix reads and new text.

Proa 0.3.0's macro expansion panicked on a nested conditional render beside a
Unicode middle-dot literal (`end byte index ... is not a char boundary`). Moving
the optional stream-status rendering into a small synchronous component avoids
that expansion path without changing the markup or disabling checks. The font
probe also caught ideographic legend spaces selecting a CJK fallback; ordinary
spaces and CSS gap retain the shipped font coverage.

The required mixed producer contains Japanese and emoji in stored escalation and
warning text. Requiring only the two Latin interface faces for those glyphs would
mean corrupting the producer's data. Capture therefore records narrowly scoped
fallback usage for marked store text: Japanese scripts may use Noto Sans CJK JP,
and emoji may use Noto Color Emoji. All interface labels, ASCII content, spacing
and declared CSS font families retain the original strict two-face checks. The
allowance has negative cases for interface emoji, ordinary English, ideographic
spacing and arbitrary replacement faces. Per-frame inventory records the exact
stored text and fallback family for review.

Final linked/native gates passed. The complete 24-frame capture at 1440 and 390
in both grounds passed palette/font/overflow probes, same-document event and
transcript updates within five seconds, no-JS snapshots and auth/menu behavior.
Every PNG was opened: nested tree indentation, wrapping steps, unfilled status
words, full escalation text, scoped frame and readable session transcripts held
at both widths. Its actual SQL trace recorded 135 reads, including 109 idle
suffix reads returning zero rows; one appended build event and one stream chunk
each returned one new row. Seven scoped immutable blobs were fetched once each.
Chromium also reports descendant glyphs against containing blocks; the font
probe checks the actual marked text separately and avoids duplicate aggregate
rejections for textless wrappers. The logout proof now waits for complete page
load before clicking sign-out, preserving strict network-error checks.

## Review round 2: mature projects and dense-list parity

A suffix-only event trace hid metadata amplification: each idle snapshot still
looked up pinned config and every session stream for every historical build.
Discovery now sends the known event cursors/metadata versions in one query and
receives only new/changed/deleted records. Historical facts stay in the process
index; visible rows and needed ancestors alone read stream/pinned metadata.
Closed stream metadata is retained, open/new metadata remains independently live,
and selected detail reads one build record. Metadata query/result-row evidence is
now explicit beside event/chunk/blob evidence. A real-store test adds 509 completed
hidden builds and 5,090 closed streams and checks warm polls perform no per-history
reads. Cold startup still folds each build once; the cache is not durable state.

The renderer must consume the projection as well as prove it: setup diagnostics,
PR state/link, paused markers, review ceilings and integration progress now have
rendered-HTML regression coverage. Escalations use the three-logical-row preview,
preserve paragraph boundaries in a red-ruled ANSI callout and link to full detail.
Artifact bytes retain bounded caching while per-object single flight replaces a
global lock held across blob I/O. A deliberately stalled object test proves other
misses and warm hits remain responsive without duplicate same-object fetches.

Round 2's full gate passed. On isolated loopback Postgres/S3, the mature-project
proof measured three warm polls at 62 ms and a live update at 27 ms; a final focused
run measured 76/29 ms. These are measured local results, not remote RTT promises.
Discovery still sends per-build cursor/version evidence and performs indexed tail
checks; it avoids historical result transfers and per-history transactions rather
than claiming constant total CPU/request size. The 24-frame matrix was opened in
both grounds and widths: callout paragraphs/previews, restored PR state, wrapping,
tree indentation, menu and detail remain readable. Final capture recorded 329
reads including 260 metadata reads. Its logger now explicitly includes the
Postgres module and capture fails if any expected metadata category is missing.

## Operator controls: native foundation checkpoint

The operator port keeps writes on a separate PostgreSQL connection; the existing
reader transactions remain SELECT-only. Session policies are reusable library
operations: the bearer and browser transports will supply verified identity and
validated input. Native policy tests consume real TypeScript HTTP oracle cases,
including the distinct archive and approval refusal texts, with complete ordered
session facts and reduced post-state. The fixture inventory explicitly records
unimplemented control coverage so source freshness cannot be mistaken for parity.

This checkpoint changes no rendered surface. Proa forms, polling/mutation races
and progressive enhancement have not yet been measured; their browser and visual
proofs remain required before the build can finish. The ticket attribution gap
`obs_675b94d9` is retained as an explicit TypeScript storage-parity exception rather
than filled with a new experiment-only audit schema.

## Operator controls: forms and progressive enhancement

The form surface renders synchronously. A request-scoped loader supplies one
fresh dashboard/detail snapshot, and the authenticated Viewer supplies the CSRF
field and sign-off on both initial HTML and polling fragments. No bearer token
or machine signing key enters the page. Browser POSTs recheck the live session,
registered project, canonical Origin/Referer and CSRF before sharing native
operator policy. Confirmation renders a second ordinary form; that first POST
writes no lifecycle intent. Successful ordinary mutations use a 303 GET, while
enhanced requests receive the same rendered page fragment.

A draft, a refusal and a destructive confirmation are page state as well as
server state. Polling preserves their controls subtree; submitting aborts an
older poll and advances a generation so its response cannot overwrite the
acknowledgment. Mutation handlers never optimistically change lifecycle words.
The enhancement delegates to the forms, disables only the submitted form's
buttons and restores focus after replacing the fragment. Concurrent local
submissions are suppressed while a mutation is pending.

Proa needs an explicit `raw_text_ok` around deliberate textarea interpolation,
just as around the existing document title. This suppresses a warning, not HTML
escaping: the render test checks a `</textarea><script>` draft and revised body
cannot break out. Proa 0.1.3/0.3.0 also rejects a label/input anywhere inside a
`details` element as nested interactive content, although the HTML disclosure
content model permits it. A plain fieldset with a legend carries the extra
answer options without disabling the compiler's accessibility checks. Reproduce
with `html_sync! { <details><summary>"Options"</summary><label for="x">"Value"</label><input id="x"/></details> }`.

The seeded Chromium run exercised eight build operations in each script mode
(16 real mutations): pause, cancel-pause, resume, abort, discard, guidance, retry
and finding dismissal. The TypeScript store accepted every resulting native fact
with `operator@example.com` as the human actor and no delegated `via`. Both
confirmation first steps left event counts unchanged. Enhanced acknowledgments
arrived in the original document; a guidance draft, a stale-answer refusal and
a confirmation survived a polling interval. Wrong CSRF and Origin returned 403;
a valid registered but foreign project returned 404; all three left events
unchanged. The 40-frame visual matrix retained the ANSI grounds, local faces,
inline red states and narrow wrapping with no overflow.

The browser proof caught a DOM API trap: form controls named `action` shadow
`HTMLFormElement.action`. Enhancement must read `getAttribute('action')`, while
native no-JavaScript submission already follows the attribute. The CDP driver
also waits for deferred scripts before enhanced clicks and reacquires nodes
retired by a poll or navigation; neither timing is evidence of a server failure.

Extended browser proofs exposed the other native-form boundary: HTML serializes
textarea newlines as CRLF, whereas the enhanced path reads the DOM's LF value.
Without adapter normalization the same supplied spec produced different immutable
artifact bytes in the two modes. The browser adapter now recovers the DOM LF
representation for textarea text/body only, preserving whitespace and all other
characters. The JSON operator API continues to preserve its supplied bytes.

The extended seeded browser run passed all 18 additional submissions against the
actual native debug executable: intake, bulk pause/resume, harvest enablement,
harvest run resume/acknowledgment, review ceiling, supplied spec revision and
ticket spec revision in both script modes. Together with the baseline this is
34 mutations and three unchanged auth/resource refusals. The proof checked
ordered durable facts against the TypeScript validators and source actor
sequence, exact specification bytes and asset metadata, and same-document
enhanced acknowledgments. This development evidence is recorded separately
from the linked Proa capture provenance.

## Native mutations and contract completion

The native port's completion check uses executed oracle cases, not route names.
This distinction caught a misspelled registry tool whose requests otherwise
looked like successful refusal coverage. A coverage result must have no missing
routes, actions, answer variants, tools or executable suite cases, and its native
and TypeScript source hashes must still match.

JSON object order matters in two different places. Zod embeds ordered issue
objects in error strings; preserving insertion order reproduces those bytes.
Polling fingerprints remain canonical, so the reducer explicitly sorts their
objects recursively. The full reducer corpus caught the interaction. Generated
Unicode fixtures escape non-ASCII code points so staged formatting cannot replace
an interior U+FEFF with a replacement character. Actual Bun Request.json rejects
a leading BOM while the effective-config TextDecoder consumes it; their native
adapters deliberately keep those different byte contracts. Integral JSON forms
such as `5.0` normalize to the same integer as the TypeScript parser.

Native snapshots are checked by TypeScript's real consumer, including multi-chunk
binary files, zero-byte entries, directories and tombstones. Failure timing uses
only test-owned SQL triggers and a held signed upload proxy; native publication
remains inert when a concurrent terminal fact or fence/tail guard wins. The
isolated dispatcher proof also checks the real terminal renderer after native
browser pause/resume, with no live dispatcher process management.

### Live controls after an enhanced reply

A fragment acknowledgment must not pin the controls section during later polls.
Retain the operator's draft fields and refusal text within the fresh render;
refresh lifecycle/repository actions from durable state. Expire success notices
on the next full poll and retain a destructive confirmation only while its
corresponding action is still offered. Capture now acknowledges a pause, appends
the dispatcher acknowledgment, and requires Resume without navigation; it also
checks later escalations, external intake changes, and refusal-plus-draft
retention while action availability changes.

### Manual Cargo cache and root documentation scans

The root Pi provisioning documentation test walks ignored native `target/`
directories. A 12 GB manual-build cache made that test exceed its five-second
timeout during the full suite. Moving the generated cache into root `.ab/`,
which the walker excludes, reduced the isolated 30-test file from about four
seconds to 157 ms without changing assertions or timeouts. Manual setup now
exports `CARGO_TARGET_DIR` into `.ab/` and puts its executable there too. The
automated gate already uses a shared cache outside all worktrees.
## JSON machine branch: negotiate before extracting

The native protocol checkpoint uses a separate Axum router constructor from the
Proa browser branch. Machine requests need their release/protocol decision before
bearer authentication, indirect ownership before body parsing, and JSON for
unknown methods and failures. A fallback request handler makes that ordering
explicit; typed Axum body/path extractors can otherwise answer with their own
text or status before the protocol gate runs. Browser cookie/origin middleware
must stay outside this branch when the normal server is eventually merged.
No Proa page or normal-server routing changed in this checkpoint.

The request future must own its authorization header before awaiting a database
read: borrowing the full `Request<Body>` across that await makes the future
non-Send and prevents Axum's Handler implementation. A second practical pitfall
is the conformance clock: freeze stored timestamps through a private test control
channel, but measure held reads with Tokio's monotonic clock. Serializing the
whole HTTP response behind clock synchronization deadlocks a held read waiting
for a subsequent append; serialize only synchronization and request start.

Reproduce with `bun tools/protocol-integration.ts`. The native proof uses two Rust
processes and a TypeScript writer over isolated PostgreSQL/S3 services. It records
sanitized checkpoint evidence under `.ab/proa-protocol-store/`, explicitly without
claiming the complete shared BuildStore suite or rendered dashboard integration.

## Strict producer schemas and shared snapshot bytes

The machine write interpreter now covers every producer payload schema, with
named Rust checks for refinements and transformations that JSON Schema cannot
express. Corpus additions for optional fields, whitespace, provider/native-handle
branches, URLs and filenames caught two concrete differences: regex end/newline
handling and Zod URL trimming before normalization. The full native HTTP proof
compares normalized accepted writes and exact refusal text, not just booleans.
Compatibility stamping belongs after static/catalog validation and before SQL.
Ordinary CAS validates even when its expected head is stale; initial build
creation publishes its record and first fact in one transaction. Deferred SQL
constraint triggers prove commit failures roll both back, including repository
change position and sequence visibility.

Snapshot interoperability also depends on physical encoding. The TypeScript
PostgreSQL adapter explicitly serializes snapshot state, and Bun.SQL binds that
as a JSONB string envelope; reads unwrap that layer. Writing an ordinary JSONB
object can look right in Rust while a later TypeScript writer changes the
representation. Mixed Rust/TypeScript races exposed this. Rust now writes the
same envelope and reads both it and direct legacy objects, with scalar strings,
null and escaped NUL tested in both directions. This was a missing Rust encoding
convention, not a TypeScript scalar-state bug. Presence remains independent of
journal creation, and its clock rollback/expiry probes leave event sequences and
repository change positions untouched.


## Artifact publication and fenced tick observations

Blob upload and SQL publication are separate boundaries. Rust writes complete
raw S3 objects through the configured official SDK and Vercel objects through
the pinned SDK's evidenced request shape; it never base64-encodes the provider
body. All wire artifacts decode before any upload, and uploads finish before
the scope row lock is acquired. SQL then allocates revisions, substitutes exact
two-key negative references only in payload, validates the event, prunes managed
kinds once per batch, and commits metadata plus its event together. Failed
validation or deferred commit can leave an immutable orphan blob, but cannot
consume visible revisions, timestamps or sequence numbers. Deleting an orphan
as compensation would risk another writer already referencing the same hash.

Conditional deposits differ from ordinary conditional appends: after decoding
and uploading they compare under the lock before event validation. A stale
invalid event therefore returns null. Invalid-event rollback tests must send raw
HTTP: RemoteBuildStore validates producer writes locally before making a request,
which can otherwise make a test pass without exercising the Rust transaction.
Mixed Rust/TypeScript writers and a fresh Rust process prove the shared SQL
metadata and provider bytes, rather than a process-local object map.

Repository ticks use the same repository row lock and live-lease fence. Begin
and finish record observations without renewing the lease or heartbeat; quiet
finishes leave the journal/change position untouched. Boundary events and
telemetry become visible atomically, including under deferred commit failure.
The wire tick schema strips compatibility while the direct core validator can
reject incompatible metadata: HTTP oracles must compare the actual wire path.

These checkpoint proofs still do not establish full BuildStore conformance.
Ticket assets, streams, reducer values, delegation, production router mounting,
the entire unchanged contract, historical clients and isolated dispatch/reader
evidence remain required. Rendering the dispatch result on the Builds page
remains deferred to node integration after file-131 under ruling esc_6370a20b.

A final raw-text probe exposed JSON numeric semantics. Rust's default serde
parser preserved `9007199254740993` while JavaScript rounded it, rounded
`0.9999999999999999` up to one, and refused `1e400` where JavaScript accepted
Infinity before unknown metadata serialized it to null. Comparing both responses
with `response.json()` hid the large-integer difference; SQL JSON text and raw
response text exposed it.

Request parsing now retains raw numeric lexemes until correctly rounded f64
conversion, then uses ECMAScript shortest formatting. Nonfinite numbers remain
numeric through schema validation, so typed numbers reject them with Zod's exact
Infinity diagnostics while accepted unknown values become null at serialization.
The safe parser also preserves duplicate-key semantics and JavaScript's integer
property order, which affects strict-schema refusal ordering.

Enabling serde arbitrary precision introduces a separate trap: its ordinary
Value deserializer reserves a private object key as a number marker. A legal
user object carrying that key was silently converted into a scalar. Explicit
raw-object parsing and a JSON/JSONB FromSql wrapper preserve such objects on both
request and database read paths. The production read-only reader uses that same
wrapper without changing its transactions. Regression proof covers 83 parser
oracles, 218 raw Zod cases and 204 native HTTP comparisons including stored JSON,
private-marker objects, decimal rounding, overflow and underflow.

## Ticket pins, stream close and native values

Ticket assets use the existing shared table and advisory lock key, so native and
TypeScript writers share revisions even before a repository journal exists.
Tombstones retain older manifests and blobs; build pins resolve their recorded
revision after replacement or removal. Snapshot pins add a separate integrity
boundary: gzip manifests (including concatenated members), chunk digests, file
sizes and ticket identity must validate before a read exposes bytes. Hosted
readable IDs are an optional projection over canonical storage keys; absence of
the independently migrated ticket extension must not break build record reads.
Deployment request/response ceilings need a manifest response preflight before
publication, otherwise a refused response can hide a committed asset revision.

Streams keep the TypeScript JSONB string envelope for chunk parts, including
property order inside custom data. A row lock owns each chunk sequence. Close
reads and uploads without holding a transaction, then locks and rechecks the
chunk prefix before publishing its artifact and lifecycle together. A real
TypeScript append held inside a database trigger proved the race: close prepared
older bytes, waited behind the append, then reassembled after that append was
acknowledged. Failed uploads and deferred commit failures leave neither a closed
record nor consumed revisions/sequences. Creation prunes only older closed chunk
logs, retaining the newest closed stream and every open stream.

The AI SDK is also a state machine, not just a list of allowed part names.
Malformed defined parts are dropped; runtime processing errors stop the current
message segment while later start segments can still progress. Partial tool JSON
can legally materialize lone UTF-16 units from ASCII escape text. A Rust String
cannot represent those values. Typed raw fragments therefore carry the exact
encoded document alongside its inspection projection; no magic placeholder key
can collide with user data. Blob bytes preserve the SDK's escaped strings and
keys without lossy replacement.

Named values replay one authoritative event prefix in a read-only repeatable-read
transaction. They do not trust client-written public snapshots or private caches.
The unchanged shared suite is invoked through the real remote client, with a new
migrated database and blob prefix per factory, injected clock/retention, bounded
child cleanup and asserted test/factory counts. A green route smoke test cannot
replace this evidence.


## Native authority and production routing

Delegated credentials require two independent checks: authentic signed claims and
fresh durable lifecycle facts. They do not inherit a fixed token expiry or their
parent project's later credential revocation. Registration, anchor, execution,
session and runner suspension/release semantics instead decide each request.
Build suspension and harvest suspension differ. Authority guards also sometimes
clone and parse a request before its producer schema; moving them after schema
validation changes observable refusals, including source server errors.

Fetch header semantics matter at this boundary. HTTP obs-text is Latin1, and
repeated Authorization or release identity fields join with comma-space. Reading
only the first duplicate can accept a credential the TypeScript service rejects.
Signed payload verification uses its original encoded segment, not a re-encoded
object. Base64url token decoding is deliberately separate from canonical artifact
base64 validation.

The normal router selects the machine branch using the full URI before browser
cookie, origin and Proa middleware. Both branches retain independent gates;
unknown browser paths cannot acquire machine authority through a browser cookie.
Public protocol health bypasses backend I/O. Deferred read/write pools still
preflight every first or replacement connection, while readiness probes the
configured schema with a bounded wait. Production has no open-authority switch.

Dispatch evidence reads the exact generated build through the existing Rust
DataReader listing, reduced build state and ordered events, including a fresh
reader after restart. Per ruling esc_6370a20b, rendering that dispatched build on
the sibling Builds page remains a node integration check after file-131; shell
captures cannot substitute for it.

The scalar-string checkpoint exposed a real JavaScript/Rust boundary. JavaScript
JSON accepts escaped lone UTF-16 units; serde String cannot retain them. Lossy
replacement is unsafe for authority: PostgreSQL TEXT lookup can resolve the
replacement row while in-memory write comparisons must keep the original units.

## Lossless request, token and envelope values

The protocol now uses JsString code units and an ordered JsJson tree through
request validation, token claims, write preparation, responses, snapshot/stream
string envelopes, assets and SDK document assembly. Checked serde conversion is
explicit; replacement belongs only to source-specified UTF8/URL/PG TEXT
boundaries. Malformed HTTP UTF8 is replacement-decoded before JSON parsing, with
one leading BOM removed. Limits count the decoded UTF8 text, including expansion
of malformed bytes, rather than blindly counting the original request bytes.

General JSON parsing, cloning, equality, serialization and disposal use heap work
stacks. Valid nested data in a field that schema stripping later discards must not
terminate a worker. Pure tests use a 64 KiB thread, and real HTTP checks retain
source parity through 8192 nested arrays. The partial-tool parser remains a
separate policy: prototype filtering and JSON repair do not belong to general
JSON.parse.

PostgreSQL TEXT parameters use replacement encoding only at binding. JSONB
parameters preserve exact JSON escapes and let the server own rejection and
transaction ordering. Snapshots, stream chunks and ticket manifests have JSONB
string envelopes, so escaped lone units can survive storage. Stream close and
snapshot reads retain those values through their actual output bytes. Lease
expiry additionally needs JavaScript TimeClip and expanded-year ISO text before
PostgreSQL parses it; sending a native binary timestamp can accept a date the
source rejects. Node-writer release compares its holder in SQL, unlike execution
lease release's JavaScript comparison. Both distinctions have HTTP regressions.

`tools/protocol-utf16-diagnostic.ts` now runs equality regressions for the original
Unicode failures; the old known-divergence report remains historical evidence.
The full maintained gate includes independent Unicode schema/producer/token/date
oracles and native mutation, stream, asset, reducer and SQL-error comparisons.

A separate confirmed read-side gap remains. The TypeScript adapter's json()
helper also unwraps legacy JSONB string envelopes in event actor/payload/
compatibility, artifact metadata and build tickets. Raw event reads currently
expose some as literal strings, and persisted serde reducer/lifecycle facts
cannot yet retain an unpaired unit decoded from such an envelope. A future fact
with wrapped payload `{"x":"\\ud800"}` demonstrates the difference. The next
increment must carry the lossless model through these reads and facts; the
successful direct-JSONB scalar domain is not the entire shared-storage domain.
The standalone read-envelope diagnostic records this remaining scope explicitly,
rather than treating the green endpoint matrix as full conformance.


## Legacy JSONB envelopes require typed replay as well as typed HTTP reads

The read-side gap recorded above is now covered end to end. The source adapter
unwraps one JSON text layer at specific columns; a JSONB string can therefore
carry an escaped lone surrogate into a known event, even though a direct JSONB
object cannot store it. Native event, artifact and ticket reads now apply that
column-specific conversion and the source's outer-value truthiness. They preserve
inner strings after one parse and report Bun-compatible original-code-unit errors
for malformed inner JSON. Snapshots and stream chunks use the same parser.

All 42 named reducers now execute on typed persisted values. Permissive stored
payload projection remains separate from strict producer validation. Original
UTF16 dictionary keys survive build/repository accumulators, compound log/read
facts, restack aliases, named arguments and delegation facts. A lone-surrogate
session and a U+FFFD session remain distinct through issuance, authorization,
termination and verify-step deferral settlement. No replacement-key alias or
scalar reducer fallback is used.

The expanded actual HTTP proof covers 99 comparisons, including the original
four failures. Independent generated source oracles cover 4,103 persisted payload
cases, 25,112 replay cases across every named reducer and 1,342 JSON parsing
cases. The existing scalar replay corpus is also checked through the typed path.
The legacy diagnostic CLI now runs equality assertions; sanitized evidence is
`.ab/proa-protocol-read-envelopes/read-envelopes.json`. These proofs supplement,
not substitute for, the unchanged shared contract, authenticated dispatch and
production reader checks in the maintained gate. The Builds-page rendering check
remains deferred to node integration after file-131 by the approved ruling.


## Review round 2: presence authority, retention and route grammar

Delegated operator-presence GET must fail before reading any presence rows.
Repository ownership alone is insufficient. The native handler now refuses all
four delegated build/harvest kinds with the actual source's exact 403 text.
The source's POST authorization takes a different earlier path: build grants
receive `write outside delegated resource`, harvest grants receive
`write outside delegated harvest run`, and malformed harvest JSON fails parsing
before that denial. The review's claim that POST uses the GET-specific text was
not borne out by the actual source service. Regression evidence preserves these
source outcomes, instruments zero source presence lookups/mutations and compares
unchanged native presence rows. This avoids fixing the GET leak by introducing
a new refusal-text divergence.

Production retention now parses AB_ARTIFACT_RETENTION_MAX_REVISIONS with the
source positiveInt semantics and passes it into the machine Store. Mixed-writer
checks seed 205 revisions and verify both a small bound (2) and an override above
the default (500); a Rust write no longer prunes revisions the configured source
writer retains. Invalid values fail startup configuration. Very large accepted
JavaScript integers retain every realizable revision rather than overflowing a
native SQL offset.

Route decoding has two stages: the resource ID stays one decoded segment; generic
family operations join and re-split the decoded tail. Repository special routes
and top-level streams inspect the original decoded segments. The repository
existence gate now precedes unsupported reducer-values methods, so a missing repo
gets the source unknown-repo error. For an existing resource, valueRoute explicitly
returns the abbreviated `no route: GET reducer-values`; the review's proposed
pathname wording differs from that source implementation. Actual source/native
regressions cover both outcomes and encoded-tail operations without changing
product protocol or client sources.

## Reconcile: machine namespaces and browser build detail

The machine protocol owns every `/builds/*` request, including requests accepting
HTML. Browser detail moved to `/dashboard/builds/:slug`; dashboard links and all
capture variants use that path. Cookie authentication, SSR and live refresh remain
on the browser branch. The seeded capture asserts both JSON machine refusal and
rendered detail HTML, alongside the router regression. The upstream live dashboard
and its 24-frame matrix coexist with the full native protocol gate.

## Tickets and connect: crossing the CLI/browser boundary

A connection request spans two independent credentials: a CLI-held capability
and a freshly admitted browser session. Proa's synchronous rendering works well
when the handler loads the durable request once and passes a value to
`WebRenderSync`; HTML rendering performs no database I/O. Native forms carry a
CSRF token, canonical code and explicit decision. The page never serializes the
capability, credential digest or secret, and the displayed grouped code is
separate from the submitted canonical code. The existing sign-in return-path
validator retains `/connect?code=...` through authentication.

The shared database, rather than the component lifetime, joins the steps.
`tools/connect-persistence-integration.ts` reproduces native-start/TypeScript-
approve and TypeScript-start/native-approve, process restart, revocation,
expiry, collision rollback and approval/cancel races. It authenticates prepared
credentials using the unchanged TypeScript adapter. This evidence is separate
from browser rendering and does not substitute for the CLI/browser proof.

The HTTP boundaries need three admission paths. Public capability endpoints
skip release headers and cookies. Status/revoke authenticate the project bearer
freshly. Browser JSON lookup/decide check canonical Origin and current session
admission, returning JSON errors; ordinary HTML forms use the existing browser
origin layer plus CSRF. Sending all these through either the browser gateway or
BuildStore authorization would impose the wrong contract. The capture seed
creates real requests and terminal decisions through the shared TypeScript
connection store; it does not manufacture page view models. Approval remains
project scoped: the reference's organization picker is deliberately omitted.

The first expanded capture caught a clock-fixture defect: looking up a pending
request with a future clock and then resetting the clock does not durably expire
it. The browser correctly showed pending again. The expired capture now starts
the real request eleven minutes in the past, so its stored expiry is already
past when the normal server reads it. Backend-failure capture uses a separate
normal server with storage unconfigured, rather than a fabricated error model.

Review exposed a request-lifetime mismatch in the machine ticket/connect path:
constructing a deferred writer in every handler reloaded TLS roots and discarded
its connection after each poll. The machine database now owns one shared writer,
so its existing reconnect/preflight boundary survives across requests. This does
not cache credentials, policy or grants: those still read current database state.
The writer lifetime regression test checks shared ownership across successive
requests; the normal HTTP and CLI proofs exercise the retained connection.

## 2026-10-25 — MCP and native OAuth

The Rust connector now has its own discovery, dynamic registration, PKCE,
operator consent, token/refresh and public JWKS boundaries. The OAuth migration
owns a separate schema and never advances the product migration identity.
A single locked state row makes code consumption and refresh rotation atomic
across processes. This reduces implementation surface at the cost of serialized
OAuth writes and MCP grant admission; it needs workload measurement before any production adoption.
Signing keys are encrypted with the stable session secret, while opaque grants
are indexed by digests. MCP rechecks resource, expiry, active grant and the email
allowlist on every request, then invokes the existing native operator HTTP router
with a short-lived attributed token. No Bun process serves production requests.

The executable oracle exposed an SDK asymmetry: union tool descriptions can carry
an empty object input schema even though execution validates the original union.
The corpus captures both. It also pins null-ID parse failures and tool-content
schema errors rather than guessing from JSON-RPC alone. Time correspondence in
native note/control replay is tied to unchanged TypeScript store readback; actor,
sequence, schemas and refusal text remain comparison data.

A real Claude Code 2.1.310 session, with only Proa MCP tools, used the installed
operator skill to discover repositories, list builds, read a blocked build,
answer its escalation, create a ticket and read back its writes. The driver
independently parsed/reduced Rust-written events and checked the consenting
operator's exact MCP attribution. A successful final session took under a minute
on this host. Earlier proof runs exposed missing test-seed effective config and
an outdated ticket readback column; those are harness corrections, not client
success evidence. Only the passing sanitized report/transcript was deposited.

The final capture contains 96 frames, all opened for visual review, including
28 consent states across two widths and themes. Native browser forms proved both
cross-origin acceptance (code exchange and MCP admission) and denial. The first
browser proof exposed self-only CSP blocking callback redirects after a form
POST; consent now adds only the stored, validated callback origin to form-action.
Other pages keep the original self-only policy. Capture compilation precedes
seeding so an occupied build queue cannot expire short-lived pending grants.
The differential MCP corpus covers 126 cases across all 33 advertised tools.
The single-row OAuth transaction also serializes MCP grant admission, not just
code/refresh consumption; it proves atomicity here, not production throughput.

## Proa node synthesis

The earlier entries record the node's measurements: a 24GB cold linked target
cache, roughly 20–26 seconds per warm linked stage in one run, and local browser
poll/live-update probes of 76/29ms in a focused run. These are local observations,
not deployment latency or throughput promises. Native Rust, TypeScript fixture
replay, database protocol tests and browser/pixel captures test distinct seams;
one cannot substitute for another. This increment adds real SDK and model-client
evidence to the existing store, ticket, connection and control evidence.

Proa's synchronous rendering fits the ANSI shell and ordinary forms without
client islands. Axum makes the browser, machine protocol and OAuth boundaries
explicit. The cost is compatibility maintenance: JavaScript number/string
semantics, schema errors, reducer versions and framework linked builds all need
executable oracles. OAuth introduces another persistent schema and credential
lifecycle to maintain. The experiment remains a candidate, not a shipped server;
its serialized OAuth store, in-memory browser-session lifetime, cold linked-build
cost and operational key rotation need consideration before adoption. My judgment
is that rendering and native protocol reuse fit; the accumulated parity machinery
and operational burden are material costs, not evidence that migration is free.

## 2026-10-25 — refreshing the TypeScript oracles after node integration

This is maintenance of the repository experiment. The refresh started at
22:41 UTC from `7ec03b79c71f2c3e03c4b897e613c8983838090a`, the integrated
Proa node over TypeScript main `b140507a`. The initial tooling run found
27 failures and one loading error, rather than treating the historical node's
26 failures as a new measurement. Installing the existing locked dependencies
resolved the missing local S3 dependency.

The actual drift included #747's removed hosted runner (obsolete config imports,
validation and HTTP session wake inheritance); #748's verify configuration pins,
cycle boundaries and grouped-stage serialization; #751's publication retry
ledger; and #755's presence withdrawal and protocol 6 identity. #750's publication
policy and #752's orderly handoff behavior changed the pinned source closure;
existing native replay/attention boundaries are retained and checked against the
new source-produced cases. #754 adds stage serialization regression coverage.
The older super-user environment rename also exposed stale MCP seeds: the oracle
now injects the source's explicit test access adapter and uses the current
super-user setting, without consulting a production organization database.

Every tracked fixture family was regenerated through its own tool. The base
capture produced 19,642 provenance aliases in 6,003 distinct cases, including the
actual dispatcher-upgrade and reducer tests. Subsidiary generators include all
42 named reducers, 4,195 persisted Unicode payload cases and 25,814 persisted
replays. MCP retains the real SDK descriptors, original execution schemas and
all 33 tools. The base capture took about eight and a half minutes; the first
39 subsidiary invocations took 14.7 seconds. MCP needed a second invocation
after control generation because its positive seed reads `control-corpus.json`.
This dependency is now documented. No expected response bytes were edited by
hand; repository formatting was applied to generated JSON.

Native repairs cover both scalar and lossless verify-stage/log-index/publication folds,
including member ownership, cancellation/superseded escalation state and running
member projection; captured artifact revisions in read/dashboard/landing projections; grouped-stage
normalization and duplicate diagnostics, inert HTTP session creation, and exact
scoped presence deletion. New executable cases cover older pinned config versus
a newer deposit, superseded receipts, stage groups and removed config fields,
encoded/trimmed IDs, idempotence, neighboring rows, delegated/project refusal
and identity-before-auth ordering. Historical persisted runner facts still
replay. The established ticket-attribution exception remains; no new exclusion
was introduced.

The first complete native gate also exposed an obsolete database seed: direct
TypeScript connection approval now requires a browser principal. The persistence
proof supplies an explicit super-user principal and a registered project; capture
does the same for its approved state. This retains the experiment's existing
project-scoped approval boundary (the earlier connection entry deliberately
omits organization selection) while using the current store API. The focused
PostgreSQL/S3 interchange proof passed after that seed correction.

The integrated head also includes #736's concurrent verify/fail-fast contract,
which the original native state had not yet carried. Beyond the paired stage
folds, guidance now rechecks cancellation and uses compare-and-append, and a
concurrent spec revision revalidates retained authorization at publication.
The failure oracle's old `append` interception no longer exercised guidance's
conditional write; it now intercepts both actual write paths and requires the
injected publication error to occur. A new source/native case refuses a
cancelled verifier without mutation. The focused operator aggregate passed all
eight answer-failure cases and complete route/action/schema coverage. A ticket
HTTP helper's remaining protocol-5 literal was replaced with the source protocol
constant. The unchanged 161-test BuildStore contract and all protocol, ticket
protocol and real ticket CLI family proofs passed in focused runs.


Final validation used frozen code `ef12f1e8`; the following commit only records
these measurements. Root checks, build checks and typechecking passed. Two full
unit runs with the normal temporary directory each passed 8,453 tests with 49
existing skips and zero failures (1,123.06s and 1,121.08s). All 123 experiment
tooling tests passed after the last repairs. The complete native gate passed all
61 stages in 1,318.4s: Cargo tests took 320.6s, linked Proa tests 436.6s, and the
release build 291.4s (0/481 cached artifacts reused). This includes independent
freshness checks, scalar/lossless replay, real database/S3 interchange, all 161
BuildStore contract cases, operator/MCP, protocol and ticket/CLI proofs.

The final offline capture build took 188.3s, reusing 479/481 artifacts in each
linked stage. Capture and browser mutation/consent proofs passed; all 96 PNGs
were opened against the immutable ANSI reference across both themes and widths.
Palette, two typefaces, shell/menu, responsive wrapping, refusal drafts and
confirmation states remain intact, with no visible horizontal overflow. Evidence
is retained locally under `.ab/proa-frames-4Zu2B6` and
`.ab/proa-refresh-evidence`; neither is a tracked deliverable.

The measured refresh window was 22:41:02 UTC to 00:18 UTC the next day, about
97 minutes including verification, queue waits and interrupted-session recovery.
The first repair commit was at 23:06:40 (25m38s after starting, overlapping corpus
generation/checks); later seed and conditional-write repairs continued until
about 23:48. There was no exclusive active-work stopwatch, so these intervals
must not be read as additive repair time. An earlier cold linked Proa test pass
took 892.5s; verification dominated elapsed time. Capture waited roughly 22 minutes
behind the serialized native gate across a shutdown/restart; that wait overlaps
the gate, rather than adding another 22 minutes to the window.

Operational retries also consumed time: an initial root run exhausted `/tmp`
inodes. A mistaken long worktree-local TMPDIR retry broke Chromium Unix socket
paths and fixture module resolution; it was cancelled and both normal-environment
runs passed. An early capture was correctly stopped when sources changed during
linking. Shutdown recovery regenerated phase scratch, recovered surviving logs
and reran the interrupted capture build. These are measurement/harness costs,
not semantic parity repairs or deployment performance claims. Dependency versions,
product code, existing exclusions and ANSI reference bytes remain unchanged.

Post-restack unit recheck (2026-10-26 00:40–00:59 UTC): verification of
`bf80b3f1` returned one failure in the unrelated website Markdown-copy browser
probe, with no assertion diagnostic in the deposited report. On that unchanged
head the isolated probe passed in 10.56s, and the complete root unit suite passed
8,453 tests with 49 skips and zero failures in 1,022.94s; the same browser probe
passed in 10.58s within that run. Root lint, package/build checks and typechecking
also passed. No cause is established and no implementation or oracle change was
made for this feedback round. Observation `obs_9f8a0a37` records the recurrence
investigation outside this experiment's scope. This adds approximately 19 minutes
of recheck time after the original refresh window; prior native/capture evidence
remains for the unchanged experiment code.

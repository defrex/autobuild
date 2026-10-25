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

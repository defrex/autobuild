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

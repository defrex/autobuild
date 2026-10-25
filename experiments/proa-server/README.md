# Proa server experiment

Nonshipping Rust/Proa experiment, version 0.1.0. Builds and build detail read the shared TypeScript-owned store through native Rust projections, with GitHub operator sign-in and read-only live updates.

The visual authority is [design/ansi](design/ansi/README.md), pinned ticket asset
**design / ansi / revision 1000000000**, including its reference HTML, 24 screenshots
and product briefs. It overrides the repository-root DESIGN.md for this experiment.
The reference's synthetic records and external font links are reference material;
the application serves its own fonts and displays the admitted operator email.

Prerequisites:

- rustup and Rust **1.99.1**, with rustfmt and clippy (rust-toolchain.toml selects it).
- Proa CLI **0.1.3**: `cargo install proa-cli --version 0.1.3 --locked`.
- Bun (validated with 1.4.4) for local Tailwind **4.3.1** and @tailwindcss/cli **4.3.1**.
- A native compiler/linker, C build tools and pkg-config for Rust dependencies
  (validated on Linux with GCC and GNU ld). PostgreSQL TLS uses Rust TLS
  with the host trust roots; no dynamic OpenSSL library is required.
- An installed local PostgreSQL cluster for the full Rust gate. The gate starts
  an existing cluster and provisions its own disposable database and local S3 service.
  Seeded capture also uses isolated local PostgreSQL/S3; it never reads the production database.
- Chromium for manual visual captures (this host uses `/usr/bin/chromium`).

From this directory:

```sh
bun install --frozen-lockfile
export PATH="$PWD/node_modules/.bin:$PATH"
proa dev --no-restart
# Or build and run the production executable:
proa build --locked --artifact-out target/release/proa-server
proa start
```

Both Proa dev and build regenerate ignored `public/styles.css` using the local
Tailwind CLI. Do not install Tailwind globally or commit compiled CSS. Cargo.lock
pins Rust resolution; use `--locked` for builds and tests.

Default binding is `127.0.0.1:3000`. Set `PORT=4567` to change the port and
`PROA_HOST=::1` to change the IP address. Invalid/zero ports fail explicitly.
`GET /health` returns JSON with status and the crate version. `/readyz` is the
scaffold readiness endpoint. `/?project=<id>` selects a configured project; `/builds/<slug>?project=<id>` reads its build trail. `/refresh` returns changed SSR fragments and `/frame` resolves scoped stored image references. `/index.md` and Markdown content
negotiation expose its textual representation. Assets are under `/static/`.

```sh
proa fmt --check --verify src
proa lint src --deny warnings
proa test --locked
cargo test --locked # fast non-linked config/router/representation checks
proa build --locked
```

Run repository checks from the repository root as required by AGENTS.md. The local
Biome config inherits root rules while excluding the immutable reference and the
Tailwind directive entrypoint. Authored CSS, JavaScript and JSON remain checked.

Theme follows the OS until Light or Dark is chosen in the account menu. Explicit
choices persist in localStorage; System removes the override. With storage disabled,
the current page still honors explicit choices. The disclosure uses ordinary Tab
navigation, closes on Escape/outside activation/focus departure, and returns focus
to its trigger on Escape or theme choice.

Font sources: Google Fonts' `ofl/atkinsonhyperlegiblenext` and `ofl/jetbrainsmono`
directories at https://github.com/google/fonts (downloaded 2026-10-24). The shipped
variable TrueType files cover Atkinson Hyperlegible Next 200–800 and JetBrains Mono
100–800, including the used 400/600/700 and 400/700 weights. Both are licensed under
the SIL Open Font License 1.1; full licenses are adjacent in `public/fonts/`.
No application asset or font is requested from a third party.

Automated Rust and visual gates are described in [tools/README.md](tools/README.md).
They capture the actual server and share ordinary Cargo artifacts across worktrees.
Proa linked dependencies still rebuild for a new worktree; see the field notes.
See [FIELD-NOTES.md](FIELD-NOTES.md) for measured tooling behavior.

## Operator sign-in

Without auth settings the default loopback server starts closed: protected pages,
including Markdown and unknown paths, redirect to sign-in. Public resources are
health/readiness, fixed static assets, sign-in and the GitHub flow.

Set these together for GitHub sign-in:

- `PROA_AUTH_URL`: canonical origin (e.g. `https://operator.example.com`).
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: GitHub OAuth App credentials.
  Register `<PROA_AUTH_URL>/auth/github/callback` as the callback.
- `PROA_SESSION_SECRET`: at least 32 high-entropy characters.
- `AB_WEB_ALLOWED_EMAILS`: comma-separated emails, trimmed and case-insensitive.

Non-loopback binding requires complete GitHub configuration and an HTTPS origin.
Terminate TLS at a trusted reverse proxy; this executable's listener speaks HTTP.
Forwarded and Host headers do not select the canonical origin or cookie policy.
On loopback the origin must match the listener's IP and port. Invalid origins,
allowlists, short secrets and partial GitHub settings fail startup.

Admission uses GitHub's verified email records, preferring an allowed primary email.
The session keeps only the chosen email and random CSRF token. The allowlist is
read again on every protected request; removal refuses and revokes that session
on its next request. Environment updates from a supervisor require process replacement,
which also invalidates all sessions. Tests inject a mutable source to prove next-request
removal. Sessions expire after eight hours and live only in this process (4096 maximum);
restart logs everyone out, and replicas cannot share sessions. OAuth transactions expire
after ten minutes (4096 maximum). Cookies contain signed opaque random IDs, are host-only,
HTTP-only, SameSite=Lax, Path=/, and Secure off loopback or with HTTPS loopback.
POST sign-out requires the session's CSRF token and canonical Origin (same-origin
Referer fallback); it deletes the server record so copied cookies stop working.

OAuth uses state, a separate browser-binding cookie, single-use transactions and
S256 PKCE. Provider tokens are discarded after the bounded email lookup. Only safe
origin-relative return paths are honored; malformed encodings, encoded separators,
backslashes and auth-route returns fall back to /. Auth and personalized responses
use no-store. OAuth pages use no-referrer; signed-in pages use same-origin so browser form POSTs retain their Origin proof. The router explicitly applies Proa's security and
cross-origin layers: CSP restricts scripts/styles/fonts to self, denies objects and
framing, and restricts forms/base to self; nosniff and frame denial cover all routes.
HSTS is enabled only for a configured HTTPS origin.

For local development or deterministic capture, additionally set
`PROA_ENV=development PROA_DEV_AUTH=true`, `PROA_DEV_AUTH_EMAIL` (one email),
and `PROA_DEV_AUTH_CAPABILITY` (a freshly generated random value of at least 32 characters).
A session secret and allowlist remain required; GitHub credentials are optional.
POST `/auth/dev-session` with `X-Proa-Dev-Capability` issues the configured identity
only after checking the actual loopback socket peer. There is no identity parameter.
A denied identity renders the real refusal page. Missing peer/capability or a
cross-origin browser request is denied. Issuance is absent unless explicitly enabled;
non-loopback/deployment-mode dev auth fails startup. Never expose the capability
in browser HTML. Development issuance uses an Axum ConnectInfo serve adapter with
SIGINT/SIGTERM handling and a 30-second drain, because Proa's serve helper does not
supply socket peer metadata. This path uses the exported binary and does not provide
Proa's development reload injection.


## Native data boundary

With no database/blob environment the server starts its offline shell. To initialize
`AppState.data`, set `AB_POSTGRES_URL` (or `DATABASE_URL`) and the blob variables used
by the TypeScript service. Partial configuration fails. Schema version 17 and its
checksum are checked before the listener binds; unknown versions refuse startup.
The reader performs SELECTs in read-only transactions and never initializes schema,
writes events or reads snapshots.

S3: `AB_BLOB_BACKEND=s3`, `AB_S3_BUCKET`, `AB_S3_REGION`,
`AB_S3_ACCESS_KEY_ID`, `AB_S3_SECRET_ACCESS_KEY`; optional `AB_S3_ENDPOINT`,
`AB_S3_SESSION_TOKEN`, `AB_S3_FORCE_PATH_STYLE=true|false`. Vercel:
`AB_BLOB_BACKEND=vercel`, `AB_VERCEL_BLOB_ACCESS=public|private`, and either
`BLOB_READ_WRITE_TOKEN` or both `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`.
`AB_BLOB_PREFIX` is shared by both backends and normalized exactly as in TypeScript.
See [the pinned provider contract](BLOB-CONTRACT.md).

The library exposes project/build/session metadata, scoped artifact bytes, and
finished build, repository and session reductions through `data::reader::DataReader`.
Accumulators and sequence cursors survive across requests within the process;
restart or eviction replays durable logs. Unknown or malformed build facts produce
an unreadable build while healthy neighbors remain available. Repository and
session read failures are explicit at their own scope. No public data route is added.

From this directory, `bun tools/generate-fixtures.ts` executes the scripted core
scenarios and compatibility producers and regenerates the corpus with current
TypeScript reducer answers. `bun tools/check-fixtures.ts` independently checks
source/catalog freshness and re-reduces committed logs without rewriting them.
The losslessly compressed `fixtures/corpus.json.gz` contains logs and oracle
answers; `fixtures/manifest.json` lists producers, versions, catalogs and source
hashes. Identical scope/log inputs share one case with every origin retained as an
alias. Rust parity compares full and chunked replay, including prefixes and empty
suffixes.

Unreadable append-only scopes cache their deterministic decoding failure until cache
clear or restart. Repeated polls return that same scoped error without fetching the
failed suffix or any later appends; successful neighboring scopes keep advancing.
Closed PostgreSQL pool connections reconnect on subsequent reads and pass the same
read-only schema preflight before reuse. A disconnect during a query can still
fail that request; subsequent polls retry with a replacement connection.

## Dashboard reads

The first configured project is selected by default. Project ids in links and the
native selector are validated against the project registry; detail lookups stay
inside that project. Every normal GET is a complete snapshot with scripting off.
A two-second progressive refresh has one request in flight, keeps the last good
content on failure, and returns 304 for unchanged models. Build and transcript
cursors are independent. Immutable artifact bytes have a bounded process cache.
No TypeScript runs inside the server, and no page writes lifecycle state.

The offline TypeScript projection oracle is regenerated with
`bun tools/projection-fixtures.ts --write` and checked without writing by
`bun tools/projection-fixtures.ts`. Whole logs, corpus prefix boundaries, session
stream metadata and tree composition are compared by native Rust tests.

A JSON verify report can attach stored frames with
`frames: [{kind, rev, mediaType, caption?}]`. Only PNG, JPEG and WebP artifacts are
served; `/frame` accepts a selected project/build and a report frame index,
never a blob URL or arbitrary artifact reference.

Dashboard discovery is one batched metadata query returning changed/new/deleted
records, with durable event sequence checks independent of timestamps. Unchanged
build facts are reused; only visible builds and their required ancestors read
stream or pinned-config metadata. Closed stream records and pinned config at an
unchanged build cursor are retained. Cold startup still reduces each build once
to determine visibility. Metadata queries are included in capture's SQL evidence.
Artifact misses use per-object single flight, so a slow download does not block
unrelated cache hits. Row callouts show the shared three-row preview, retaining
paragraph breaks and linking to the complete detail text.

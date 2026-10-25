# Proa server experiment

Nonshipping Rust/Proa experiment, version 0.1.0. Only the Builds placeholder is
implemented. A read-only native data library connects to the TypeScript store;
no page reads it yet, and there is no account or authentication connection.

The visual authority is [design/ansi](design/ansi/README.md), pinned ticket asset
**design / ansi / revision 1000000000**, including its reference HTML, 24 screenshots
and product briefs. It overrides the repository-root DESIGN.md for this experiment.
The reference's synthetic records and external font links are reference material;
the application serves its own fonts and uses neutral experiment identity.

Prerequisites:

- rustup and Rust **1.99.1**, with rustfmt and clippy (rust-toolchain.toml selects it).
- Proa CLI **0.1.3**: `cargo install proa-cli --version 0.1.3 --locked`.
- Bun (validated with 1.4.4) for local Tailwind **4.3.1** and @tailwindcss/cli **4.3.1**.
- A native compiler/linker, C build tools and pkg-config for Rust dependencies
  (validated on Linux with GCC and GNU ld), plus OpenSSL development libraries.
- An installed local PostgreSQL cluster for the full Rust gate. The gate starts
  an existing cluster and provisions its own disposable database and local S3 service.
  Offline shell development and capture need no database or credentials.
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
scaffold readiness endpoint. `/` is Builds; `/index.md` and Markdown content
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

Theme follows the OS until Light or Dark is chosen in Experiment menu. Explicit
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
Rust parity compares full and chunked replay, including prefixes and empty suffixes.

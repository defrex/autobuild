# Proa server experiment

Nonshipping Rust/Proa experiment, version 0.1.0. Only the Builds placeholder is
implemented; there is no database, account, authentication or dispatcher connection.

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
  (validated on Linux with GCC and GNU ld). No database or credentials are needed.
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

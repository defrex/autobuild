# Proa application instructions

- Use `WebRenderSync<L>` unless a component awaits; then use `WebRender<L>` and `html!`.
- Put request-shared keyed reads behind `cx.load_typed(...)` and create one `DataResolver::request_scope(...)` per HTML response.
- Keep `RootDocument` HTML-only. Put semantic non-browser output on the page with `MdRenderSync`.
- Static classes stay in constants and hot render paths must not allocate.
- Every component root has a stable `data-*` marker.
- Run `cargo fmt`, `cargo test`, `proa check`, and the Proa performance lint before merging render changes.

## Experiment boundaries

This is the nonshipping Proa server experiment. Keep changes under this directory.
The immutable ANSI asset at design/ansi (revision 1000000000), rather than root
DESIGN.md, governs both grounds, typography, shell and menu. Preserve the reference
bytes. Prose uses local Atkinson Hyperlegible Next; machine values use local
JetBrains Mono. Do not add synthetic accounts or pretend data is connected.

Install with `bun install --frozen-lockfile`, then export
`PATH="$PWD/node_modules/.bin:$PATH"` before Proa commands. Tailwind is local.
Run `proa fmt --check --verify src`, `proa lint src --deny warnings`,
`proa test --locked`, `cargo test --locked` and `proa build --locked`.
Keep Proa accessibility checks enabled. Root repository checks also apply.
Record discoveries and reproducible defects in FIELD-NOTES.md. Capture tooling and
verify configuration are separate sibling work, not part of this shell.

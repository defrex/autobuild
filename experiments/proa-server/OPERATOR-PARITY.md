# Operator port checkpoints

This is the nonshipping Proa experiment. The operator-controls build is being
implemented in committed checkpoints under operator guidance `esc_14572852`.
These checkpoints do not relax the approved contract. Do not call `ab done` until
the entire operator HTTP and browser surface and all interoperability evidence
are complete.

## Native foundations

The first checkpoint adds source-pinned TypeScript HTTP oracle fixtures, a
separate native write connection, API identity/authentication primitives, and
session ownership/approval/archive policies. The existing server still exposes
its read-only browser dashboard: these library primitives are not yet public
operator routes or browser mutations. The SELECT-only reader pool stays separate.

`tools/operator-fixtures.ts --write` regenerates the oracle corpus from the
actual TypeScript service. Without `--write` it checks source and behavioral
drift. The corpus records the complete route/action/answer/tool inventory and
explicit missing coverage. A refusal witness is not proof of a successful
control's semantics. Rust policy tests replay the session subset; the native
integration driver reads actual Rust-produced writes through the TypeScript
store and event validators. Neither substitutes for the final real-HTTP replay.

## Attribution exception

Ticket-row mutations must preserve TypeScript storage parity and still enforce
the same authentication and authorization. They are an explicit exception to
`docs/operator-api.md`'s claim that owner-purpose credentials attribute every
write. Observation `obs_675b94d9` records this gap. Guidance forbids inventing a
ticket audit record, repository artifact, or schema in this build. A durable
ticket-attribution contract requires a maintainer product-design decision.
Build and repository facts retain human identity and optional transport `via`;
session facts name the signed user and never carry `via`.

## Remaining completion gates

- Wire and replay the real HTTP API: identity admission before auth, project
  isolation, strict bodies and exact TypeScript errors; finish delegated lifecycle
  validation and credential issuance seam.
- Complete API read projections, artifact revisions and bounded session streams.
- Complete build controls, landing guards, restack and all answer variants,
  including blob/artifact publication and spec/asset rules.
- Complete settings/intake, ordered partial bulk operations and harvest controls.
- Complete native hosted ticket policy, row locks and revision-checked mutations.
- Complete the generic HTTP tool registry face through the same domain handlers;
  MCP transport remains out of scope.
- Add authenticated browser forms with CSRF/origin checks, inline refusals,
  destructive confirmation and polling-safe progressive enhancement; no web
  landing controls or ticket authoring pages.
- Establish full Rust HTTP differential results and ordered native write/reducer
  parity, complete producer-validation negative cases, concurrency/failure/restart proofs, isolated dispatcher pause/resume
  evidence and the control-state capture matrix in both grounds and widths.
- Record measured Proa forms/mutations experience in FIELD-NOTES.md; run every
  required root/native/tooling check and visually inspect every captured PNG.

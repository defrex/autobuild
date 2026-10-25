# Operator port checkpoints

This is the nonshipping Proa experiment. The operator-controls build is being
implemented in committed checkpoints under operator guidance `esc_14572852`.
These checkpoints do not relax the approved contract. Do not call `ab done` until
the entire operator HTTP and browser surface and all interoperability evidence
are complete.

## Native foundations

The first checkpoint adds source-pinned TypeScript HTTP oracle fixtures, a
separate native write connection, API identity/authentication primitives, and
session ownership/approval/archive policies. At that checkpoint the server still exposed
only its read-only browser dashboard; those library primitives had no public
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

## Native HTTP and browser checkpoint

The follow-up identity gap is fixed: TypeScript-generated ECMAScript trim cases
include U+FEFF, U+0085, empty-after-trim and retained interior whitespace. Native
session creation stores the normalized owner and the same creation actor.

The server now exposes bearer sessions, build controls/answers/restack,
intake/bulk/harvest mutations, hosted tickets, build lists, artifact bytes and
session-turn streams. Browser controls use the same native policies, fresh cookie
admission, CSRF and canonical origin; the separate reader remains SELECT-only.
`PROA_POSTGRES_WRITE_URL` can select a distinct writer role. API routes have their
own identity/auth layer and bypass browser redirects and origin middleware.

The current executable proofs cover 77 real HTTP build/repository control cases,
35 real HTTP session cases, list scopes, binary artifact revision boundaries,
open/closed session streams, and TypeScript validation/reduction of native facts.
Ticket proof checks native PostgreSQL rows, revisions, blocker batches, concurrent
writers, restart readback, bearer HTTP writes/revocation, and claimed-node parent
reservations against the actual TypeScript operation. Source-derived request
schemas compare successful outputs and exact Zod refusal strings. Delegation
issuance has 16 oracle/native policy cases, including exact signed token bytes.
These are bounded claims, not proof of the entire operator contract.

S3/Vercel artifact uploads precede SQL publication. Vercel upload wire tests cover
both auth modes and failure privacy. The pinned provider contract is recorded in
BLOB-CONTRACT.md. Native API/domain code never invokes TypeScript.

Browser forms offer guidance/retry/dismiss, extended answer options,
pause/cancel-pause/resume, explicit abort/discard confirmations, intake/bulk and
harvest controls. JavaScript uses the same forms with SSR fragments and polling
coordination. No browser landing controls or ticket authoring pages are added.
The capture and end-to-end browser proof remain mandatory before completion.

## Remaining completion gates

- Complete API read projections: build detail/dashboardRow, dashboard, repository
  status and harvest status, durable config validation and typed corrupt-config
  errors, complete runtime attach provenance and cleaning visibility.
- Complete the generic HTTP registry route through the same native operations;
  MCP transport remains out of scope.
- Complete node landing live ticket completeness and hosted spec/asset repinning,
  and audit all answer transaction/race guards against the TypeScript helpers.
  Multi-escalation prefixes, terminalization during preparation, retry recovery,
  node fences and failed artifact publication need dedicated seam evidence.
- Match configured session creation wake inheritance and exercise bounded
  stream waits over real HTTP.
- Replay delegation issuance over real HTTP with durable credential/lease/session
  state; pure issuance token parity and separate lifecycle tests are not that proof.
- Expand control/ticket differential coverage to all route/action/answer variants,
  compatibility fixtures, failure injection, stale races and ordered partial bulk
  progress. Do not treat positive leaf control cases as node-control coverage.
- Establish the isolated real dispatcher pause/resume proof and terminal dashboard
  evidence. This checkpoint does not run any live repository dispatcher operation.
- Finish browser JS/no-JS mutation proof and inspect all 40 control-state frames
  at both widths and grounds. Run every required root/native/tooling gate.

`ab done` remains forbidden until every approved acceptance criterion is covered.

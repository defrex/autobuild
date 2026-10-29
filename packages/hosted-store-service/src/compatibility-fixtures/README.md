These decoders are frozen from v0.9.0 (commit
58268333ad4e2ea4b37f86a9086ec1324417623f). Runtime schema dependencies are
frozen too; the store's type-only artifact metadata imports have no decoding
behavior. Only import paths and formatting differ from the tagged files.

Sources: `packages/core/src/store/remote/protocol.ts`,
`ports/tickets/remote-protocol.ts`, `operator/protocol.ts`, and the actor and
ticket-reference schemas in `events/envelope.ts` and `ontology.ts`.

Compared with v0.10.0 (a405f25aafcbb04e98be9e2d5296e4259c5c9e75): ticket and
operator schemas and the hosted operator client's request methods are unchanged.
The store adds optional snapshot/high-water routes; its pre-existing schemas
and requests are unchanged. The contract suite runs both historical identities
through the common frozen baseline. It sends the requests used by the tagged
remote store/ticket clients (JSON envelopes, query parameters, bearer token and
protocol 3 headers) and decodes actual responses. Historical operator clients
cast successful JSON without runtime validation; their strict error decoder and
control request schemas are frozen here.

The current store adds optional digest fields, ignored by the historical loose
object decoder. Current ticket responses add `resolved` and `blockersResolved`,
which both historical strict decoders reject; the server projects those fields
away for both lines. Operator success responses do not use that strict ticket
decoder and need no projection.

Compared with v0.11.0 (a267bda6391e90bf760577032a74eec0e3d3d95b), reviewed
for the v0.12.0 line: wire changes are additive (an optional `context.repo` on
ticket requests, a separate delegate-credential route, and a new
`dispatch-failure-limit` escalation cause). v0.11 clients decode the
resolution fields, so only v0.9 and v0.10 receive that projection. From v0.12.0 the
window is v0.10 through v0.12; the v0.9 fixtures stay as v0.10's frozen
baseline, and the contract suite derives the lines it exercises from the
installed version's window.

Retain these contracts while these lines are in the published service window.
When adding or retiring a line, deliberately review the tag differences and
update fixtures, the protocol identity table, and boundary projections together.
Tests do not fetch tags or packages at runtime.

The published v0.12.0 (0b73beec4b0b81a5dd55d7b0933e0281e431bbf6) ticket
decoder and its runtime ticket-reference dependency are frozen separately in
`tickets-v0.12.ts` and `identities-v0.12.ts`. The v0.11.0
ticket and listing decoders are byte-identical to this v0.12.0 baseline.
The ticket-server seam tests exercise both identities with this decoder.
Comments require explicit capability header `x-autobuild-ticket-comments: 1`,
independently of version; clients without it retain their historical shape.

The v0.13.0 ticket protocol is frozen in `tickets-v0.13.ts` from
2f0923645d4541d29f9f9124cb55d660114c1585. The v0.14.0 protocol
(0f37a7888e769984ca2ea145a7b1ce7cf8178b0d) is byte-identical.
Their ticket-reference decoder is unchanged from the frozen v0.12 dependency.
These clients send revision and comment capabilities, but no tree capability;
contracts exercise populated node/target records through get, list, creation-key
adoption and legacy updates while retaining strict tagged decoders.

The next-minor 1.1/protocol-6 preparation retains published v1.0.0/v1.0.1
clients on protocol 4. `store-v1.0.ts` freezes the standalone lease, repository
position and tick-begin decoders verbatim from v1.0.1
(f934de5144992084884909a5faeb6826a6b61fb5); these declarations are identical in
v1.0.0. They have no runtime dependency beyond zod. The contract suite exercises
those published requests against an explicit 1.1.0/protocol-6 service identity
without modifying package versions, and rejects invented 1.0/protocol-5/6 peers.
Protocol 5 was unreleased. Older 0.x fixtures remain for their existing explicit
historical seam tests; they are outside the 1.x service's supported window and
are not claimed as admitted clients.

The 1.2 preparation retains published v1.1.x clients on protocol 6. The
remote store protocol identity is unchanged from v1.1.0
(8d98e5255ad9b191c3215c7def930c57f9ec4bbc) to the 1.2 line, so the current
decoders are the v1.1 wire contract and no separate fixture is frozen yet.
Freeze v1.1 decoders here when a later line changes protocol 6.

The 1.3 preparation retains published v1.1.x and v1.2.x clients on protocol 6,
unchanged since v1.1.0, so the current decoders remain their wire contract.
Published v1.2.0 clients also require their own reducer versions and strict
finished shapes. The service answers them from the frozen catalog in
`packages/core/src/store/remote/released-reducer-values/1.2.0.json`, taken from
v1.2.0 (ec484bec559dd64813c9790e2b7d08e55f2384d6). Retain it while 1.2 is in the
supported window.

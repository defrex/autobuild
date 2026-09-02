# Hosted ticket protocol

The hosted ticket protocol exposes the complete `TicketSource` port without
exposing backend credentials. It shares the Autobuild and remote protocol
version headers with the remote BuildStore. Both must exactly match the service;
this release uses remote protocol version `2`.

## Authentication and context

Every request is `POST /tickets/<operation>`, has `Content-Type:
application/json`, and requires `Authorization: Bearer <token>`. Only a signed,
unexpired **operator** token is accepted. Legacy admin, build, repository, and
session tokens remain valid for their existing store routes but are denied on
`/tickets`. Mint an operator token offline with:

```sh
AB_STORE_SECRET='…' ab-hosted-store mint operator --ttl-seconds 3600
```

The strict request envelope is:

```json
{
  "context": {
    "teamKey": "ENG",
    "claimedState": "Doing",
    "createState": "Triage"
  },
  "input": {}
}
```

`teamKey` is required. The state overrides are optional. They come from the
requesting repository's `[tickets]` configuration and are applied only to that
request; the service does not cache a team-bound adapter. `list-ready` also
receives that repository's exact ready state and label criteria in `input`.
Backend credentials, including `LINEAR_API_KEY`, are service environment only
and never occur in this envelope or any response.

## Operations

The operation names and `input` values are:

| Operation | Input | Successful response |
|---|---|---|
| `list-ready` | `{labels?: string[], state?: string}` | `TicketListing` |
| `get` | `{id}` | `Ticket \| null` |
| `claim` | `{id}` | `{claimed: boolean}` |
| `comment` | `{id, body}` | `{ok: true}` |
| `transition` | `{id, state}` | `{ok: true}` |
| `create` | `{draft, options?}` | `Ticket` |
| `update` | `{id, patch}` | `{ok: true}` |
| `add-blocker` | `{id, blockerId}` | `{ok: true}` |
| `remove-blocker` | `{id, blockerId}` | `{ok: true}` |
| `dependency-states` | `{ids}` | `DependencyState[]` in input order |

Requests and responses reject unknown fields. Tickets include `ref`, optional
`creationKey`, `title`, `body`, optional `state`, `labels`, and optional
`blockedBy`. The client projects every returned `ref.source` as `hosted` while
preserving backend ids, URLs, titles, lifecycle values, labels, creation keys,
and blockers.

Ticket body strings are opaque. Clients, JSON handling, the service, and the
database backend must not trim or normalize bytes, newlines, Unicode, blank
lines, or trailing whitespace.

## Errors and conformance

Errors are JSON `{ "error": string, "kind": "validation" | "not-found" |
"auth" | "conflict" | "internal" }`. Authentication runs before body parsing
or backend construction. Responses never include exception causes, stacks,
environment values, or credentials. Client 401/403 responses become
`AuthError`; other backend messages remain actionable.

The shared `TicketSource` contract is normative for the database adapter and
the hosted client/server pair. External pass-through is tested with a fake
source behind HTTP. The existing opt-in live Linear contract remains the proof
of Linear's GraphQL behavior; the hosted service uses that adapter unchanged.

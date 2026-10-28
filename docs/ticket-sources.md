---
title: "Tickets"
group: "reference"
description: "Configure file, Linear, or hosted tickets and implement a ticket-source adapter."
label: "Ticket sources"
order: 13
---

# Tickets

## Responsibility

A ticket source owns ticket CRUD, lifecycle transitions, claiming, labels, blockers and creation identity. The build's pinned spec, history, transcripts and artifacts live in the BuildStore; editing a ticket after claim doesn't replace the pinned spec. See [Tickets are the interface](tickets.md) for grooming and the ready gate.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Examples are complete minimal `autobuild.toml` files. Credentials go in the dispatcher environment or an ignored `.env`, never TOML.

| Source | Choose it for | Credential |
|---|---|---|
| `file` | tickets you edit as plain files | none |
| `linear` | a team already grooming in Linear | `LINEAR_API_KEY` |
| `hosted` | a project tracker shared by agents and clients | saved `ab connect` credential |

### Local files (`file`)

Tickets live in a writable directory, `.autobuild/tickets/` by default; the default follows a local Store root and stays local with a remote Store. An explicit `dir` resolves from the repository root and isn't git-ignored automatically.

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
dir = ".tickets"
readyState = "ready"
readyLabels = []
createState = "triage"
triageState = "triage"
proposalState = "triage"
doneState = "done"
```
<!-- seam-config:end -->

- **States are directories** (`.tickets/ready/`, `.tickets/doing/`). Claims move to `doing`; `claimedState` isn't configurable.
- **Claiming** needs `readyState`, every `readyLabels` entry and resolved blockers; `[]` adds no label gate.

Initialize with `bun ab init`; manage with `bun ab ticket states` and the other ticket commands.

### Linear (`linear`)

Export a personal API key from [Linear's API setup](https://linear.app/developers/graphql) as `LINEAR_API_KEY` on the dispatcher host. It needs team access and must read issues, teams, workflow states, labels and dependencies, and write issues, comments, labels and blocking relationships.

<!-- seam-config:start -->
```toml
[tickets]
source = "linear"
teamKey = "ENG"
readyState = "Todo"
readyLabels = ["autobuild"]
claimedState = "In Progress"
createState = "Backlog"
triageState = "Backlog"
proposalState = "Backlog"
doneState = "Done"
```
<!-- seam-config:end -->

Replace `ENG` and the case-sensitive workflow names with your team's.

- **Admission.** `teamKey` selects the team; `readyState`, every `readyLabels` entry and optional `readyAssignee` filter it.
- **Labels.** `readyLabels` defaults to `["autobuild"]`; `[]` removes the gate.
- **No `project` key.** Scope the queue through team access, states and labels.
- **Rate limits** are shared with your other API callers.

### Hosted (`hosted`)

An independent tracker (not a Linear proxy) that works with local builds too. Connect the project:

```sh
bun ab connect --tickets https://tickets.example.com
```

The saved credential authorizes ticket operations and policy publication.

<!-- seam-config:start -->
```toml
[tickets]
source = "hosted"
teamKey = "ENG"
url = "https://tickets.example.com"
readyState = "ready"
readyLabels = []
claimedState = "doing"
createState = "triage"
triageState = "triage"
proposalState = "triage"
doneState = "done"
```
<!-- seam-config:end -->

- `teamKey` identifies the registered project's team.
- **URL.** `tickets.url` defaults to the remote BuildStore service (`AB_STORE` or `[store].url`); it's required with a local Store, as here.
- **Authority.** A separate ticket service needs its own project credential; a Store connection grants nothing there. Delegated child sessions are read-only and can't redefine policy.

### Optional ticket tree

All three sources declare `integrationTree: true`, storing kind and target as frontmatter (`file`), transactional project data (`hosted`), or the exact `node` label plus the parent relationship (`linear`).

- **Targets** resolve to canonical ids in the same source and pick the integration destination, not execution order; blockers are a separate graph. See [integration](integration-overview.md).
- **Updates.** Omitted `kind` or `target` keeps the value. New tickets default to work; `kind = "work"` resets kind; `target = null` clears a target in the typed API (not TOML syntax).
- **Validation.** Target existence, node kind, self/ancestor cycles, corrupt ancestor chains and demoting a node with children are checked before any write; invalid metadata rejects the whole patch.
- **Enumeration.** `listAll` lists every state, ignoring ready filters.
- **Without the capability**, a source keeps CRUD but must refuse kind/target writes, not drop them.

## Writing your own

Implement `TicketSource`, register it in the manifest's `ticketSources` map, and select it with `tickets.source`. Import from `@defrex/autobuild/plugin-sdk`, never internal paths. [Writing a plugin](plugin-authoring.md) covers factories, registration and publishing.

An adapter must:

- preserve lifecycle, claim and blocker-completion semantics
- create idempotently under retries, with stable visible creation keys
- return valid records from `listReady` with diagnostics for malformed ones, but propagate infrastructure failures
- declare revision support honestly: guarded writes reject stale revisions; unsupported guards fail explicitly
- never report success for a partial mixed update

Test with a `TicketSourceContractFactory` returning a `TicketSourceContractHarness` (source, lifecycle states, a writable fixture label, cleanup). Live fixtures reserve creation keys before creating, so cleanup survives a lost response. Run `describeTicketSourceContract` unchanged, or expose the fixture through the plugin contract descriptor and run:

```sh
bun ab plugin test ticket-source acme
```

Declare tree support only if you keep the [optional tree contract](plugin-authoring.md#optional-ticket-tree-capability) on the same port and harness: exhaustive pagination, canonical targets, revision coverage and atomic rejection.

Native paging is an optional API 1.9 ticket-source capability:
`listPage?(criteria: TicketCriteria, page: TicketPage): Promise<TicketPageListing>`.
The SDK exports these types; the result is `TicketListing & { total: number }`.
Criteria retain state, labels (AND), and assignee semantics. The page has a
nonnegative integer `limit`, optional nonnegative integer `offset` (default 0),
and optional `order: 'oldest' | 'newest'` (default oldest). Newest reverses the
entire source order before offset and limit. Total counts all matches, even
with limit zero or an offset past the end. Records, diagnostics and errors
match the exhaustive listing. The shared `describeTicketSourceContract` suite
automatically compares declared native paging with full-read windows.

Only paged operator listings select this capability. Sources without it retain
the full-read/reverse/slice fallback; native errors propagate. Unpaged operator
listings, CLI ticket lists and dispatcher ready scans remain exhaustive through
`listReady`/`listAll`. The hosted PostgreSQL source counts matches without
bodies and reads only the SQL-bounded window. File, Linear and the remote
`HostedTicketSource` retain fallback; the POST list-ready protocol stays exhaustive.

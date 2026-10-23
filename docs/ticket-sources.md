---
title: "Tickets"
group: "reference"
description: "Configure file, Linear, or hosted tickets and implement a ticket-source adapter."
label: "Ticket sources"
order: 13
---

# Tickets

## Responsibility

A ticket source owns ticket CRUD, lifecycle transitions, claiming, labels, blockers and creation identity.

- **It supplies work.** The build's pinned spec, execution history, transcripts and artifacts live in the BuildStore.
- **A claim pins the contract.** Editing a ticket after claim doesn't silently replace the pinned spec.

See [Tickets are the interface](tickets.md) for grooming and the ready gate.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Each example is a complete minimal `autobuild.toml`. Credentials go in the dispatcher environment or an ignored `.env`, never TOML.

| Source | Choose it for | Credential |
|---|---|---|
| `file` | a tracker you edit and back up with filesystem tools | none |
| `linear` | a team already grooming issues in Linear | `LINEAR_API_KEY` |
| `hosted` | a project-scoped tracker shared by agents and clients | saved `ab connect` credential |

### Local files (`file`)

The dispatcher needs a writable ticket directory, `.autobuild/tickets/` by default. A different local Store root moves that default with it; a remote Store keeps it local. An explicit `dir` resolves from the repository root and isn't ignored automatically, so decide whether to track it.

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

- **States are directories**, such as `.tickets/ready/` and `.tickets/doing/`. Claims always move to `doing`; `claimedState` isn't configurable for this source.
- **Claiming** requires `readyState`, every `readyLabels` entry and resolved blockers. An empty label list adds no label gate.
- **Proposals** stay in triage for grooming in this example.

Initialize with `bun ab init`, then manage the tracker with `bun ab ticket states` and the other ticket commands.

### Linear (`linear`)

Create a personal API key through [Linear's API setup](https://linear.app/developers/graphql) with access to the team, and export `LINEAR_API_KEY` on the dispatcher host. A read-only key won't work: the identity reads issues, teams, workflow states, labels and dependencies, and writes issues, comments, labels and blocking relationships.

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

Replace `ENG` and the case-sensitive workflow names with your team's values.

- **Admission.** `teamKey` selects the team; `readyState`, every `readyLabels` entry and optional `readyAssignee` filter what's admitted.
- **Labels.** Omitted `readyLabels` defaults to `["autobuild"]`; explicit `[]` removes that gate.
- **No project filter.** Don't add a `project` key. Scope the queue through team access, states and labels.
- **Rate limits** are shared with your other API callers.

### Hosted (`hosted`)

An independent tracker, not a Linear proxy; it works even when builds run locally. Connect the project through the service's authorized flow:

```sh
bun ab connect --tickets https://tickets.example.com
```

The saved project credential authorizes ticket operations and policy publication.

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
- **URL.** Without `tickets.url`, hosted tickets use the remote BuildStore service (`AB_STORE` or `[store].url`). With a local Store, as in this example, the URL is required.
- **Authority.** A separate ticket service needs its own project credential; a Store connection grants nothing there. Delegated child sessions are read-only and can't redefine project policy.

### Optional ticket tree

All three sources declare `integrationTree: true`:

| Source | Stores kind and target as |
|---|---|
| `file` | frontmatter |
| `hosted` | transactional project data |
| `linear` | the exact `node` label, and the parent relationship |

- **Targets** resolve to canonical ids in the same source. Blockers are a separate graph: a target picks the integration destination, not execution order. See [integration](integration-overview.md).
- **Updates.** Omitted `kind` or `target` keeps the existing value. New tickets default to work; explicit `kind = "work"` resets kind, and `target = null` clears a target in the typed API (null isn't TOML syntax).
- **Validation.** Before any part of a mixed patch writes, check target existence, node kind, self/ancestor cycles, corrupt ancestor chains and demotion of a node with children. Invalid metadata rejects the whole patch.
- **Enumeration.** Tree implementations list every state through exhaustive `listAll`, independent of ready filters.
- **Without the capability**, a source keeps ordinary CRUD but must refuse kind/target writes, never drop them silently.

## Writing your own

Implement `TicketSource`, register it in the manifest's `ticketSources` map, and select it with `tickets.source`. Import types and harnesses from `@defrex/autobuild/plugin-sdk`, never internal paths. [Writing a plugin](plugin-authoring.md) covers factories, registration, packaging and publishing.

An adapter must:

- preserve lifecycle and claim semantics and blocker completion
- create idempotently under retries, with stable externally visible creation keys
- return partial valid results from `listReady`, with diagnostics for malformed records, while still propagating infrastructure failures
- declare revision support honestly: guarded writes reject stale revisions, and unsupported guards fail explicitly
- never report success for a partial mixed update

Test it with a `TicketSourceContractFactory` returning a `TicketSourceContractHarness`: the source, lifecycle states, a writable fixture label and cleanup. Live fixtures reserve creation keys before creating and track what they create, so cleanup survives a lost response. Run `describeTicketSourceContract` unchanged, or expose the fixture through the plugin contract descriptor and run:

```sh
bun ab plugin test ticket-source acme
```

Tree support adds obligations to this same port and harness, not a separate one. Declare it only when you can keep the [optional tree contract](plugin-authoring.md#optional-ticket-tree-capability): exhaustive pagination, canonical targets, revision coverage and atomic rejection.

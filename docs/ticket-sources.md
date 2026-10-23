---
title: "Tickets"
group: "reference"
description: "Configure file, Linear, or hosted tickets and implement a ticket-source adapter."
label: "Ticket sources"
order: 13
---

# Tickets

## Responsibility

A ticket source owns ticket CRUD, lifecycle transitions, claiming, labels, blockers, and creation identity. It supplies work to dispatch; the build's pinned spec, execution history, transcripts, and artifacts live in the BuildStore. Changing a ticket after claim does not silently replace the pinned contract. See [Tickets are the interface](tickets.md) for grooming and the ready gate.

## Shipped adapters

Each example is a complete minimal `autobuild.toml`. Install Autobuild with `bun add -d --exact @defrex/autobuild`; run repository commands as `bun ab <command>`. Credentials belong in the dispatcher environment or ignored `.env`, never TOML.

### Local files (`file`)

Choose files for a tracker you can inspect, edit, and back up with ordinary filesystem tools. No service credential is required. The dispatcher needs a writable ticket directory. By default it is `.autobuild/tickets/`; selecting a different local Store root relocates that default with the Store. A remote Store keeps default file tickets local. An explicit `dir` resolves from the repository root and is not automatically ignored, so decide whether to track it.

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

File claims always move to `doing`; `claimedState` is not configurable for this source. State names correspond to directories, such as `.tickets/ready/` and `.tickets/doing/`. Initialize through `bun ab init`, then use `bun ab ticket states` and the ticket commands to manage the tracker. Only tickets in `readyState` carrying every `readyLabels` entry and with resolved blockers can be claimed. An empty label list adds no label gate. Proposals stay in triage for grooming in this example.

### Linear (`linear`)

Choose Linear when your team already grooms issues in its workflow. Create a personal API key using [Linear's API setup](https://linear.app/developers/graphql), grant access to the selected team, and export `LINEAR_API_KEY` on the dispatcher host. The identity needs to read issues, teams, workflow states, labels and dependencies, and to create/update issues, comments, labels and blocking relationships used by ticket operations. A read-only key is insufficient.

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

Replace `ENG` and the case-sensitive workflow names with your team's actual values. `teamKey` selects the team; `readyState`, all `readyLabels`, and optional `readyAssignee` filter admission. Omitted Linear labels default to `["autobuild"]`; explicit `[]` removes that gate. There is no project filter in the ticket configuration: do not add a `project` key. Team access and state/label selection should match the intended queue. API rate limits are shared with other callers.

### Hosted (`hosted`)

Choose hosted tickets for a project-scoped service shared by agents and clients, including projects whose builds run locally. This is an independent tracker, not a Linear proxy; it needs no Linear credential. Register/connect the project with `bun ab connect --tickets https://tickets.example.com`, using the service's authorized connection flow. The saved service/project credential authorizes ticket operations and policy publication.

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

`teamKey` identifies the registered project's team. This example leaves builds on the default local Store. Without `tickets.url`, hosted tickets use the selected remote BuildStore service (`AB_STORE` or `[store].url`); an explicit ticket URL is required when builds use a local Store. A separate ticket service needs its own project credential. A Store-only connection does not confer authority on an unrelated service. Delegated child sessions are read-only; they cannot redefine project policy.

### Optional ticket tree

File, Linear, and hosted all declare `integrationTree: true`. File persists kind/target in frontmatter; hosted uses transactional project data; Linear maps node kind to the exact `node` label and target to its parent relationship. Targets must resolve to canonical ids in the same source. Blockers remain a separate graph: a target chooses integration destination, not execution order. See [integration](integration-overview.md).

For an update, omitted `kind` or `target` preserves the existing value. A new ticket defaults to work; explicit `kind = "work"` resets kind, and `target = null` clears a target in the typed API. Null is an API value, not TOML syntax. Tree implementations must enumerate every state through exhaustive `listAll`, independent of ready filters. Before any part of a mixed patch writes, validate target existence, node kind, self/ancestor cycles, corrupt ancestor chains, and demotion of a node with children. Invalid metadata must reject the entire patch. Sources without the capability receive ordinary CRUD but must refuse kind/target writes; they must never silently discard them.

## Writing your own

Implement `TicketSource`, register it in the manifest's `ticketSources` map, and select the registered name with `tickets.source`. Import types and harnesses from `@defrex/autobuild/plugin-sdk`, never internal source paths. Follow [Writing a plugin](plugin-authoring.md) for factories, registration, packaging and publishing.

Preserve lifecycle and claim semantics, blocker completion, idempotent creation under retries, and stable externally visible creation keys. `listReady` returns partial valid results with diagnostics for malformed individual records; infrastructure failures must still propagate. Declare revision support honestly: guarded writes must reject stale revisions, while unsupported guards must fail explicitly. Never report success for a partial mixed update.

Provide a `TicketSourceContractFactory` returning a `TicketSourceContractHarness` with the source, lifecycle states, a writable fixture label, and cleanup. Live fixtures should reserve creation keys before create and track created tickets/labels for cleanup even after a response is lost. Run `describeTicketSourceContract` against the adapter unchanged, or expose that fixture through the plugin contract descriptor and run:

```sh
bun ab plugin test ticket-source acme
```

Tree support adds semantic obligations to this same port, not a separate plugin port or harness. Declare it only when you can preserve the [optional tree contract](plugin-authoring.md#optional-ticket-tree-capability), including exhaustive pagination, canonical targets, revision coverage and atomic rejection.

---
title: "Tickets"
group: "reference"
description: "Configure file, Linear, hosted, or GitHub tickets and implement a ticket-source adapter."
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
| `github` | a team already working in the repository's GitHub issues | `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth login` |

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
backlogState = "backlog"
rejectedState = "rejected"
```
<!-- seam-config:end -->

- **States are directories** (`.tickets/ready/`, `.tickets/doing/`). Claims move to `doing`; `claimedState` isn't configurable.
- **Claiming** needs `readyState`, every `readyLabels` entry and resolved blockers; `[]` adds no label gate.
- **Backlog and rejected** directories are created on the first role move into them.

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
rejectedState = "Canceled"
```
<!-- seam-config:end -->

Replace `ENG` and the case-sensitive workflow names with your team's.

- **Admission.** `teamKey` selects the team; `readyState`, every `readyLabels` entry and optional `readyAssignee` filter it.
- **Labels.** `readyLabels` defaults to `["autobuild"]`; `[]` removes the gate.
- **No `project` key.** Scope the queue through team access, states and labels.
- **Rate limits** are shared with your other API callers.
- **Backlog and rejected.** Neither role has a default, and neither may share a state with triage. Here `Backlog` is the triage state, so a deferred-work state needs its own name, such as `backlogState = "Icebox"`. Linear counts `Canceled` as complete; mapped to `rejectedState`, it no longer resolves blockers.

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
backlogState = "backlog"
rejectedState = "rejected"
```
<!-- seam-config:end -->

- `teamKey` identifies the registered project's team.
- **URL.** `tickets.url` defaults to the remote BuildStore service (`AB_STORE` or `[store].url`); it's required with a local Store, as here.
- **Authority.** A separate ticket service needs its own project credential; a Store connection grants nothing there. Delegated child sessions are read-only and can't redefine policy.
- **Backlog and rejected.** `ab connect` and every policy publication carry both roles, so operator and MCP role moves use them too. Mapping a role onto an existing state, such as `backlogState = "icebox"`, keeps that state and its tickets; a missing role state is created. Blocker facts carry each blocker's state, so a rejected blocker is named in diagnostics.

### GitHub (`github`)

Tickets are the issues of the forge repository, the GitHub repository that `origin` names, so a team grooms and tracks work where it already looks. The source authenticates as the `github` forge does: `GITHUB_TOKEN`, then `GH_TOKEN`, then the gh CLI's `gh auth login`. A fine-grained token needs Issues read and write, and Metadata read, on the repository, and a user token's user needs triage or write access: GitHub silently drops label changes from anyone below that, so a label write that doesn't come back fails with a permission error instead of reporting success. `ab init --validate` names a missing token, a token that can't read and write issues, a user who can't set labels, disabled issues, an `origin` that isn't a GitHub repository, and a state that can't be a label.

<!-- seam-config:start -->
```toml
[tickets]
source = "github"
readyState = "ready"
readyLabels = ["autobuild"]
claimedState = "doing"
createState = "triage"
triageState = "triage"
proposalState = "triage"
doneState = "done"
backlogState = "backlog"
rejectedState = "rejected"
```
<!-- seam-config:end -->

`source = "github"` alone is enough: every other key shown is its default, except the two roles, which `ab init` writes. `teamKey`, `dir` and `url` are refused.

- **Ids** are issue numbers; commands accept `123` and `#123`. Title, body and labels are the issue's. Pull requests are never tickets.
- **States are `autobuild:` labels.** An open issue with one `autobuild:<state>` label is in that state, and an open issue with none is in triage, so issues filed on GitHub arrive there. An issue with two or more state labels is left out of listings with a diagnostic naming it and its labels. `ab ticket state create icebox --about "…"` creates the `autobuild:icebox` label, with the purpose as its description. A name is one to forty lowercase letters, digits or hyphens, starting with a letter.
- **Closing reasons.** Closed as completed, or closed before GitHub recorded reasons, is done. Closed as not planned or duplicate is in the `rejectedState` state; without `rejectedState` it reads as a fixed `not-planned` state that is never ready, never resolves a blocker and can't be moved into. Moving to done or rejected closes the issue with that reason (an issue already closed with the other reason is reopened and closed again, because GitHub changes a reason only with the state); moving to any other state opens it with exactly that state's label.
- **Reopen goes to triage.** If a state label survived the close, the adapter strips that stale label the first time it reads the reopened issue. It tells stale from fresh by the issue's last 100 label and reopen events; an issue whose deciding event is older than that is left out of listings with a diagnostic until its state label is removed and re-added.
- **Labels.** `readyLabels` defaults to `["autobuild"]`; `[]` removes the gate. Missing labels are created on demand. State and link labels are never part of a ticket's labels, and a write that names one is refused. The `autobuild:proposal` and `autobuild:aborted` labels that harvest and abort apply are ordinary labels, so `proposal` and `aborted` can't be states.
- **Blockers** are native issue dependencies ("blocked by"), visible on both issues, including ones added on GitHub. A blocker resolves when its issue is done. One in another repository never resolves and is named in the dependency diagnostics. An issue transferred to another repository is no longer a ticket here: its old number reads as missing, so it is never written and never resolves a blocker.
- **Issue links.** The ticket's own issue is always a `closes` link that can't be removed. Links to other issues are labels named `autobuild-link:<intent> #<n>`, such as `autobuild-link:refs #820`, so they show on the issue and survive edits on GitHub. Each linked issue and intent adds one repository label, which appears in GitHub's label picker; unused link labels are never deleted.
- **Comments and assets.** Dispatcher notices post as issue comments, but tickets carry no comment history, so `ab ticket show` lists none; export and import read comment history explicitly. Assets live in the BuildStore, with the usual note left as an issue comment.
- **Export and import.** `ab ticket export` covers every issue, closed ones included. `ab ticket import` remaps every id to a new issue number and resumes by creation key, as the ticket migration procedure's GitHub section describes.
- **Not supported:** guarded writes (`--expected-revision` is refused, as with Linear) and kind and targets (the ticket tree).
- **Cost.** Dispatcher reads are conditional requests. Their validators live under the local state root, in `github-tickets/<owner>/<repo>/validators/`, and are evicted after 7 days unused, so a tick on an unchanged repository spends no primary rate-limit budget. A process without them, such as a cold hosted instance, pays one read sized by the ready candidates. Rate limits surface as the ticket-source rate-limit error, with GitHub's reset time.
- **State counts** are display-only: one fresh GraphQL request per call, plus one more for each further page of 100 `autobuild:` labels, never cached and never reading issue history, with done and rejected subject to GitHub's search-index lag. Three cases approximate. A stale reopen label counts in its label's state until the first read strips it. An issue with two or more state labels counts once in each until its labels are fixed; the first read reports it. A closure that predates GitHub's close reasons reads as done but may count as rejected or `not-planned`, and never heals.
- **Creation keys** live in a hidden marker in the issue body. A keyed create needs `idempotencyKeyReservedAt`; harvest supplies it.

### Optional issue links

The `file`, `hosted` and `github` sources store [forge issue links](tickets.md#groom-a-buildable-spec): as `issueLinks` frontmatter (`file`), transactional project data (`hosted`), or `autobuild-link:<intent> #<n>` labels (`github`), where the ticket's own issue is a `closes` link with no label. `linear` doesn't, because Linear links GitHub issues natively through its own integration; a create or update that names issue links is refused with an error naming the source, and nothing is written.

### Optional priority

A ticket is `urgent` or `normal` (the default); the dispatcher claims urgent ready work first. The `file` source stores `priority = "urgent"` in frontmatter and writes no key for normal. `hosted` and `linear` don't store priority: they read every ticket as normal, refuse a create or update naming `urgent` with an error naming the source, and write nothing. `--priority normal` succeeds on them as a no-op.

### Optional ticket tree

The `file`, `hosted` and `linear` sources declare `integrationTree: true`, storing kind and target as frontmatter (`file`), transactional project data (`hosted`), or the exact `node` label plus the parent relationship (`linear`). `github` doesn't: every ticket reads as work with no target, and kind and target writes are refused.

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
- if its key lookup is bounded by time, require `idempotencyKeyReservedAt`, the earliest time the key could first have been used, and refuse a keyed create without it
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
bodies and reads only the SQL-bounded window. File, Linear, GitHub and the remote
`HostedTicketSource` retain fallback; the POST list-ready protocol stays exhaustive.

Bounded state counts are another optional capability:
`countStates?(names: readonly string[]): Promise<TicketStateCount[]>`. It returns
`{name, tickets}` for each requested name that resolves (exactly, else by one
case-insensitive match) and never returns ticket rows. A dashboard viewer polls
it for the header's triage count. Without it, the viewer shows `–`, and it never
falls back to a listing. A store-backed source should answer from maintained
totals so the cost does not grow with the number of tickets: the hosted
PostgreSQL source reads trigger-maintained totals, and the remote
`HostedTicketSource` forwards the read to the server. The file source counts
each matched state's directory entries without parsing a ticket, so its local
cost grows with the files in that state. The GitHub source sends one GraphQL request per call, plus one per further page of 100 `autobuild:` labels, so its cost grows with matching labels rather than tickets, and keeps no count between calls. Linear does not implement it. When a source declares
both `countStates` and `listStates`, the shared contract suite checks that they
agree.

# Moving a project between ticket sources

Export and import use the ordinary file ticket layout. They operate on tickets
and current attachments through the ticket source; neither command contacts the
forge, except that a GitHub source reads and writes the repository's issues.
File, hosted and GitHub sources support import. Every built-in source supports
export.

1. Pause intake and quiesce build-related ticket writes and other ticket writers
   for the cutover. In-flight builds need not be aborted. Import preflight does
   not reserve numbers against concurrent writers.
2. With the old `[tickets]` configuration, run `ab ticket export /path/to/export`.
   The destination must be absent or empty. Export reads every state, including
   archived Linear tickets and empty discoverable states, and publishes the
   directory only after all reads succeed. Back up the target tracker too.
3. Configure the new `[tickets]` source, or use `ab connect --tickets URL` for a
   hosted ticket service. Keep the export directory intact.
4. Run `ab ticket import /path/to/export [--states <state,…>]`. Inspect its
   printed ticket and state mappings and `/path/to/export/.ab-import-map.json`.
5. Import records a durable source/ID mapping in the same BuildStore and repository
   that hold the existing builds, after tickets, metadata and assets finish.
   Keep that BuildStore/repository identity through the cutover.
6. Inspect ticket bodies, labels, blockers, comments and attachments in the new
   source. Confirm lifecycle configuration and the ready gate, then resume builds and intake.

Linear export reads full ticket details in batches and prints `read X/Y tickets`.
The total is shown as pending until inventory discovery finishes. If Linear reports
a rate limit with a usable future reset time, export prints the wait time, waits
until that reset, and retries the failed read while retaining completed pages.
Without a usable reset time, export fails immediately. A running dispatcher and
other clients authenticated as the same API user share the API budget, so they
can cause additional waits. Interrupting export with Ctrl-C publishes nothing;
the destination stays absent or empty until all ticket and attachment reads succeed.

Both commands also accept
`--store <ref>` to reach legacy BuildStore attachments. Keep the old store available
through export when file or Linear tickets have attachments there.

State directory names use lowercase letters, digits and hyphens, start with a
letter and contain at most forty characters. Export maps `In Progress` to
`in-progress`, `Backlog` to `backlog`, and `Done` to `done`. It retains each ticket's
state, and the manifest records which lifecycle roles each state held under the
exporting configuration: triage, ready, claimed, done, backlog, rejected, and the
create and proposal placements. Distinct names that collapse to the
same directory fail before publication. The hidden `.ab-migration.json` records
original display names and the state map. Import also accepts ordinary legacy
file layouts: it reuses exact or unique case-insensitive target states before
normalizing new names. A seeded `done` satisfies `Done`; absent `In Progress`
creates `in-progress`. Ambiguous matches and colliding state maps fail preflight.

A state that held a role lands in the destination's state for the same role,
whatever either source calls it. For example, an `icebox` backlog lands in a
`later` backlog, and Linear's `Backlog` triage lands in `triage`. A state holding
several roles takes the first of done, rejected, claimed, ready, backlog, triage,
proposal and create. If the destination configures no backlog or rejected state
for such a state, import refuses and names the `[tickets]` key to set. States
without a role, and exports made before roles were recorded, map by name as above.

## Importing selected states

`ab ticket import <dir> --states triage,ready,icebox` imports only the tickets in
the named states and creates only those states. Teams moving to a new tracker
often take their open work and leave closed history behind. A name matches an
export directory exactly, then by unique case-insensitive match, then by the
original display name the manifest recorded (`In Progress` for `in-progress`).
An unknown name is refused, and the refusal lists the export's states.

A blocker on a left-out ticket in the done role is dropped as resolved. Any other
reference to a left-out ticket is reported before any write, and nothing is
imported. That covers a blocker in another state, an integration-tree target, and
an issue link to a left-out issue in an export from GitHub. Import also refuses a
selection that leaves out a ticket an unfinished build is working on or targets.
The refusal names the build and the ticket, so in-flight work keeps its continuity.
Without `--states`, every ticket is imported.

File targets retain source ids. Hosted targets keep canonical own-team ids:
`AUT-706` imported into team `AUT` stays `AUT-706`. Other ids receive numbers above
all existing and preserved incoming numbers. Known clashes with unrelated tickets
are reported together before any target state, ticket, comment or asset write.
Content similarity and stale mapping files never establish identity.

Creation keys establish identity. Exports retain existing keys and assign keys to
legacy tickets. Importing an ordinary file layout first saves a hidden migration
identity and keys in that input directory. The identity also records when it was
first saved, and that time is passed as the creation keys' reservation time. Preserve this file and the input across
retries. After interruption, rerun the same command: committed creates are adopted
by key even if their mapping write failed. Adopted bodies and other fields are not
overwritten. Missing blockers and comments are replayed, and unchanged attachments
do not create another revision. Comments are deduplicated by exact body, so two
identical source comment bodies produce one target comment. Original authors and
timestamps remain in the export; imported comments use the target's metadata.

Portable records use TOML frontmatter between `+++` fences and an unchanged
Markdown body. Alongside `id`, `title`, `labels`, `blockedBy` and `idempotencyKey`,
optional `issueLinks` contain `issue` and `intent` (`closes` or `refs`), optional `priority` is `"urgent"` (absent means normal), optional `comments` contain `body`, `createdAt` and optional `author`. Optional
`attachments` contain `kind`, `name`, `layout` (`file` or `tree`) and `entries`:
`{ type = "dir", path = "empty" }` or
`{ type = "file", path = "image.png", base64 = "…" }`. Common asset limits and
path validators apply. Only current attachment contents travel, including binary
files and empty directories; historical revisions do not. The exported directory
works directly as a file source, without its migration manifest or original store.
File source revision history stays in its hidden `.ab-assets` directory.

Legacy records without `comments` retain their Markdown comment append behavior;
export never interprets Markdown headings as structured history. New file tickets
use structured comments and preserve their body when a comment is added. There is
no continuous sync, assignee migration, state history or build-history migration.

Integration-tree `kind` and `target` are preserved in portable frontmatter.
Import validates the complete target graph before changing the destination and
refuses a destination that cannot preserve metadata. Issue links and urgent
priority are preserved the same way, and a destination that cannot store them is refused before any write. It creates or adopts every
identity, establishes node kinds, then applies targets using the durable id map,
just like blockers. Input order does not matter. Resuming also restores edges on
adopted tickets; normal destination validation still guards existing graphs and
node demotion. Older work-only exports remain valid.

## GitHub

GitHub chooses issue numbers, so import into a `github` source remaps every
ticket. Check the printed mapping and `.ab-import-map.json`, which list each
original id with its new issue number. Blockers are rewritten through that
mapping and become native issue dependencies. Comments become issue comments,
and attachments go to the BuildStore under the new number. States become
`autobuild:<state>` labels. The done role closes the issue as completed, the
rejected role closes it as not planned, and triage leaves it open without a state
label. Each issue carries a creation key in a hidden marker, so an interrupted
import resumes with the same command and adopts the issues it already opened.
Resuming never duplicates an issue, and it replays missing blockers, comments and
assets.

Before any write, import reports every problem together: states that cannot be
`autobuild:` labels (for example `proposal`, or names that are not lowercase),
a rejected state when `[tickets].rejectedState` is unset, and ticket labels that
would collide with a state label (`autobuild:<state>`) or an issue-link label
(`autobuild-link:…`). The `autobuild:proposal` and `autobuild:aborted` marker
labels are ordinary labels and import as-is. Node kinds become the exact `node`
label, and targets become sub-issue relationships to the remapped node issues.
Issue links are kept. They are rewritten through the mapping only when the export
came from GitHub, because only then do they name the exported tickets.

Export from a `github` source covers every issue, closed ones included. It records
comment history with authors and timestamps, kinds, targets, blockers and issue links, and skips
pull requests. An issue it cannot read as a ticket, such as one with two state
labels, fails the export. Issues closed as not planned export in the rejected
role even when `[tickets].rejectedState` is unset. Export and import read comment
history explicitly. The GitHub source still lists no comment history in
`ab ticket show`, and dispatcher ticks never read it.

## In-flight builds

A recorded migration resolves old source-qualified ticket references through the
new source, including remapped IDs. Completeness, child targeting, capacity
ancestry, claimed target checks, lifecycle transitions and notices use that
mapping. Historical build events and ticket references remain unchanged. Moves
can chain across sources; mappings are never applied backward. A source switch
alone establishes no continuity. Missing migration evidence or an uncovered ID
fails closed and names the build and original ticket when operating on that
build or its frozen membership. Uncovered historical builds stay in their
original namespace during history searches; they cannot alias current tickets
or block unrelated intake. Separate trackers with the
same adapter name cannot be distinguished by historical references; this does
not establish continuity between them.

When using the export directory directly as the configured file tracker, run
`ab ticket migration record /path/to/export [--store <ref>]`. This verifies the
manifest inventory and creation keys against the destination and records identity
mappings for the original manifest IDs, without importing tickets. Additional
tickets filed in the directory after export are allowed and are not included in
the mapping. Every original ID must still exist with its recorded creation key.
Preserve `.ab-migration.json` for this step;
the tracker itself can operate without it. `.ab-import-map.json` is progress
information, never proof of continuity. Repeating an identical recording is safe;
conflicting evidence is refused.

Import is not transactional across ticket and build services. A partial import
records no continuity; rerun with the same directory to adopt by creation key.
If tickets finish but journal recording fails, the command reports that boundary:
rerun the same command to finish recording before resuming builds. The migration
journal belongs to the selected BuildStore even when ticket assets live on an
independent hosted service. Validate the destination configuration before resume.

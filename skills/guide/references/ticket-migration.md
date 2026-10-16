# Moving a project between ticket sources

Export and import use the ordinary file ticket layout. They operate on tickets
and current attachments through the ticket source; neither command contacts the
forge. File and hosted sources support import. Linear supports export only.

1. Pause intake and stop other ticket writers for the cutover. Import preflight
   does not reserve numbers against concurrent writers.
2. With the old `[tickets]` configuration, run `ab ticket export /path/to/export`.
   The destination must be absent or empty. Export reads every state, including
   archived Linear tickets and empty discoverable states, and publishes the
   directory only after all reads succeed. Back up the target tracker too.
3. Configure the new `[tickets]` source, or use `ab connect --tickets URL` for a
   hosted ticket service. Keep the export directory intact.
4. Run `ab ticket import /path/to/export`. Inspect its printed ticket and state
   mappings and `/path/to/export/.ab-import-map.json`.
5. Inspect ticket bodies, labels, blockers, comments and attachments in the new
   source. Confirm lifecycle configuration and the ready gate, then resume intake.

Both commands also accept
`--store <ref>` to reach legacy BuildStore attachments. Keep the old store available
through export when file or Linear tickets have attachments there.

State directory names use lowercase letters, digits and hyphens, start with a
letter and contain at most forty characters. Export maps `In Progress` to
`in-progress`, `Backlog` to `backlog`, and `Done` to `done`. It retains each ticket's
state rather than assigning lifecycle roles. Distinct names that collapse to the
same directory fail before publication. The hidden `.ab-migration.json` records
original display names and the state map. Import also accepts ordinary legacy
file layouts: it reuses exact or unique case-insensitive target states before
normalizing new names. A seeded `done` satisfies `Done`; absent `In Progress`
creates `in-progress`. Ambiguous matches and colliding state maps fail preflight.

File targets retain source ids. Hosted targets keep canonical own-team ids:
`AUT-706` imported into team `AUT` stays `AUT-706`. Other ids receive numbers above
all existing and preserved incoming numbers. Known clashes with unrelated tickets
are reported together before any target state, ticket, comment or asset write.
Content similarity and stale mapping files never establish identity.

Creation keys establish identity. Exports retain existing keys and assign keys to
legacy tickets. Importing an ordinary file layout first saves a hidden migration
identity and keys in that input directory. Preserve this file and the input across
retries. After interruption, rerun the same command: committed creates are adopted
by key even if their mapping write failed. Adopted bodies and other fields are not
overwritten. Missing blockers and comments are replayed, and unchanged attachments
do not create another revision. Comments are deduplicated by exact body, so two
identical source comment bodies produce one target comment. Original authors and
timestamps remain in the export; imported comments use the target's metadata.

Portable records use TOML frontmatter between `+++` fences and an unchanged
Markdown body. Alongside `id`, `title`, `labels`, `blockedBy` and `idempotencyKey`,
optional `comments` contain `body`, `createdAt` and optional `author`. Optional
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

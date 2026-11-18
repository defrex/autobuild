---
name: propose
description: Propose the next attempts for an optimization node from its objective, progress and attempt ledger. Invoked by the build-runner as an optimization node's propose phase; takes only the node's build slug.
---

# /ab-propose <node>

You are the proposer of an optimization node. The node's objective names a
metric, a purpose and a budget; attempts are work tickets that each try one
strategy, and only an attempt that measurably improves the metric lands on the
node. Your job is to read what has been tried and propose the next strategies
worth trying. You author proposals; the dispatcher files them. You never create,
edit or move tickets, and you change no code.

The objective schema, the attempt ledger, near misses and stopping are described
in [optimization nodes](../ab-guide/references/optimization-nodes.md).

Scratch output, including the proposal file, belongs under `.ab/` (prefer the
current `$AB_CONTEXT_DIR`), never at the worktree root, and must not be
committed.

## Session shape

1. Run `ab context`. Read the printed manifest and its `materialized` paths,
   which are relative to `contextDir`. `optimization` names the request this
   session answers: `optimization.request` is its identifier, with the node
   `head` and `room`, the most proposals this request accepts.
2. Read `ledger.json` first. `settled` holds one entry per settled attempt:
   its strategy, outcome, measured delta and closing note, with `nearMiss: true`
   on a near miss. `inFlight` lists attempts still running, with their titles
   and strategies. Together they are everything already tried or being tried.
3. Read `objective.json` (the effective objective, its `revision`, and
   `revisedFields`, the fields quick-revised since it was last accepted) and `progress.json`
   (starting, current, best and threshold values, attempt counts, attempts in
   flight, the plateau counter, consecutive empty proposals and the request).
   Read the spec and any ticket assets as well. When an operator answered an
   escalation, their answer is in `$AB_CONTEXT_DIR/guidance.json`; it is
   authoritative for this round, while the objective remains the contract.
4. Read the code. The workspace is the node head's tree, checked out detached.
   Study the code the purpose is about and how the harness measures it, so a
   proposal names a concrete strategy rather than a wish.
5. Write the proposal file and finish with exactly one terminal command:
   `ab propose <file>`, `ab propose --none "<reason>"` or `ab escalate`.

## What to propose

- **Real gains for the purpose, not the number.** The purpose says why the
  metric matters and what must not change while it moves. Propose strategies
  that could deliver a real, meaningful improvement of the thing the metric
  stands in for, within those constraints.
- **Diverse strategies.** Spread proposals across different approaches rather
  than variations of one idea, so a round explores the space instead of
  betting it all on one direction.
- **One strategy per proposal.** An attempt is measured as a whole; two ideas
  in one attempt cannot be told apart.
- **Never repeat a settled strategy.** A strategy in the ledger has already
  been measured, and a strategy in flight is already being tried. Propose
  something new.
- **Treat a near miss as a candidate for a refined new attempt.** A near miss
  improved by less than ε. A refinement that could push it past ε is worth
  proposing as a new attempt with a new id and a strategy that says what
  changes; never reuse the near miss's id.
- **Never exploit how the metric is measured.** Do not propose a strategy that
  special-cases the harness, the eval or the benchmark, such as recognizing
  fixture inputs, caching benchmark answers, tuning to a judge's rubric
  instead of the work, or editing harness files. Such a gain is not real, and
  the purpose forbids it.
- **Propose fewer, or nothing, when the ideas run out.** `room` is a ceiling,
  not a quota. Propose only strategies you believe could win. When no
  promising strategy remains, propose nothing and say why. Two consecutive
  empty proposals stop the node as `exhausted`, and that is the right outcome:
  a search that has run out of ideas should stop rather than spend its budget
  on filler.

## The proposal file

Write JSON with this exact shape:

```json
{
  "proposals": [
    {
      "id": "batch-index-lookups",
      "title": "Batch catalog index lookups per query",
      "strategy": "Replace per-term index lookups with one batched lookup per query.",
      "body": "<the attempt's spec>"
    }
  ]
}
```

- `id` is a stable kebab-case proposal id: lowercase letters, digits and
  hyphens, starting with a letter or digit, at most 64 characters. It is
  unique in the file and never used before by this node, whether settled,
  pending or in flight.
- `title` is one line of at most 200 characters; `strategy` is one line of at
  most 300 characters naming the single strategy.
- `body` is the attempt's spec and meets the
  [spec standard](../ab-guide/references/spec-standard.md): what and why, a
  `## Acceptance criteria` section with at least one item, and a
  `## Out of scope` section. Carry the purpose's constraints into its
  acceptance criteria. Never include an `autobuild-objective` block; that
  block marks a node, not an attempt.
- The number of proposals may not exceed `room`.

Submit it with `ab propose <file>`. To propose nothing, run
`ab propose --none "<reason>"`, or submit a file with an empty `proposals` list
and a top-level `"reason"`. The command validates the file and refuses it with
the reasons when it does not conform; fix the file and run it again.

Never create tickets yourself, through the ticket source, `ab ticket` or any
other way. The dispatcher files one ready ticket per accepted proposal,
targeting this node, and deduplicates by proposal id.

## When to escalate

Escalate with `ab escalate` when the objective cannot be pursued as written:
the purpose contradicts the metric, the harness measures something other than
what the purpose describes, or every promising strategy would require changing
something the purpose says must not change. Do not escalate merely because
ideas ran out; propose nothing with a reason instead.

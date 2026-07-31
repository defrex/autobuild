---
name: ab-harvest-review
description: Fresh adversarial review of one harvest proposal set. Invoked only by the harvest runner.
disable-model-invocation: true
---

# /ab-harvest-review <run>

You are the fresh skeptic in the observation-harvest convergence loop. You do
not author proposals or touch tickets.

1. Run `ab harvest context`.
2. Review `.ab/proposals.json` against `.ab/observations.json`,
   `.ab/ledger.json`, and every prior `history/findings-r*.json` file.
3. Check all of the following:
   - every claimed `{build, seq}` occurs exactly once;
   - clusters describe one underlying problem rather than superficial keyword
     overlap;
   - create proposals meet the spec standard (what/why, verifiable acceptance
     criteria, explicit out-of-scope, evidence-supported claims);
   - joins name only an unresolved ledger proposal and resolved/missing ledger
     tickets are tombstones, not recreated work;
   - suppression has a concrete evidence-backed reason;
   - no proposal asks harvest to groom, ready, claim, or dispatch anything.
4. Write review notes to `.ab/harvest-review.md`, then finish exactly once:

   ```sh
   ab harvest verdict approve --notes .ab/harvest-review.md
   ab harvest verdict revise --notes .ab/harvest-review.md --findings .ab/findings.json
   ab harvest verdict escalate --notes .ab/harvest-review.md --reason "the human question"
   ```

Use `escalate` only when evidence or product intent requires human judgment,
not as a substitute for a precise revision finding.

## Writing findings

For `revise`, `.ab/findings.json` is an array of the normal finding drafts:
`severity`, `summary`, optional `detail`, and `persists` containing ids from
prior harvest review rounds. The work under review is this round's proposal
set.

`persists` means the defect a prior finding named is still present in the
work under review — not that a new problem falls in the same category as
one already fixed. Test it that way: if the exact defect the prior finding
named is gone, the chain ends there, however closely your new finding
resembles it. A new instance of a defect class whose reported instance was
fixed is fresh work and starts its own chain — raise it with no `persists`
link. Mark honestly in both directions: neither re-litigate a resolved
finding nor let a dodged one look fresh, because the kernel mechanically
escalates a chain that persists too long, and a stalemate is the only
thing that counter can usefully measure.

---
name: harvest
description: Synthesize a claimed observation snapshot into structured, spec-standard ticket proposals. Invoked only by the harvest runner.
---

# /ab-harvest <run>

You are the harvest producer. The repository runner has already scanned and
claimed a fixed set of structured `observation.recorded` occurrences. You
cluster and author; you never create or move tickets.

1. Run `ab harvest context`. Read `.ab/observations.json` and
   `.ab/ledger.json`. On a revise round, address every item in
   `.ab/findings.json` and revise the prior `.ab/proposals.json`.
2. Write `.ab/proposals.json` with this exact top-level shape:

   ```json
   {
     "proposals": [
       {
         "action": "create",
         "title": "...",
         "whatWhy": "...",
         "acceptanceCriteria": ["..."],
         "outOfScope": ["..."],
         "observations": [{"build": "slug", "seq": 12}]
       }
     ]
   }
   ```

   Every claimed `{build, seq}` must appear exactly once. Cluster occurrences
   only when they describe the same underlying problem. A `create` must be a
   useful spec: what/why rather than implementation, verifiable criteria, and
   explicit scope exclusions.

   You may instead use a known prior proposal from `.ab/ledger.json`:

   ```json
   {"action":"join","ticket":{"source":"...","id":"..."},"reason":"...","observations":[...]}
   {"action":"suppress","reason":"...","observations":[...]}
   ```

   Join only an existing unresolved ticket supplied by the ledger. Suppress a
   duplicate whose ledger ticket is resolved/missing, or a record that cannot
   support actionable work. Never invent a ticket reference.
3. Finish exactly once:

   ```sh
   ab harvest submit .ab/proposals.json
   ```

Do not call the TicketSource, edit tracker files, dispatch a build, push, or
infer state from your own stdout. If evidence is weak, preserve that limitation
in acceptance criteria rather than inventing facts.

# Integration node landing: capture parity evidence

This repository-local evidence accounts for the web-dashboard verification
failure on `integration-node-landing`, implement round 3. It does not change
visual criteria, exempt defects, or change the parity command's default base.
The verifier should still run the required default comparison and inspect the
images against DESIGN.md.

## Comparison boundaries

The default comparison uses merge base `24e53424` (PR #639). This build starts
at `2d17fb5e`, after PR #640 (leaf verify-entry/awaiting-landing restacks) and
PR #641 (descendant node restacks). Therefore the default comparison includes
both predecessor implementations and their fixture effects.

Reproduce the attribution with:

```sh
bun tools/capture-parity.ts
bun tools/capture-parity.ts --base 2d17fb5e
```

The default comparison finds 21 differing frames out of 55, with none missing
or extra. The build-start comparison finds exactly two: terminal and web
`integration-wide.png`. Thus all 19 ordinary-work frame differences below
already exist in the build's input and are byte-identical to that input.
They are not changes to ordinary-work presentation introduced by this ticket.

The two integration differences implement the spec's completeness/readiness
contract. Nodes without a completeness proof now say `integration incomplete`
instead of `integration requires human landing`. The former unconditional
human-only message contradicts the new verified, explicitly consented landing
path. No geometry or design-system change is intended.

## Every default-comparison difference

| Frame | Attribution and expected visible difference |
| --- | --- |
| terminal/integration-wide.png | This ticket: replace the unconditional human-landing reason with `integration incomplete`. |
| web/integration-wide.png | This ticket: the same shared integration reason. |
| terminal/mixed-narrow.png | Inherited merge waiting duration: `8m42s` → `8m28s`; byte-identical to build start. |
| terminal/mixed-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`; byte-identical to build start. |
| terminal/post-reconcile-policy.png | Inherited merge waiting duration: `8m42s` → `8m28s`; byte-identical to build start. |
| terminal/standby-list.png | Inherited merge waiting duration: `8m42s` → `8m28s`; byte-identical to build start. |
| web/builds-auto-merge-on-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-longrepo-narrow.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-abort-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-answer-narrow.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-answer-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-detail-narrow.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-detail-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-focus-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-hover-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-paused-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-rest-wide.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-mixed-selected-narrow.png | Inherited merge waiting duration: `8m42s` → `8m28s`. |
| web/builds-parked-no-consent-wide.png | Inherited pipeline provenance: `8aa6063` → `f8336c0`. |
| web/builds-post-reconcile-policy-narrow.png | Both inherited web timing and pipeline provenance changes above. |
| web/builds-post-reconcile-policy-wide.png | Both inherited web timing and pipeline provenance changes above. |

The text differences were also checked directly in the generated historical
and current terminal text and web HTML to identify their content; this supports attribution only,
not visual acceptance. Git timestamps were fixed to the parity driver's
`2026-07-15T12:00:00Z` for both trees. PR #640 added a real `target.moved`
observation to the happy-build seed and the required restack path changes the
scripted history. Commit identities and the wait's starting event consequently
differ. These are deterministic source-model facts, not clock jitter or a
font/layout change. The timing and short hashes here describe that fixed capture
environment; they are not product requirements or golden-image assertions.

All 43 web frames passed the failed verifier's visual checklist; its sole
failure was the unexplained parity list. Recheck pixels normally on retry.

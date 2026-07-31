# Changelog

## Unreleased

- [#142](https://github.com/defrex/autobuild/pull/142) — Delete the orphaned headline asset and check for new ones
- [#141](https://github.com/defrex/autobuild/pull/141) — Preserve every declared key in the plugin workspace config table
- [#140](https://github.com/defrex/autobuild/pull/140) — Re-sync this repo's vendored ab-guide and guard it against drift
- [#139](https://github.com/defrex/autobuild/pull/139) — Quiesce and restart a repository from a sessionless command
- [#138](https://github.com/defrex/autobuild/pull/138) — Hold the harvest reviewer to the persistence rule
- Add `[tickets].proposalState`, the state observation harvest files proposals into — the triage state by default, and the one supported way to waive the human grooming gate
- [#137](https://github.com/defrex/autobuild/pull/137) — Calibrate review severity against the spec, not against certainty
- [#136](https://github.com/defrex/autobuild/pull/136) — Narrow `persists` marking to a surviving disagreement
- [#135](https://github.com/defrex/autobuild/pull/135) — Route agent verify steps by step name, warn on unconsumed role keys
- [#134](https://github.com/defrex/autobuild/pull/134) — Replace the one-line resume field with a multi-line composer panel
- [#133](https://github.com/defrex/autobuild/pull/133) — Add pause-all and resume-all to the dispatch dashboard top row
- [#132](https://github.com/defrex/autobuild/pull/132) — Spell Autobuild as one word everywhere the repository controls
- [#131](https://github.com/defrex/autobuild/pull/131) — Show the Enter affordance in the list-view build legend

## v0.3.0 — 2026-07-30

This release broadens where Autobuild can run: a builtin Codex CLI agent runtime joins Claude, an offline local-git forge removes the hard dependency on a hosted provider, and ab init is now agent-driven and stack-neutral, with the default agent runtime required explicitly rather than silently falling back to Claude. The dispatch dashboard gains build drill-down, explicit pause and resume controls, documented pressure counters, and complete cleanup on abort. Reliability work contains janitor failures to a single build, recovers interrupted dispatches, limits setup retries while surfacing durable failures, explains why a merge is waiting, and permits safe local merges into dirty checkouts. Rounding it out, vendored skills are now self-contained, skill upgrades show cancellable progress, the default review-round limit rises from four to six, and managed dev-server support has been removed.

- [#130](https://github.com/defrex/autobuild/pull/130) — Raise the default review-round limit from four to six
- [#129](https://github.com/defrex/autobuild/pull/129) — Make dashboard pause and resume controls explicit
- [#128](https://github.com/defrex/autobuild/pull/128) — Make vendored skills self-contained
- [#127](https://github.com/defrex/autobuild/pull/127) — Add complete dashboard abort cleanup
- [#126](https://github.com/defrex/autobuild/pull/126) — Show cancellable progress during skill upgrades
- [#125](https://github.com/defrex/autobuild/pull/125) — Exercise Codex slug naming in integration
- [#124](https://github.com/defrex/autobuild/pull/124) — Document dispatch dashboard pressure counters
- [#123](https://github.com/defrex/autobuild/pull/123) — Synchronize installed plugin resolution guidance
- [#122](https://github.com/defrex/autobuild/pull/122) — Restore the explicit runtime changelog entry
- [#110](https://github.com/defrex/autobuild/pull/110) — Require an explicit default agent runtime instead of silently defaulting to Claude
- [#121](https://github.com/defrex/autobuild/pull/121) — Allow per-ticket creation state overrides
- [#120](https://github.com/defrex/autobuild/pull/120) — Support aliased skill directories during vendoring
- [#119](https://github.com/defrex/autobuild/pull/119) — Limit setup retries and surface durable failures
- [#118](https://github.com/defrex/autobuild/pull/118) — Show actionable merge wait reasons
- [#117](https://github.com/defrex/autobuild/pull/117) — Allow safe local merges into dirty checkouts
- [#116](https://github.com/defrex/autobuild/pull/116) — Contain janitor failures per build
- [#115](https://github.com/defrex/autobuild/pull/115) — Make `ab init` agent-driven and stack-neutral
- [#114](https://github.com/defrex/autobuild/pull/114) — Remove managed dev-server support
- [#113](https://github.com/defrex/autobuild/pull/113) — Recover interrupted dispatches and expose queued builds
- [#112](https://github.com/defrex/autobuild/pull/112) — Add an offline local-git forge
- [#111](https://github.com/defrex/autobuild/pull/111) — Add a builtin Codex CLI agent runtime
- [#109](https://github.com/defrex/autobuild/pull/109) — Add build drill-down to the dispatch dashboard

## v0.2.0 — 2026-07-27

This release opens Autobuild up to third-party extension, adding a plugin adapter SDK with diagnostics and contract certification alongside plugin-registered forge, ticket source, workspace provider, and agent runtime adapters, backed by a reusable AgentRunner contract suite and documentation for the remote BuildStore protocol and plugin authoring. Getting started is considerably smoother: `ab init` now walks through a guided interactive survey with adapter onboarding and emits a lean, explicit configuration, while CLI help is layered by audience and command. Day-to-day operation gains a maintainer release command, version reporting with self-update during upgrades, and a dispatch dashboard that shows capacity and observation pressure with clearer key bindings and better spacing. Reliability work rounds things out, covering auto-merge failures and deferral duplicates, detached workspace recovery from published branch heads, and tighter quality gates via Biome and the Claude Code CLI.

- [#108](https://github.com/defrex/autobuild/pull/108) — Inset the dispatch dashboard from terminal edges
- [#107](https://github.com/defrex/autobuild/pull/107) — Generate lean explicit init configuration
- [#106](https://github.com/defrex/autobuild/pull/106) — Report versions and self-update Autobuild during upgrades
- [#105](https://github.com/defrex/autobuild/pull/105) — Add a maintainer release command
- [#104](https://github.com/defrex/autobuild/pull/104) — Give ab init a guided interactive survey
- [#103](https://github.com/defrex/autobuild/pull/103) — Label harvest proposals and reconcile Linear labels
- [#102](https://github.com/defrex/autobuild/pull/102) — Show dispatch capacity and observation pressure
- [#101](https://github.com/defrex/autobuild/pull/101) — Resolve package plugins from the consuming repository
- [#100](https://github.com/defrex/autobuild/pull/100) — Prevent duplicate auto-merge deferral observations
- [#99](https://github.com/defrex/autobuild/pull/99) — Reject duplicate plugin declarations with actionable diagnostics
- [#98](https://github.com/defrex/autobuild/pull/98) — Correct Pi authentication guidance
- [#97](https://github.com/defrex/autobuild/pull/97) — Handle unavailable auto-merge without stranding builds
- [#96](https://github.com/defrex/autobuild/pull/96) — Clarify dashboard key bindings
- [#95](https://github.com/defrex/autobuild/pull/95) — Adopt Biome quality gates
- [#94](https://github.com/defrex/autobuild/pull/94) — Run Claude sessions through the Claude Code CLI
- [#93](https://github.com/defrex/autobuild/pull/93) — Add interactive adapter onboarding to `ab init`
- [#92](https://github.com/defrex/autobuild/pull/92) — Layer CLI help by audience and command
- [#91](https://github.com/defrex/autobuild/pull/91) — Add a plugin authoring guide
- [#90](https://github.com/defrex/autobuild/pull/90) — Open role routing to plugin agent runtimes
- [#89](https://github.com/defrex/autobuild/pull/89) — Add workspace provider selection
- [#88](https://github.com/defrex/autobuild/pull/88) — Enable plugin ticket sources
- [#87](https://github.com/defrex/autobuild/pull/87) — Add plugin diagnostics and contract certification
- [#86](https://github.com/defrex/autobuild/pull/86) — Select plugin-registered forge adapters
- [#85](https://github.com/defrex/autobuild/pull/85) — Add reusable AgentRunner contract suite
- [#84](https://github.com/defrex/autobuild/pull/84) — Document the remote BuildStore protocol
- [#83](https://github.com/defrex/autobuild/pull/83) — Add third-party plugin adapter SDK
- [#82](https://github.com/defrex/autobuild/pull/82) — Focus implementation review ranges on target divergence
- [#81](https://github.com/defrex/autobuild/pull/81) — Recover detached workspaces from published branch heads

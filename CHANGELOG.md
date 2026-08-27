# Changelog

## Unreleased

- [#228](https://github.com/defrex/autobuild/pull/228) — Restore the dashboard top/body separator
- [#227](https://github.com/defrex/autobuild/pull/227) — Show only failures and warnings on dispatcher dashboards
- [#226](https://github.com/defrex/autobuild/pull/226) — Use the operator's local pi install
- [#225](https://github.com/defrex/autobuild/pull/225) — Inherit repository identity for local Git landings
- [#224](https://github.com/defrex/autobuild/pull/224) — Remove durable progress from dashboard rows
- [#223](https://github.com/defrex/autobuild/pull/223) — Add per-build review round ceilings
- [#222](https://github.com/defrex/autobuild/pull/222) — Keep policy-blocked builds parked across dispatch restarts
- [#221](https://github.com/defrex/autobuild/pull/221) — Make phase-failure budget resets semantic
- [#220](https://github.com/defrex/autobuild/pull/220) — Make reclaimed-message reveal geometry explicit
- [#219](https://github.com/defrex/autobuild/pull/219) — Harden descendant fast-path timing coverage
- [#218](https://github.com/defrex/autobuild/pull/218) — Reclaim abandoned sessions when runners attach
- [#217](https://github.com/defrex/autobuild/pull/217) — Classify reconcile policy escalations by durable cause
- [#216](https://github.com/defrex/autobuild/pull/216) — Reap descendants after every build-child exit
- [#215](https://github.com/defrex/autobuild/pull/215) — Keep phase turns bounded after operator abort
- [#214](https://github.com/defrex/autobuild/pull/214) — Recover transcripts after terminal turn errors
- [#213](https://github.com/defrex/autobuild/pull/213) — Reap build descendant processes
- [#212](https://github.com/defrex/autobuild/pull/212) — Bound phase agent sessions with wall-clock budgets
- [#211](https://github.com/defrex/autobuild/pull/211) — Expose durable build progress in status surfaces
- [#209](https://github.com/defrex/autobuild/pull/209) — Scope phase-invoked read commands to ambient identity
- [#208](https://github.com/defrex/autobuild/pull/208) — Keep reconcile policy causes distinct
- [#207](https://github.com/defrex/autobuild/pull/207) — Add JSON output to ticket mutators
## v0.5.0 — 2026-08-04

This release moves build execution into supervised, isolated processes, separating the dispatch dashboard from kernel work so the frontend stays responsive under load while preserving observation pressure and handling shutdown, cleanup failures, and stale abort confirmations safely. Harvest and dispatch accounting were hardened as well: tickets are withheld while a Harvest is being created, counters survive tick publication failures, and dispatch accounting now reflects settled Harvest results. Reconcile budgets became progress-aware, local phase stores are scoped to the ambient session identity, and the README headline now leads with the happy path.

- [#206](https://github.com/defrex/autobuild/pull/206) — Isolate each build in a supervised process
- [#205](https://github.com/defrex/autobuild/pull/205) — Scope local phase stores to ambient session identity
- [#204](https://github.com/defrex/autobuild/pull/204) — Make reconcile budgets progress-aware
- [#203](https://github.com/defrex/autobuild/pull/203) — Withhold tickets during in-flight Harvest creation
- [#202](https://github.com/defrex/autobuild/pull/202) — Retain Harvest counters after tick publication failures
- [#201](https://github.com/defrex/autobuild/pull/201) — Fail dispatch frontend on cleanup exit errors
- [#200](https://github.com/defrex/autobuild/pull/200) — Align dispatch accounting with settled Harvest results
- [#199](https://github.com/defrex/autobuild/pull/199) — Preserve observation pressure in the isolated frontend
- [#198](https://github.com/defrex/autobuild/pull/198) — Make dispatch shutdown child-safe
- [#197](https://github.com/defrex/autobuild/pull/197) — Reject stale abort confirmations in isolated dispatch frontend
- [#196](https://github.com/defrex/autobuild/pull/196) — Show the happy path in the README headline
- [#195](https://github.com/defrex/autobuild/pull/195) — Isolate the dispatch dashboard from kernel work

## v0.4.0 — 2026-08-03

- [#194](https://github.com/defrex/autobuild/pull/194) — Notify interactive dispatchers about available upgrades
- [#193](https://github.com/defrex/autobuild/pull/193) — Accept `ab update` as an alias for `ab upgrade`
- [#192](https://github.com/defrex/autobuild/pull/192) — Pin live-config rejection episode resets
- [#191](https://github.com/defrex/autobuild/pull/191) — Honor stop controls before workspace setup
- [#190](https://github.com/defrex/autobuild/pull/190) — Restore split indexes after failed upgrade commits
- [#189](https://github.com/defrex/autobuild/pull/189) — Retain live config across source-file deletion
- [#188](https://github.com/defrex/autobuild/pull/188) — Simplify dashboard observation reporting
- [#187](https://github.com/defrex/autobuild/pull/187) — Suppress unsafe cross-version upgrade commits
- [#186](https://github.com/defrex/autobuild/pull/186) — Preserve foreign discovery symlinks during skill retirement
- [#185](https://github.com/defrex/autobuild/pull/185) — Restore index after failed upgrade commits
- [#184](https://github.com/defrex/autobuild/pull/184) — Report accurate recovery for merged or closed PRs
- [#183](https://github.com/defrex/autobuild/pull/183) — Point bounce guidance at the installed spec standard
- [#182](https://github.com/defrex/autobuild/pull/182) — Make `ab upgrade` commit its owned changes
- [#181](https://github.com/defrex/autobuild/pull/181) — Deduplicate policy exhaustion by source and target
- [#180](https://github.com/defrex/autobuild/pull/180) — Hot-reload dispatcher configuration
- [#179](https://github.com/defrex/autobuild/pull/179) — Align dashboard Unicode geometry contracts
- [#178](https://github.com/defrex/autobuild/pull/178) — Correct plugin resolution root guidance
- [#177](https://github.com/defrex/autobuild/pull/177) — Add provider alternates for agent roles
- [#176](https://github.com/defrex/autobuild/pull/176) — Guard runtime registry lookups against inherited properties
- [#175](https://github.com/defrex/autobuild/pull/175) — Make retired-skill reports match discovery state
- [#174](https://github.com/defrex/autobuild/pull/174) — Trigger observation harvest on repository drift
- [#173](https://github.com/defrex/autobuild/pull/173) — Render dashboard Unicode by terminal cells
- [#172](https://github.com/defrex/autobuild/pull/172) — Hold every vendored skill mirror to its canonical form
- [#171](https://github.com/defrex/autobuild/pull/171) — Clamp dashboard detail scrolling to resume panels
- [#170](https://github.com/defrex/autobuild/pull/170) — Reveal newly raised dashboard feedback in detail views
- [#168](https://github.com/defrex/autobuild/pull/168) — Block harvest proposals on unresolved origin tickets
- [#167](https://github.com/defrex/autobuild/pull/167) — Keep terminal dashboard status dominant
- [#166](https://github.com/defrex/autobuild/pull/166) — Use dashboard content width for transcript scrolling
- [#165](https://github.com/defrex/autobuild/pull/165) — Correct the dashboard warning preview comment
- [#164](https://github.com/defrex/autobuild/pull/164) — Show repository pauses in the dispatch dashboard
- [#163](https://github.com/defrex/autobuild/pull/163) — Add sessionless repository settings status
- [#162](https://github.com/defrex/autobuild/pull/162) — Preview long dashboard messages
- [#161](https://github.com/defrex/autobuild/pull/161) — Prevent superseded guidance from replaying
- [#160](https://github.com/defrex/autobuild/pull/160) — Restore dashboard terminal modes after abnormal exits
- [#159](https://github.com/defrex/autobuild/pull/159) — Keep escalation guidance durable until session launch
- [#158](https://github.com/defrex/autobuild/pull/158) — Make pending abort intent dominate bulk pause
- [#157](https://github.com/defrex/autobuild/pull/157) — Carry harvest prerequisites into ticket dependencies
- [#156](https://github.com/defrex/autobuild/pull/156) — Show abort progress through dashboard cleanup
- [#155](https://github.com/defrex/autobuild/pull/155) — Add operator paths for escalation resolutions
- [#154](https://github.com/defrex/autobuild/pull/154) — Preserve union detail in validation renderers
- [#153](https://github.com/defrex/autobuild/pull/153) — Teach dashboard verification to consume escalation guidance
- [#152](https://github.com/defrex/autobuild/pull/152) — Document workspace config as an open map
- [#151](https://github.com/defrex/autobuild/pull/151) — Route verifier escalation guidance back to its step
- [#150](https://github.com/defrex/autobuild/pull/150) — Document human guidance delivery to receiving phases
- [#149](https://github.com/defrex/autobuild/pull/149) — Generate the README headline from dashboard capture
- [#148](https://github.com/defrex/autobuild/pull/148) — Negotiate Kitty keyboard input for the dashboard
- [#147](https://github.com/defrex/autobuild/pull/147) — Route read-only build queries through the store seam
- [#146](https://github.com/defrex/autobuild/pull/146) — Give plan reviewers a concrete finding bar
- [#145](https://github.com/defrex/autobuild/pull/145) — Stop the open-map entry boundary from narrowing what validation said
- [#144](https://github.com/defrex/autobuild/pull/144) — Preserve every adapter name a plugin manifest declares
- [#143](https://github.com/defrex/autobuild/pull/143) — Hold queued builds while the repository is paused
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

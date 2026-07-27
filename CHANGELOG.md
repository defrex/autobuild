# Changelog

## Unreleased

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

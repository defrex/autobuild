---
title: Glossary
group: reference
order: 19
description: "Definitions for tickets, integration, execution boundaries, and agent roles."
---

# Glossary

## Build

One execution of a claimed ticket: an immutable slug and a durable event stream. Work builds run the [fixed pipeline](builds.md); node builds collect, verify and merge contributions.

## Ticket

A tracked unit of proposed work or a finite integration point, dispatchable once it passes readiness and dependency gates. See [Tickets](tickets.md).

## Spec

The build's contract: intent, rationale, acceptance criteria, scope limits and evidence, set by grooming under the [spec standard](tickets.md#groom-a-buildable-spec).

## Node

A finite integration build that collects child contributions, verifies its exact head against its parent and merges into it. Nodes nest and close when complete. See [integration trees](integration-overview.md).

## Target

Where a ticket's work merges: a node ticket, or the configured root when omitted. Blockers, not targets, decide when work starts.

## Seam

A narrow interface between the kernel and infrastructure: ticket sources, stores, runtimes. See [Seams](seams.md).

## Adapter

A seam implementation for one provider or environment. The kernel keeps lifecycle decisions.

## Verifier

A deterministic check or evidence-judging agent that tests a build against its contract and reports a typed outcome. Code decides what happens next.

## Escalation

A durable question or failure that parks work until answered with guidance or a retry through the [answer interface](operating.md#answer-and-pause).

## Merge

Guarded integration of a ready contribution into its destination, authorized by [merge policy](integration-overview.md#policy-authorizes-merge) and still subject to verification and forge gates.

## Restack

Kernel-owned replay of a leaf's net change, or a node's ordered contributions, onto a refreshed destination. A clean replay needs no agent. See [restacking](integration-overview.md#one-identity-per-leaf-change).

## Reconcile

The agent phase that resolves conflicts in a kernel-prepared replay against a frozen, refreshed base. The kernel then publishes and re-verifies.

## Operator agent

Your external agent, working outside the pipeline through the CLI or connected tools. It writes specs, files and grooms tickets, operates the builds the repository's dispatcher dispatches, answers escalations and manages authorized merge; you supply intent and authority.

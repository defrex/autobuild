---
title: Glossary
group: reference
order: 19
description: "Definitions for tickets, integration, execution boundaries, and agent roles."
---

# Glossary

## Build

One execution of a claimed ticket, named by an immutable slug and recorded as a durable event stream. Work builds run the [fixed pipeline](builds.md); node builds collect, verify and land contributions.

## Ticket

A tracked unit of proposed work or a finite integration point. It becomes dispatchable once it passes readiness and dependency gates; see [Tickets](tickets.md).

## Spec

The build's contract: intent, rationale, acceptance criteria, scope limits and evidence. Grooming establishes it before dispatch under the [spec standard](tickets.md#groom-a-buildable-spec).

## Node

A finite integration build that collects child contributions, verifies its exact head against its parent, and lands into that parent. Nodes nest and close when complete; see [integration trees](integration-overview.md).

## Target

Where a ticket's work lands: a node ticket, or the configured root when omitted. Blockers, not targets, decide when work can start.

## Seam

A narrow interface between the kernel and infrastructure such as ticket sources, stores or runtimes. See [Seams](seams.md).

## Adapter

A seam implementation for one provider or environment. It supplies infrastructure behavior; the kernel keeps lifecycle decisions.

## Verifier

A deterministic check or evidence-judging agent that tests a build against its contract. It reports a typed outcome; code owns what happens next.

## Escalation

A durable question or failure that parks work until someone answers it. Your operator agent records guidance or a retry through the [answer interface](operating.md#answer-and-pause).

## Landing

Guarded integration of a ready contribution into its destination. [Landing policy](integration-overview.md#policy-authorizes-landing) authorizes it; verification and forge gates still apply.

## Restack

Kernel-owned replay of a leaf's net change, or a node's ordered contributions, onto a refreshed destination. A clean replay needs no agent; see [restacking](integration-overview.md#one-identity-per-leaf-change).

## Reconcile

The agent phase that resolves conflicts in a kernel-prepared replay against a frozen, refreshed base. The kernel then publishes the result and runs required verification.

## Operator agent

Your external agent: it writes specs, files and grooms tickets, watches the dispatcher, answers escalations and manages authorized landing. It works outside the pipeline through the CLI or connected tools; you supply intent and authority.
